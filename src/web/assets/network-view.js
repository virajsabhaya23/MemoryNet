// Pure helpers for the network view: semantic zoom, bundled connections, ring shapes, label
// placement, paths, the timeline, and view state in the address. No DOM, so tests call them directly.

export const MODES = Object.freeze(["network", "timeline", "trace", "table"]);
export const DEPTHS = Object.freeze([1, 2, 99]);
export const MIN_ZOOM = 0.06;
export const MAX_ZOOM = 4;
export const MAX_PINS = 3;
export const MAX_SAVED_VIEWS = 20;

/** "from" relies on "to" for these connections. Ownership is accountability, not reliance. */
export const RELIES_ON = Object.freeze([
  "uses",
  "follows",
  "hands_off_to",
  "based_on",
  "runs_as",
  "cites",
]);

export const SECURITY_FLAGS = Object.freeze([
  "secret_removed",
  "personal_data",
]);
export const SHADES = Object.freeze([
  "none",
  "items",
  "pending",
  "incidents",
  "recent",
]);

function childrenOf(clusters) {
  const children = new Map(clusters.map((cluster) => [cluster.id, []]));
  const roots = [];
  for (const cluster of clusters) {
    if (cluster.parentId !== null && children.has(cluster.parentId)) {
      children.get(cluster.parentId).push(cluster.id);
    } else {
      roots.push(cluster.id);
    }
  }
  return { children, roots };
}

/** The group and every group inside it. */
export function groupAndInside(clusters, id) {
  const { children } = childrenOf(clusters);
  const all = new Set([id]);
  const queue = [id];
  while (queue.length > 0) {
    for (const kid of children.get(queue.shift()) ?? []) {
      if (all.has(kid)) continue;
      all.add(kid);
      queue.push(kid);
    }
  }
  return all;
}

/** From the organization down to the given group. */
export function groupPath(groupById, id) {
  const path = [];
  const seen = new Set();
  let at = groupById.get(id);
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    path.unshift(at);
    at = at.parentId === null ? undefined : groupById.get(at.parentId);
  }
  return path;
}

function fixed(value) {
  return Math.round(value * 10) / 10;
}

function polar(cx, cy, r, angle) {
  return `${fixed(cx + r * Math.cos(angle))},${fixed(cy + r * Math.sin(angle))}`;
}

/** An SVG path for a ring sector (or a full ring, or a disk when r0 is 0 and the sweep is full). */
export function sectorPath(cx, cy, r0, r1, a0, a1) {
  const sweep = a1 - a0;
  if (sweep >= Math.PI * 2 - 1e-6) {
    const outer = `M${polar(cx, cy, r1, a0)}A${fixed(r1)},${fixed(r1)} 0 1 1 ${polar(cx, cy, r1, a0 + Math.PI)}A${fixed(r1)},${fixed(r1)} 0 1 1 ${polar(cx, cy, r1, a0)}Z`;
    if (r0 <= 0) return outer;
    return `${outer}M${polar(cx, cy, r0, a0)}A${fixed(r0)},${fixed(r0)} 0 1 0 ${polar(cx, cy, r0, a0 + Math.PI)}A${fixed(r0)},${fixed(r0)} 0 1 0 ${polar(cx, cy, r0, a0)}Z`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  if (r0 <= 0) {
    return `M${fixed(cx)},${fixed(cy)}L${polar(cx, cy, r1, a0)}A${fixed(r1)},${fixed(r1)} 0 ${large} 1 ${polar(cx, cy, r1, a1)}Z`;
  }
  return `M${polar(cx, cy, r0, a0)}L${polar(cx, cy, r1, a0)}A${fixed(r1)},${fixed(r1)} 0 ${large} 1 ${polar(cx, cy, r1, a1)}L${polar(cx, cy, r0, a1)}A${fixed(r0)},${fixed(r0)} 0 ${large} 0 ${polar(cx, cy, r0, a0)}Z`;
}

const TIER_KINDS = Object.freeze({
  procedural: ["rule", "instruction", "skill", "agent"],
  semantic: ["memory"],
  episodic: ["source"],
  people: ["person", "agent_account"],
});

/**
 * The brain registry: how much the viewer can see of each kind of memory, what is approved and
 * current (what AI tools would be given once connected), and what needs a person.
 */
export function brainRegistry(nodes, clusters) {
  const tiers = {};
  for (const [tier, kinds] of Object.entries(TIER_KINDS)) {
    const ids = nodes
      .filter((node) => kinds.includes(node.kind))
      .map((node) => node.id);
    tiers[tier] = { count: ids.length, ids };
  }
  const ready = nodes
    .filter(
      (node) =>
        (TIER_KINDS.procedural.includes(node.kind) ||
          TIER_KINDS.semantic.includes(node.kind)) &&
        nodeStates(node).includes("current"),
    )
    .map((node) => node.id);
  return {
    tiers,
    ready: { count: ready.length, ids: ready },
    ...attentionItems(nodes, clusters),
  };
}

/**
 * Everything reachable from start along reliance connections, with its distance in steps.
 * "in" finds what relies on start (impact); "out" finds what start relies on.
 */
export function reach(
  edges,
  start,
  direction,
  maxDepth = Infinity,
  relations = RELIES_ON,
) {
  const allowed = new Set(relations);
  const next = new Map();
  for (const edge of edges) {
    if (!allowed.has(edge.relation)) continue;
    const from = direction === "in" ? edge.to : edge.from;
    const to = direction === "in" ? edge.from : edge.to;
    if (!next.has(from)) next.set(from, []);
    next.get(from).push(to);
  }
  const steps = new Map();
  let frontier = [start];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const following = [];
    for (const id of frontier) {
      for (const other of next.get(id) ?? []) {
        if (other === start || steps.has(other)) continue;
        steps.set(other, depth);
        following.push(other);
      }
    }
    frontier = following;
  }
  return steps;
}

/** Where something comes from: chains along "based on" and "cites", ending at the pull requests. */
export function provenancePaths(edges, start, limit = 24) {
  const out = new Map();
  for (const edge of edges) {
    if (edge.relation !== "based_on" && edge.relation !== "cites") continue;
    if (!out.has(edge.from)) out.set(edge.from, []);
    out.get(edge.from).push(edge.to);
  }
  const paths = [];
  const walk = (path) => {
    if (paths.length >= limit) return;
    const last = path[path.length - 1];
    const following = (out.get(last) ?? []).filter((id) => !path.includes(id));
    if (following.length === 0) {
      if (path.length > 1) paths.push(path);
      return;
    }
    for (const id of following) walk([...path, id]);
  };
  walk([start]);
  return paths;
}

/** The closest candidate in a direction, preferring ones straight ahead. */
export function nearestInDirection(from, candidates, direction) {
  const axis = {
    left: [-1, 0],
    right: [1, 0],
    up: [0, -1],
    down: [0, 1],
  }[direction];
  if (!axis) return null;
  let best = null;
  for (const candidate of candidates) {
    const dx = candidate.x - from.x;
    const dy = candidate.y - from.y;
    const along = dx * axis[0] + dy * axis[1];
    if (along <= 0.5) continue;
    const across = Math.abs(dx * axis[1] - dy * axis[0]);
    const score = along + across * 2;
    if (
      best === null ||
      score < best.score - 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && candidate.id < best.id)
    ) {
      best = { id: candidate.id, score };
    }
  }
  return best?.id ?? null;
}

/** Display states of a node, most important first. */
export function nodeStates(node) {
  const details = node.details ?? {};
  const states = [];
  if (node.status === "retired") states.push("retired");
  else if (node.status === "current" || node.status === "active") {
    states.push("current");
  }
  if ((details.pendingChanges ?? 0) > 0) states.push("pending");
  if (node.status !== "retired" && (details.warnings ?? []).length > 0) {
    states.push("warning");
  }
  if ((details.flags ?? []).some((flag) => SECURITY_FLAGS.includes(flag))) {
    states.push("flagged");
  }
  return states;
}

function isDay(text) {
  return typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text);
}

function validTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Dated events from the current versions only: memory and definition approvals (a retirement is an
 * approved version too) and captured evidence. Newest first.
 */
export function timelineEvents(nodes) {
  const events = [];
  for (const node of nodes) {
    const details = node.details ?? {};
    if (node.kind === "source") {
      if (!validTime(details.capturedAt)) continue;
      events.push({
        id: node.id,
        at: details.capturedAt,
        what: "captured",
        version: null,
        by:
          details.captureMethod === "github_app"
            ? "the GitHub App"
            : (details.capturedByName ?? null),
      });
    } else if (validTime(details.approvedAt)) {
      events.push({
        id: node.id,
        at: details.approvedAt,
        what: node.status === "retired" ? "retired" : "approved",
        version: details.revision ?? null,
        by: details.approvedByName ?? null,
      });
    }
  }
  return events.sort(
    (a, b) =>
      Date.parse(b.at) - Date.parse(a.at) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function inDayRange(event, from, to) {
  const day = event.at.slice(0, 10);
  return (!isDay(from) || day >= from) && (!isDay(to) || day <= to);
}

export function eventsByDay(events) {
  const days = [];
  for (const event of events) {
    const day = event.at.slice(0, 10);
    const last = days[days.length - 1];
    if (last && last.day === day) last.events.push(event);
    else days.push({ day, events: [event] });
  }
  return days;
}

/** Counts per group, including the groups inside it, for shading and summaries. */
export function groupMeasures(clusters, nodes, now, recentDays = 30) {
  const parentOf = new Map(
    clusters.map((cluster) => [cluster.id, cluster.parentId]),
  );
  const measures = new Map(
    clusters.map((cluster) => [
      cluster.id,
      {
        items: 0,
        pending: cluster.pendingNewDefinitions ?? 0,
        incidents: 0,
        recent: 0,
        kinds: {},
      },
    ]),
  );
  for (const cluster of clusters) {
    const own = cluster.pendingNewDefinitions ?? 0;
    for (
      let at = cluster.parentId;
      own > 0 && at !== null;
      at = parentOf.get(at) ?? null
    ) {
      const measure = measures.get(at);
      if (!measure) break;
      measure.pending += own;
    }
  }
  const nowMs = Date.parse(now);
  const recentEvents = new Set(
    timelineEvents(nodes)
      .filter((event) => nowMs - Date.parse(event.at) <= recentDays * 86400000)
      .map((event) => event.id),
  );
  for (const node of nodes) {
    const details = node.details ?? {};
    for (
      let at = node.clusterId;
      at !== null && at !== undefined;
      at = parentOf.get(at) ?? null
    ) {
      const measure = measures.get(at);
      if (!measure) break;
      measure.items += 1;
      measure.kinds[node.kind] = (measure.kinds[node.kind] ?? 0) + 1;
      measure.pending += details.pendingChanges ?? 0;
      if (node.kind === "memory" && details.type === "incident")
        measure.incidents += 1;
      if (recentEvents.has(node.id)) measure.recent += 1;
    }
  }
  return measures;
}

/** 0 to 1 per group for the chosen shading, relative to the busiest group. */
export function shadeLevels(measures, shade) {
  const levels = new Map();
  if (!SHADES.includes(shade) || shade === "none") return levels;
  let max = 0;
  for (const measure of measures.values())
    max = Math.max(max, measure[shade] ?? 0);
  for (const [id, measure] of measures) {
    levels.set(id, max === 0 ? 0 : (measure[shade] ?? 0) / max);
  }
  return levels;
}

/** What needs someone's attention, instead of raw totals. */
export function attentionItems(nodes, clusters) {
  const pendingIds = [];
  let pending = 0;
  const warnings = [];
  const flagged = [];
  const retired = [];
  for (const node of nodes) {
    const count = node.details?.pendingChanges ?? 0;
    if (count > 0) {
      pending += count;
      pendingIds.push(node.id);
    }
    const states = nodeStates(node);
    if (states.includes("warning")) warnings.push(node.id);
    if (states.includes("flagged")) flagged.push(node.id);
    if (states.includes("retired")) retired.push(node.id);
  }
  const newDefinitions = clusters.reduce(
    (sum, cluster) => sum + (cluster.pendingNewDefinitions ?? 0),
    0,
  );
  return {
    pending: {
      count: pending + newDefinitions,
      ids: pendingIds,
      newDefinitions,
    },
    warnings: { count: warnings.length, ids: warnings },
    flagged: { count: flagged.length, ids: flagged },
    retired: { count: retired.length, ids: retired },
  };
}

/** Ranks things for the search box: names that start with the words first, then any match. */
export function searchItems(query, items, limit = 8) {
  const text = query.trim().toLowerCase();
  if (text === "") return [];
  const words = text.split(/\s+/);
  const scored = [];
  for (const item of items) {
    const label = item.label.toLowerCase();
    const haystack = `${label} ${(item.keywords ?? "").toLowerCase()}`;
    if (!words.every((word) => haystack.includes(word))) continue;
    let score = 3;
    if (label === text) score = -1;
    else if (label.startsWith(text)) score = 0;
    else if (label.split(/\s+/).some((word) => word.startsWith(words[0])))
      score = 1;
    else if (label.includes(text)) score = 2;
    scored.push({ item, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      (a.item.rank ?? 0) - (b.item.rank ?? 0) ||
      a.item.label.localeCompare(b.item.label),
  );
  return scored.slice(0, limit).map((entry) => entry.item);
}

function list(value) {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** The view as address parameters, so a link opens the same view for anyone allowed to see it. */
export function encodeViewState(state) {
  const query = new URLSearchParams();
  if (state.mode && state.mode !== "network") query.set("mode", state.mode);
  if (state.node) query.set("node", state.node);
  else if (state.focus) query.set("focus", state.focus);
  if (state.isolate) query.set("isolate", String(state.depth ?? 1));
  if (state.impact) query.set("impact", "1");
  if (state.hideKinds?.length)
    query.set("hide", [...state.hideKinds].sort().join(","));
  if (state.hideRelations?.length)
    query.set("rel", [...state.hideRelations].sort().join(","));
  if (state.retired) query.set("retired", "1");
  if (state.people) query.set("people", "1");
  if (state.pins?.length) query.set("pins", state.pins.join(","));
  if (state.camera) {
    const { x, y, k } = state.camera;
    query.set("cam", `${Math.round(x)},${Math.round(y)},${k.toFixed(3)}`);
  }
  if (isDay(state.from)) query.set("from", state.from);
  if (isDay(state.to)) query.set("to", state.to);
  return query.toString();
}

/** Reads a view from address parameters, keeping only things this person can see. */
export function decodeViewState(search, known) {
  const query = new URLSearchParams(search);
  const state = {
    mode: "network",
    node: null,
    focus: null,
    isolate: false,
    depth: 1,
    impact: false,
    hideKinds: [],
    hideRelations: [],
    retired: false,
    people: false,
    pins: [],
    camera: null,
    from: null,
    to: null,
  };
  const mode = query.get("mode");
  if (MODES.includes(mode)) state.mode = mode;
  const node = query.get("node");
  if (node && known.nodes.has(node)) state.node = node;
  const focus = query.get("focus");
  if (!state.node && focus && known.clusters.has(focus)) state.focus = focus;
  const isolate = Number(query.get("isolate"));
  if (DEPTHS.includes(isolate)) {
    state.isolate = true;
    state.depth = isolate;
  }
  state.impact = query.get("impact") === "1";
  state.hideKinds = [...new Set(list(query.get("hide")))].filter((kind) =>
    known.kinds.has(kind),
  );
  state.hideRelations = [...new Set(list(query.get("rel")))].filter(
    (relation) => known.relations.has(relation),
  );
  state.retired = query.get("retired") === "1";
  state.people = query.get("people") === "1";
  state.pins = [...new Set(list(query.get("pins")))]
    .filter((id) => known.nodes.has(id))
    .slice(0, MAX_PINS);
  const camera = (query.get("cam") ?? "").split(",").map(Number);
  if (
    camera.length === 3 &&
    camera.every(Number.isFinite) &&
    camera[2] >= MIN_ZOOM &&
    camera[2] <= MAX_ZOOM
  ) {
    state.camera = { x: camera[0], y: camera[1], k: camera[2] };
  }
  const from = query.get("from");
  const to = query.get("to");
  if (isDay(from)) state.from = from;
  if (isDay(to)) state.to = to;
  return state;
}

/** Saved views from browser storage, keeping only well-formed entries. */
export function parseSavedViews(text) {
  let value;
  try {
    value = JSON.parse(text ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (view) =>
        view !== null &&
        typeof view === "object" &&
        typeof view.name === "string" &&
        typeof view.query === "string" &&
        view.name.trim() !== "" &&
        view.name.length <= 60 &&
        view.query.length <= 4000,
    )
    .slice(0, MAX_SAVED_VIEWS)
    .map((view) => ({
      name: view.name.trim(),
      query: view.query,
      savedAt: typeof view.savedAt === "string" ? view.savedAt : null,
    }));
}

/** Adds or replaces a saved view by name, newest first. */
export function withSavedView(views, name, query, savedAt) {
  const clean = name.trim().slice(0, 60);
  if (clean === "") return views;
  return [
    { name: clean, query, savedAt },
    ...views.filter((view) => view.name !== clean),
  ].slice(0, MAX_SAVED_VIEWS);
}
