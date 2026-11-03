// Interactive brain map. It draws only the data block the server embedded in the page, which
// already holds nothing but what the signed-in person may see. It fetches nothing and runs no data.
// The map itself is a canvas drawn by graph-engine.js: a force-directed network where every
// organization, business unit, and project is a hub its knowledge gathers around.
import { ICON_GLYPHS } from "./icons.js";
import { createGraphView } from "./graph-engine.js";
import {
  brainRegistry,
  decodeViewState,
  encodeViewState,
  eventsByDay,
  groupAndInside,
  groupMeasures,
  groupPath,
  inDayRange,
  MAX_PINS,
  MODES,
  nearestInDirection,
  nodeStates,
  parseSavedViews,
  provenancePaths,
  reach,
  RELIES_ON,
  searchItems,
  sectorPath,
  shadeLevels,
  timelineEvents,
  withSavedView,
} from "./network-view.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_MAX = 28;
const EDGE_BUDGET = 240;
const TABLE_PAGE = 250;
/** Connections that carry moving light when nothing is selected, so the map feels alive. */
const AMBIENT_LIMIT = 160;
const TIER_TEXT = {
  macro: "Overview",
  meso: "Groups and items",
  micro: "Full detail",
};

/** Colours by kind, and by memory type for memories. Darker variants for the light theme. */
const PALETTE = {
  dark: {
    organization: "#c6d6ee",
    business_unit: "#acb7e7",
    project: "#90b6ff",
    rule: "#acb7e7",
    instruction: "#b2bfdc",
    skill: "#dbc186",
    agent: "#9bbcdf",
    memory: "#90b6ff",
    source: "#8dbbff",
    person: "#acbfd9",
    agent_account: "#7fd1ff",
    decision: "#90b6ff",
    rationale: "#56b6ff",
    constraint: "#ff8a65",
    lesson: "#b7f15a",
    failed_approach: "#ffc145",
    incident: "#ff5d73",
  },
  light: {
    organization: "#536c8e",
    business_unit: "#5968a8",
    project: "#215dc6",
    rule: "#5968a8",
    instruction: "#536c8e",
    skill: "#896518",
    agent: "#3d6a98",
    memory: "#215dc6",
    source: "#21766d",
    person: "#536c8e",
    agent_account: "#1f86b8",
    decision: "#215dc6",
    rationale: "#1f74c9",
    constraint: "#d1522b",
    lesson: "#5d9a12",
    failed_approach: "#c98a00",
    incident: "#d0283f",
  },
};
const BADGE = { pending: "#dbc186", flagged: "#ff5fa2", warning: "#ff6b6b" };
const HUB_RADIUS = { organization: 17, business_unit: 12.5, project: 9.5 };
const NODE_RADIUS = {
  agent: 9,
  skill: 8,
  rule: 8,
  instruction: 7.5,
  memory: 5.6,
  source: 3.8,
  person: 6.5,
  agent_account: 6.5,
};
/** How far apart a connection holds its two ends, by what it means. */
const LINK_DISTANCE = {
  cites: 14,
  based_on: 34,
  uses: 46,
  follows: 54,
  hands_off_to: 52,
  runs_as: 30,
  owns: 60,
};

const TIER_ORDER = ["procedural", "semantic", "episodic", "people"];
const TIER_INFO = {
  procedural: {
    label: "How we work",
    detail: "rules, instructions, skills, and agents",
    icon: "rule",
  },
  semantic: {
    label: "What we know",
    detail: "approved memories",
    icon: "memory",
  },
  episodic: {
    label: "Evidence",
    detail: "pull requests behind the memories",
    icon: "source",
  },
  people: {
    label: "People",
    detail: "owners and agent accounts",
    icon: "person",
  },
};
const TIER_KINDS = {
  procedural: ["rule", "instruction", "skill", "agent"],
  semantic: ["memory"],
  episodic: ["source"],
  people: ["person", "agent_account"],
};
const PEOPLE_KINDS = new Set(TIER_KINDS.people);
const TIER_OF = Object.fromEntries(
  Object.entries(TIER_KINDS).flatMap(([tier, kinds]) =>
    kinds.map((kind) => [kind, tier]),
  ),
);

/** Which kind of memory a node is: how we work, what we know, evidence, or people. */
function tierOf(kind) {
  return TIER_OF[kind] ?? "semantic";
}

const OUTGOING = {
  uses: "Uses",
  follows: "Follows",
  hands_off_to: "Hands off to",
  based_on: "Based on",
  runs_as: "Runs as",
  cites: "Cites as evidence",
  owns: "Owns",
};
const INCOMING = {
  uses: "Used by",
  follows: "Followed by",
  hands_off_to: "Gets work from",
  based_on: "Guidance based on it",
  runs_as: "Agents running as this account",
  cites: "Cited by",
  owns: "Owned by",
};
const DEFINITION_KINDS = new Set(["agent", "skill", "instruction", "rule"]);
const DEPTH_WORDS = [
  "",
  "Directly",
  "Two steps away",
  "Three or more steps away",
];

// Small drawings -------------------------------------------------------------------------------

function element(tag, attributes = {}, text) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null && value !== false) {
      node.setAttribute(name, value === true ? "" : String(value));
    }
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null)
      node.setAttribute(name, String(value));
  }
  return node;
}

function shortLabel(text) {
  return text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1)}…`;
}

function formatDate(value) {
  return `${String(value).slice(0, 16).replace("T", " ")} UTC`;
}

function day(value) {
  return String(value).slice(0, 10);
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** White signs drawn on each node's disc, in a box from -10 to 10. The sign names the kind. */
const GLYPHS = ICON_GLYPHS;

/** Memory types get their own sign, so a decision and an incident differ at a glance. */
const MEMORY_GLYPHS = {
  decision: { stroke: "M-5.4.4-1.7 4.1 5.4-3.8" },
  rationale: {
    stroke: "M-3.3-3.2A3.5 3.5 0 1 1 1.7-.2C.6.4 0 1 0 2.2M0 5.6V5.8",
  },
  constraint: {
    stroke: "M-4.8-.4H4.8V6.2H-4.8ZM-2.9-.4V-2.8A2.9 2.9 0 0 1 2.9-2.8V-.4",
  },
  lesson: {
    stroke: "M0-6V7M0-6C-3-8-6-8-8-7V5C-5 4-2 5 0 7M0-6C3-8 6-8 8-7V5C5 4 2 5 0 7",
  },
  failed_approach: { stroke: "M-4.6-4.6 4.6 4.6M4.6-4.6-4.6 4.6" },
  incident: { stroke: "M0-5.8V1.4M0 5.2V5.4" },
};

function glyphShape(kind, memoryType) {
  if (kind === "memory" && memoryType && MEMORY_GLYPHS[memoryType])
    return MEMORY_GLYPHS[memoryType];
  return GLYPHS[kind] ?? GLYPHS.memory;
}

function appendGlyph(holder, shape) {
  if (shape.fill)
    holder.append(svgElement("path", { d: shape.fill, class: "fill" }));
  if (shape.stroke)
    holder.append(svgElement("path", { d: shape.stroke, class: "line" }));
  for (const [cx, cy] of shape.dots ?? []) {
    holder.append(svgElement("circle", { cx, cy, r: 1.9, class: "line" }));
  }
  if (shape.ring) {
    holder.append(
      svgElement("circle", {
        cx: shape.ring[0],
        cy: shape.ring[1],
        r: shape.ring[2],
        class: "line",
      }),
    );
  }
}

/** The same disc and sign as on the map, for lists, the legend, and search. */
function icon(kind, memoryType) {
  const svg = svgElement("svg", {
    viewBox: "-12 -12 24 24",
    width: 16,
    height: 16,
    class: "net-icon-svg",
    "aria-hidden": "true",
  });
  if (kind === "group") {
    svg.append(
      svgElement("path", {
        class: "net-icon-group",
        d: sectorPath(0, 0, 5.5, 11.5, -2.45, -0.7),
      }),
      svgElement("circle", { class: "net-icon-group core", r: 3.6 }),
    );
    return svg;
  }
  if (kind === "connection" || kind === "stream") {
    svg.append(
      svgElement("path", {
        class: "net-icon-line",
        d: "M-10 7C-3 7-3-7 9-7",
      }),
    );
    return svg;
  }
  const retired = kind === "retired";
  const holder = svgElement("g", {
    class: `net-icon-node tier-${retired ? "retired" : tierOf(kind)}`,
  });

  const sign = svgElement("g", {
    class: "net-glyph",
    transform: "scale(0.9)",
  });
  appendGlyph(sign, glyphShape(retired ? "rule" : kind, memoryType));
  holder.append(sign);
  svg.append(holder);
  return svg;
}

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse storage; the address still holds the view.
  }
}

// The view ----------------------------------------------------------------------------------

function start(data) {
  const app = document.getElementById("network");
  const svg = document.getElementById("net-canvas");
  const details = document.getElementById("net-details");
  if (!app || !svg || !details) return;
  const $ = (id) => document.getElementById(id);
  const status = $("net-status");
  const announcer = $("net-announce");
  const search = $("net-search");
  const results = $("net-search-results");
  const tooltip = $("net-tooltip");
  const minimapHolder = $("net-minimap");
  const where = $("net-where");
  const tierBadge = $("net-tier");
  const compare = $("net-compare");
  const dock = $("net-dock");

  const legend = data.legend;
  const clusters = data.clusters;
  const nodes = data.nodes;
  const edges = data.edges;
  // Visible before measuring, so the first fit uses the real canvas size.
  app.classList.add("ready");
  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const parentOf = new Map(
    clusters.map((cluster) => [cluster.id, cluster.parentId]),
  );
  const rootOf = new Map(
    clusters.map((cluster) => [
      cluster.id,
      groupPath(clusterById, cluster.id)[0]?.id ?? cluster.id,
    ]),
  );
  const edgesOf = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    edgesOf.get(edge.from)?.push(edge);
    edgesOf.get(edge.to)?.push(edge);
  }
  const statesOf = new Map(nodes.map((node) => [node.id, nodeStates(node)]));
  const measures = groupMeasures(clusters, nodes, data.generatedAt);
  const events = timelineEvents(nodes);
  const known = {
    nodes: new Set(nodeById.keys()),
    clusters: new Set(clusterById.keys()),
    kinds: new Set(Object.keys(legend.nodes)),
    relations: new Set(Object.keys(legend.relations)),
  };
  const storeKey = (what) =>
    `memorynet.${what}.${data.organization.id}.${data.viewer.id}`;
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const isPerson = (id) => PEOPLE_KINDS.has(nodeById.get(id)?.kind);
  const state = {
    mode: "network",
    hideKinds: new Set(),
    hideRelations: new Set(),
    retired: false,
    people: false,
    isolate: false,
    depth: 1,
    impact: false,
    pins: [],
    edgeMode: "auto",
    shade: "none",
    labels: true,
    flow: true,
    closed: new Set(),
    from: null,
    to: null,
  };
  let selected = null;
  let trace = null;
  let hovered = null;
  let visible = { nodes: new Set(), edges: new Set() };
  let drawnEdges = new Set();
  let lodKey = "";
  let lod = { top: new Set(), inside: new Set() };
  let userMoved = false;
  let navIndex = 0;
  let navMax = 0;
  let tableSort = { key: "label", dir: 1 };
  let tableLimit = TABLE_PAGE;

  document.querySelectorAll(".net-icon[data-icon]").forEach((holder) => {
    holder.replaceChildren(icon(holder.getAttribute("data-icon")));
  });

  // The map ----------------------------------------------------------------------------------
  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const themeName = () => {
    const chosen = document.documentElement.getAttribute("data-theme");
    if (chosen === "light" || chosen === "dark") return chosen;
    return themeMedia.matches ? "dark" : "light";
  };
  const engine = createGraphView(svg, {
    reduceMotion,
    theme: themeName(),
    font: getComputedStyle(document.body).fontFamily,
  });
  engine.setZoomLimits(0.03, 6);
  const view = engine.camera;

  function ownerOf(id) {
    const owns = (edgesOf.get(id) ?? []).find(
      (edge) => edge.relation === "owns" && edge.to === id,
    );
    return owns ? owns.from : null;
  }

  const depthOf = new Map(
    clusters.map((cluster) => [
      cluster.id,
      groupPath(clusterById, cluster.id).length - 1,
    ]),
  );
  const root = clusters.find((cluster) => cluster.parentId === null) ?? null;
  const hubIds = new Set(clusters.map((cluster) => cluster.id));
  const weightOf = new Map(clusters.map((cluster) => [cluster.id, 0]));
  for (const node of nodes) {
    for (const cluster of groupPath(clusterById, node.clusterId)) {
      weightOf.set(cluster.id, (weightOf.get(cluster.id) ?? 0) + 1);
    }
  }

  function colorOf(item, palette) {
    if (item.hub) return palette[item.kind] ?? palette.project;
    if (item.kind === "memory")
      return palette[item.memoryType] ?? palette.memory;
    return palette[item.kind] ?? palette.memory;
  }

  function badgeOf(node) {
    const d = node.details;
    const states = statesOf.get(node.id) ?? [];
    if ((d.warnings?.length ?? 0) > 0) return BADGE.warning;
    if (states.includes("flagged")) return BADGE.flagged;
    if ((d.pendingChanges ?? 0) > 0) return BADGE.pending;
    return null;
  }

  const degreeOf = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degreeOf.set(edge.from, (degreeOf.get(edge.from) ?? 0) + 1);
    degreeOf.set(edge.to, (degreeOf.get(edge.to) ?? 0) + 1);
  }

  const engineNodes = [
    ...clusters.map((cluster) => ({
      id: cluster.id,
      group: cluster.parentId,
      hub: true,
      kind: cluster.level,
      depth: depthOf.get(cluster.id) ?? 0,
      // A repository's owner is already the group it sits in, so its name is enough.
      label:
        cluster.level === "project" && cluster.name.includes("/")
          ? cluster.name.slice(cluster.name.lastIndexOf("/") + 1)
          : cluster.name,
      r:
        (HUB_RADIUS[cluster.level] ?? 9) +
        Math.min(Math.sqrt(weightOf.get(cluster.id) ?? 0) * 0.35, 9),
      weight: weightOf.get(cluster.id) ?? 0,
      color: "#888888",
    })),
    ...nodes.map((node) => {
      const degree = degreeOf.get(node.id) ?? 0;
      return {
        id: node.id,
        group: node.clusterId,
        hub: false,
        kind: node.kind,
        memoryType: node.kind === "memory" ? node.details.type : null,
        label: node.label,
        r: (NODE_RADIUS[node.kind] ?? 6) + Math.min(degree, 12) * 0.32,
        weight: degree,
        labelAt: DEFINITION_KINDS.has(node.kind) ? 5 : 8,
        glyph: glyphShape(node.kind, node.details.type),
        badge: badgeOf(node),
        retired: node.status === "retired",
        color: "#888888",
      };
    }),
  ];
  const engineNodeById = new Map(engineNodes.map((item) => [item.id, item]));
  function paint() {
    const palette = PALETTE[engine.theme];
    for (const item of engineNodes) item.color = colorOf(item, palette);
  }
  const relationLinks = edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    relation: edge.relation,
    distance: LINK_DISTANCE[edge.relation] ?? 40,
    strength: edge.relation === "owns" ? 0.08 : 0.7,
  }));
  const engineLinks = [
    ...clusters
      .filter((cluster) => cluster.parentId !== null)
      .map((cluster) => ({
        id: `hub:${cluster.id}`,
        source: cluster.id,
        target: cluster.parentId,
        structure: true,
        distance:
          70 + Math.sqrt(weightOf.get(cluster.id) ?? 0) * 9,
        strength: 0.5,
      })),
    ...nodes.map((node) => ({
      id: `in:${node.id}`,
      source: node.id,
      target: node.clusterId,
      structure: true,
      distance: 26 + (NODE_RADIUS[node.kind] ?? 6) * 2,
      strength: 0.16,
    })),
    ...relationLinks,
  ];
  // A quiet, stable sample of connections carries moving light when nothing is selected.
  const ambientStep = Math.max(1, Math.ceil(engineLinks.length / AMBIENT_LIMIT));
  const ambientLinks = engineLinks.filter(
    (link, index) => link.relation !== "owns" && index % ambientStep === 0,
  );
  paint();
  engine.resize();
  engine.setData({ nodes: engineNodes, links: engineLinks });
  const syncTheme = () => {
    engine.setTheme(themeName());
    paint();
    engine.redraw();
  };
  themeMedia.addEventListener("change", syncTheme);
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  // Kept for the parts of the page that ask where a node is drawn.
  const nodeElements = new Map();
  const nodePlace = (id) => engine.position(id);
  const hiddenGroupOf = () => null;
  const scheduleLabels = () => engine.redraw();

  function activeIds() {
    const ids = new Set(hubIds);
    for (const id of allowedNodes()) ids.add(id);
    return ids;
  }
  let activeKey = "";
  function useLayout() {
    const ids = activeIds();
    const key = `${ids.size}:${state.people}:${[...state.hideKinds].sort().join(",")}:${state.retired}`;
    if (key === activeKey) return false;
    activeKey = key;
    engine.setActive(ids);
    return true;
  }

  // Viewing --------------------------------------------------------------------------------------
  /** Room the floating panels cover, so framing centres things in the open part of the map. */
  function insets() {
    const size = engine.size;
    const out = { left: 0, right: 0, top: 0, bottom: 0 };
    if (size.width < 900) return out;
    const frameBox = svg.getBoundingClientRect();
    const inspector = $("net-inspector");
    if (inspector && !inspector.hidden && inspector.offsetWidth > 0) {
      const box = inspector.getBoundingClientRect();
      out.right = Math.max(0, frameBox.right - box.left);
    }
    const top = $("net-topbar");
    if (top) out.top = Math.max(0, top.getBoundingClientRect().bottom - frameBox.top);
    out.bottom = 36;
    return out;
  }

  function openCenter() {
    const size = engine.size;
    const room = insets();
    return {
      x: room.left + (size.width - room.left - room.right) / 2,
      y: room.top + (size.height - room.top - room.bottom) / 2,
    };
  }

  function applyView() {
    engine.redraw();
  }

  /** Never so far out that the map is only a speck. */
  function clampView(k) {
    return Math.max(0.03, Math.min(k, 6));
  }

  function animateTo(target) {
    engine.animateTo({ ...target, k: clampView(target.k) });
  }

  function box() {
    return svg.getBoundingClientRect();
  }

  function frame(x, y, r, animate = true, margin = 48) {
    const target = engine.frameTarget(x, y, r, margin, insets());
    if (animate) animateTo(target);
    else engine.jumpTo(target);
  }

  function frameIds(ids, animate = true, margin = 48) {
    const bounds = engine.bounds(ids);
    if (bounds) frame(bounds.x, bounds.y, bounds.r, animate, margin);
  }

  function shownIds() {
    return [...visible.nodes, ...hubIds];
  }

  function frameGroup(id, animate = true) {
    const inside = groupAndInside(clusters, id);
    const ids = [id];
    for (const nodeId of visible.nodes) {
      if (inside.has(nodeById.get(nodeId)?.clusterId)) ids.push(nodeId);
    }
    for (const cluster of inside) ids.push(cluster);
    frameIds(ids, animate, 56);
  }

  function fitAll(animate = true) {
    frameIds(shownIds(), animate, 40);
  }

  function zoomAt(factor, cx, cy) {
    engine.zoomAt(factor, cx, cy);
  }

  function zoomCenter(factor) {
    userMoved = true;
    const center = openCenter();
    zoomAt(factor, center.x, center.y);
  }

  function centerOn(x, y, minK = 1, animate = true) {
    userMoved = true;
    const center = openCenter();
    const k = clampView(Math.max(view.k, minK));
    const target = { k, x: center.x - x * k, y: center.y - y * k };
    if (animate) animateTo(target);
    else engine.jumpTo(target);
  }

  function zoomToSelection() {
    if (!selected) return fitAll();
    userMoved = true;
    if (selected.type === "cluster") return frameGroup(selected.id);
    const ids =
      selected.type === "node"
        ? [
            selected.id,
            ...(edgesOf.get(selected.id) ?? []).map((edge) =>
              edge.from === selected.id ? edge.to : edge.from,
            ),
          ]
        : selected.type === "edge"
          ? [edgeById.get(selected.id).from, edgeById.get(selected.id).to]
          : (selected.ids ?? []);
    frameIds(ids, true, 64);
  }

  function cameraState() {
    const center = openCenter();
    return {
      x: (center.x - view.x) / view.k,
      y: (center.y - view.y) / view.k,
      k: view.k,
    };
  }

  function cameraTarget(camera) {
    const center = openCenter();
    const k = clampView(camera.k);
    return { k, x: center.x - camera.x * k, y: center.y - camera.y * k };
  }

  // A small overview of the whole map, with the part on screen outlined.
  const minimap = minimapHolder ? document.createElement("canvas") : null;
  if (minimap && minimapHolder) {
    minimapHolder.append(minimap);
    minimapHolder.hidden = false;
    minimap.addEventListener("pointerdown", (event) => {
      const world = minimap.toWorld?.(event.offsetX, event.offsetY);
      if (world) centerOn(world.x, world.y, view.k);
    });
  }
  let minimapTimer = 0;
  function updateMinimap() {
    if (!minimap || minimapTimer) return;
    minimapTimer = window.setTimeout(() => {
      minimapTimer = 0;
      drawMinimap();
    }, 120);
  }
  function drawMinimap() {
    if (!minimap) return;
    const width = 168;
    const height = 112;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    minimap.width = width * ratio;
    minimap.height = height * ratio;
    minimap.style.width = `${width}px`;
    minimap.style.height = `${height}px`;
    const g = minimap.getContext("2d");
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);
    const bounds = engine.bounds(shownIds());
    if (!bounds) return;
    const scale = Math.min(width, height) / (bounds.r * 2.15);
    const ox = width / 2 - bounds.x * scale;
    const oy = height / 2 - bounds.y * scale;
    minimap.toWorld = (sx, sy) => ({ x: (sx - ox) / scale, y: (sy - oy) / scale });
    const shown = new Set(shownIds());
    engine.each((item, x, y) => {
      if (!shown.has(item.id)) return;
      g.fillStyle = item.color;
      g.globalAlpha = item.hub ? 0.95 : 0.55;
      const s = item.hub ? 2.2 : 1;
      g.fillRect(x * scale + ox - s / 2, y * scale + oy - s / 2, s, s);
    });
    g.globalAlpha = 1;
    const size = engine.size;
    const a = engine.toWorld(0, 0);
    const b = engine.toWorld(size.width, size.height);
    g.strokeStyle = engine.theme === "dark" ? "rgb(255 255 255 / 0.7)" : "rgb(0 0 0 / 0.6)";
    g.lineWidth = 1;
    g.strokeRect(a.x * scale + ox, a.y * scale + oy, (b.x - a.x) * scale, (b.y - a.y) * scale);
  }

  let lastCamera = "";
  engine.on("frame", () => {
    const key = `${view.x.toFixed(1)},${view.y.toFixed(1)},${view.k.toFixed(4)}`;
    if (key === lastCamera) return;
    lastCamera = key;
    updateMinimap();
    const tier = view.k < 0.35 ? "macro" : view.k < 1.1 ? "meso" : "micro";
    if (tierBadge) tierBadge.textContent = TIER_TEXT[tier];
    if (!selected) scheduleWhere();
    scheduleUrl();
  });
  engine.on("settle", () => {
    updateMinimap();
    if (!userMoved && !selected) fitAll(true);
  });

  let whereTimer = 0;
  function scheduleWhere() {
    clearTimeout(whereTimer);
    whereTimer = window.setTimeout(updateWhere, 90);
  }


  // Filtering, focus, and highlight ------------------------------------------------------------
  function neighborhood(startId, depth, usable) {
    const reached = new Set([startId]);
    let frontier = [startId];
    for (let step = 0; step < depth && frontier.length > 0; step += 1) {
      const next = [];
      for (const id of frontier) {
        for (const edge of edgesOf.get(id) ?? []) {
          if (!usable.has(edge.id)) continue;
          const other = edge.from === id ? edge.to : edge.from;
          if (!reached.has(other)) {
            reached.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    return reached;
  }

  function allowedNodes() {
    return new Set(
      nodes
        .filter(
          (node) =>
            !state.hideKinds.has(node.kind) &&
            (state.retired || node.status !== "retired") &&
            (state.people || !PEOPLE_KINDS.has(node.kind)),
        )
        .map((node) => node.id),
    );
  }

  function computeVisible() {
    const allowed = allowedNodes();
    const usable = new Set(
      edges
        .filter(
          (edge) =>
            !state.hideRelations.has(edge.relation) &&
            allowed.has(edge.from) &&
            allowed.has(edge.to),
        )
        .map((edge) => edge.id),
    );
    let shown = allowed;
    if (state.isolate && selected) {
      if (selected.type === "node" && allowed.has(selected.id)) {
        shown = neighborhood(selected.id, state.depth, usable);
      } else if (selected.type === "edge") {
        const edge = edgeById.get(selected.id);
        shown = new Set([edge.from, edge.to].filter((id) => allowed.has(id)));
      } else if (selected.type === "cluster") {
        const inside = groupAndInside(clusters, selected.id);
        shown = new Set(
          [...allowed].filter((id) => inside.has(nodeById.get(id).clusterId)),
        );
      } else if (selected.type === "list") {
        shown = new Set((selected.ids ?? []).filter((id) => allowed.has(id)));
      }
    }
    const shownEdges = new Set(
      [...usable].filter((id) => {
        const edge = edgeById.get(id);
        return shown.has(edge.from) && shown.has(edge.to);
      }),
    );
    return { nodes: shown, edges: shownEdges };
  }

  function effectiveEdgeMode(count) {
    if (state.edgeMode !== "auto") return state.edgeMode;
    return count > EDGE_BUDGET ? "bundled" : "all";
  }

  function impactMap() {
    if (!state.impact || selected?.type !== "node") return null;
    const usable = edges.filter((edge) => visible.edges.has(edge.id));
    return reach(usable, selected.id, "in");
  }

  let streams = [];
  function refresh() {
    visible = computeVisible();
    useLayout();
    const keep = new Set();
    if (selected?.type === "node") keep.add(selected.id);
    if (selected?.type === "edge") {
      const edge = edgeById.get(selected.id);
      keep.add(edge.from);
      keep.add(edge.to);
    }
    if (hovered) keep.add(hovered);
    for (const id of state.pins) keep.add(id);
    const mode = effectiveEdgeMode(visible.edges.size);
    if (mode === "selection") {
      drawnEdges = new Set(
        [...visible.edges].filter((id) => {
          const edge = edgeById.get(id);
          return keep.has(edge.from) || keep.has(edge.to);
        }),
      );
    } else {
      drawnEdges = new Set(visible.edges);
    }

    const impact = impactMap();
    let near = new Set();
    let active = new Set();
    let insideCluster = null;
    if (impact) {
      near = new Set([selected.id, ...impact.keys()]);
      for (const id of drawnEdges) {
        const edge = edgeById.get(id);
        if (
          RELIES_ON.includes(edge.relation) &&
          near.has(edge.from) &&
          near.has(edge.to)
        )
          active.add(id);
      }
    } else if (trace) {
      near = new Set(trace.nodes);
      active = new Set(trace.edges);
    } else if (selected?.type === "node") {
      near.add(selected.id);
      for (const edge of edgesOf.get(selected.id) ?? []) {
        if (!visible.edges.has(edge.id)) continue;
        active.add(edge.id);
        near.add(edge.from);
        near.add(edge.to);
      }
    } else if (selected?.type === "edge") {
      const edge = edgeById.get(selected.id);
      active.add(edge.id);
      near.add(edge.from);
      near.add(edge.to);
    } else if (selected?.type === "cluster") {
      insideCluster = groupAndInside(clusters, selected.id);
      for (const id of visible.nodes) {
        if (insideCluster.has(nodeById.get(id).clusterId)) near.add(id);
      }
      for (const id of insideCluster) near.add(id);
    } else if (selected?.type === "list" || selected?.type === "stream") {
      near = new Set(selected.ids ?? []);
      for (const id of selected.edges ?? []) active.add(id);
    } else if (hovered && visible.nodes.has(hovered)) {
      // Pointing at something previews its neighbourhood before any click.
      near.add(hovered);
      for (const edge of edgesOf.get(hovered) ?? []) {
        if (!drawnEdges.has(edge.id)) continue;
        active.add(edge.id);
        near.add(edge.from);
        near.add(edge.to);
      }
    }
    const highlighting =
      selected !== null || trace !== null || (hovered !== null && near.size > 0);
    // Hubs that hold something lit stay lit, so you can see where it sits.
    for (const id of [...near]) {
      const node = nodeById.get(id);
      if (!node) continue;
      for (const cluster of groupPath(clusterById, node.clusterId))
        near.add(cluster.id);
    }
    // The group links of lit nodes light up too, tracing the way to the core.
    const activeLinks = new Set(active);
    if (selected?.type === "node" || selected?.type === "cluster") {
      for (const id of near) {
        if (nodeById.has(id) && visible.nodes.has(id)) {
          if (selected.type === "cluster") activeLinks.add(`in:${id}`);
        } else if (clusterById.get(id)?.parentId) {
          activeLinks.add(`hub:${id}`);
        }
      }
    }

    let shownHubs = hubIds;
    if (state.isolate && selected) {
      shownHubs = new Set();
      for (const id of visible.nodes) {
        for (const cluster of groupPath(clusterById, nodeById.get(id).clusterId))
          shownHubs.add(cluster.id);
      }
      if (selected.type === "cluster") {
        for (const cluster of groupPath(clusterById, selected.id))
          shownHubs.add(cluster.id);
      }
    }
    const shown = new Set([...visible.nodes, ...shownHubs]);
    const impactDepth = new Map();
    if (impact) for (const [id, depth] of impact) impactDepth.set(id, depth);
    engine.setStyle({
      visible: shown,
      highlighting,
      near,
      activeEdges: activeLinks,
      drawEdges: drawnEdges,
      selected:
        selected?.type === "node"
          ? selected.id
          : selected?.type === "cluster"
            ? selected.id
            : null,
      hovered,
      pins: new Set(state.pins),
      impact: impactDepth,
      heat: shadeLevels(measures, state.shade),
      focusGroups: insideCluster ? new Set(insideCluster) : null,
      labels: state.labels,
      ambient: state.flow ? ambientLinks : null,
      flow: new Set(activeLinks),
    });
    updateStatus(mode);
    updateLegend();
    updateMinimap();
  }

  function updateStatus(mode) {
    if (!status) return;
    const filtered = nodes.length - visible.nodes.size;
    const parts = [
      `${plural(visible.nodes.size, "item", "items")}`,
      `${plural(drawnEdges.size, "connection", "connections")}`,
      `${plural(clusters.length, "group", "groups")}`,
    ];
    if (filtered > 0) parts.push(`${filtered} hidden by your choices`);
    if (mode === "selection")
      parts.push("connections shown only for the selection");
    status.textContent = parts.join(" · ");
  }

  // Legend -----------------------------------------------------------------------------------------
  /** A colour key under the memory kinds: one swatch per kind of thing drawn, with counts. */
  function renderKey() {
    const holder = $("net-key");
    if (!holder) return;
    const palette = PALETTE[engine.theme];
    const counts = new Map();
    for (const item of engineNodes) {
      const key = item.hub ? item.kind : item.kind === "memory" ? item.memoryType : item.kind;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const label = (key) =>
      legend.levels[key]?.label ??
      legend.memoryTypes[key]?.label ??
      legend.nodes[key]?.label ??
      key;
    holder.replaceChildren();
    for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      const li = element("li", { title: label(key) });
      const dot = element("span", { class: "net-key-dot", "aria-hidden": "true" });
      dot.style.setProperty("--dot", palette[key] ?? palette.memory);
      li.append(dot, element("span", {}, label(key)), element("small", {}, String(count)));
      holder.append(li);
    }
  }
  renderKey();
  themeMedia.addEventListener("change", renderKey);
  new MutationObserver(renderKey).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });


  function tierOn(tier) {
    if (tier === "people") return state.people;
    return TIER_KINDS[tier].some((kind) => !state.hideKinds.has(kind));
  }

  function updateLegend() {
    document.querySelectorAll("#net-legend [data-tier]").forEach((button) => {
      const tier = button.getAttribute("data-tier");
      button.setAttribute("aria-pressed", tierOn(tier) ? "true" : "false");
    });
  }

  function toggleTier(tier) {
    if (tier === "people") return setPeople(!state.people);
    const on = tierOn(tier);
    for (const kind of TIER_KINDS[tier]) {
      if (on) state.hideKinds.add(kind);
      else state.hideKinds.delete(kind);
    }
    syncControls();
    refresh();
    renderDetails();
    renderPanels();
    pushHistory(true);
  }

  function setPeople(on, { quiet = false } = {}) {
    if (state.people === on) return;
    state.people = on;
    if (on) for (const kind of PEOPLE_KINDS) state.hideKinds.delete(kind);
    useLayout();
    if (quiet) return;
    syncControls();
    refresh();
    renderDetails();
    renderPanels();
    saveWorkspace();
    pushHistory(true);
    // The map grows or shrinks with people; refit unless the camera was placed by hand.
    if (!userMoved) fitAll();
  }

  document.querySelectorAll("#net-legend [data-tier]").forEach((button) => {
    button.addEventListener("click", () =>
      toggleTier(button.getAttribute("data-tier")),
    );
  });

  // Where you are ---------------------------------------------------------------------------------
  function crumbButtons(holder, path, tail) {
    holder.replaceChildren();
    path.forEach((cluster, index) => {
      if (index > 0)
        holder.append(
          element("span", { class: "sep", "aria-hidden": "true" }, "/"),
        );
      const button = element("button", { type: "button" }, cluster.name);
      button.addEventListener("click", () =>
        select("cluster", cluster.id, { center: true }),
      );
      holder.append(button);
    });
    if (tail) {
      holder.append(
        element("span", { class: "sep", "aria-hidden": "true" }, "/"),
      );
      holder.append(element("span", {}, tail));
    }
  }

  function clusterAtCenter() {
    const center = cameraState();
    let best = root?.id ?? null;
    let bestDepth = -1;
    for (const cluster of clusters) {
      const shape = engine.groupShape(cluster.id) ?? engine.position(cluster.id);
      if (!shape) continue;
      const r = shape.r ?? 40;
      if (Math.hypot(center.x - shape.x, center.y - shape.y) > r) continue;
      const depth = depthOf.get(cluster.id) ?? 0;
      if (depth > bestDepth) {
        best = cluster.id;
        bestDepth = depth;
      }
    }
    return best;
  }

  function updateWhere() {
    if (!where) return;
    if (selected?.type === "node") {
      const node = nodeById.get(selected.id);
      crumbButtons(
        where,
        groupPath(clusterById, node.clusterId),
        shortLabel(node.label),
      );
    } else if (selected?.type === "cluster") {
      crumbButtons(where, groupPath(clusterById, selected.id));
    } else {
      const id = clusterAtCenter();
      crumbButtons(where, id ? groupPath(clusterById, id) : []);
    }
  }

  // Tooltip ---------------------------------------------------------------------------------------
  function showTooltip(event, title, lines) {
    if (!tooltip) return;
    tooltip.replaceChildren(element("strong", {}, title));
    const list = element("ul");
    for (const line of lines) list.append(element("li", {}, line));
    tooltip.append(list);
    const holder = svg.getBoundingClientRect();
    tooltip.hidden = false;
    const x = Math.min(
      event.clientX - holder.left + 14,
      holder.width - tooltip.offsetWidth - 8,
    );
    const y = Math.min(
      event.clientY - holder.top + 14,
      holder.height - tooltip.offsetHeight - 8,
    );
    tooltip.style.left = `${Math.max(8, x)}px`;
    tooltip.style.top = `${Math.max(8, y)}px`;
  }

  function hideTooltip() {
    if (tooltip) tooltip.hidden = true;
  }

  function clusterLines(id) {
    const cluster = clusterById.get(id);
    const measure = measures.get(id);
    const lines = [
      `${legend.levels[cluster.level].label} · your role: ${cluster.role ?? "none here"}`,
    ];
    const kinds = Object.entries(measure?.kinds ?? {})
      .map(
        ([kind, count]) => `${count} ${legend.nodes[kind].label.toLowerCase()}`,
      )
      .join(", ");
    lines.push(kinds === "" ? "Nothing you can see inside yet" : kinds);
    if ((measure?.pending ?? 0) > 0)
      lines.push(`${measure.pending} waiting for review`);
    if ((measure?.incidents ?? 0) > 0)
      lines.push(plural(measure.incidents, "incident", "incidents"));
    const inside = groupAndInside(clusters, id);
    const newest = events.find((event) =>
      inside.has(nodeById.get(event.id)?.clusterId),
    );
    if (newest) lines.push(`Latest change ${day(newest.at)}`);
    return lines;
  }

  // Selection --------------------------------------------------------------------------------------
  function reveal(id) {
    const node = nodeById.get(id);
    if (!node) return;
    if (PEOPLE_KINDS.has(node.kind) && !state.people) {
      setPeople(true, { quiet: true });
      saveWorkspace();
    }
    if (state.hideKinds.has(node.kind)) state.hideKinds.delete(node.kind);
    if (node.status === "retired" && !state.retired) state.retired = true;
    syncControls();
  }

  function select(type, id, options = {}) {
    const previous = selected;
    if (type === "list" || type === "stream") {
      selected = {
        type,
        id,
        ids: options.ids ?? [],
        edges: options.edges ?? [],
        title: options.title,
        note: options.note,
      };
    } else {
      selected = type && id ? { type, id } : null;
    }
    if (previous?.type !== selected?.type || previous?.id !== selected?.id) {
      trace = null;
      if (selected?.type !== "node") state.impact = false;
    }
    if (selected?.type === "node") reveal(selected.id);
    refresh();
    renderDetails();
    updateWhere();
    renderPanels();
    if (options.center && selected?.type === "node") {
      const place = nodePlace(selected.id);
      const collapsed = hiddenGroupOf(selected.id);
      if (collapsed) frameGroup(collapsed);
      else if (place) centerOn(place.x, place.y, Math.max(view.k, 0.9));
    }
    if (options.center && selected?.type === "cluster") {
      userMoved = true;
      frameGroup(selected.id);
    }
    announceSelection();
    if (options.history !== false) pushHistory(options.history === "replace");
  }

  function announceSelection() {
    if (!announcer) return;
    if (!selected) announcer.textContent = "Selection cleared.";
    else if (selected.type === "node") {
      const node = nodeById.get(selected.id);
      announcer.textContent = `Selected ${legend.nodes[node.kind].label}: ${node.label}.`;
    } else if (selected.type === "cluster") {
      announcer.textContent = `Selected group ${clusterById.get(selected.id).name}.`;
    } else if (selected.type === "edge") {
      announcer.textContent = "Selected a connection.";
    } else {
      announcer.textContent = selected.title ?? "Selected.";
    }
  }

  // Inspector ------------------------------------------------------------------------------------
  function section(title, ...children) {
    const wrap = element("div", { class: "net-section" });
    wrap.append(element("h3", {}, title), ...children);
    return wrap;
  }

  function paragraph(text, className) {
    return element("p", className ? { class: className } : {}, text);
  }

  function list(items, empty) {
    if (items.length === 0) return paragraph(empty, "empty");
    const ul = element("ul");
    for (const item of items) ul.append(element("li", {}, item));
    return ul;
  }

  function facts(pairs) {
    const dl = element("dl", { class: "facts" });
    for (const [term, value] of pairs) {
      if (value === null || value === undefined || value === "") continue;
      dl.append(element("dt", {}, term));
      const dd = element("dd");
      if (value instanceof Node) dd.append(value);
      else dd.textContent = String(value);
      dl.append(dd);
    }
    return dl;
  }

  function pageLink(href, text) {
    if (typeof href !== "string" || !href.startsWith("/")) return null;
    return element("a", { href }, text);
  }

  function nodeButton(id) {
    const node = nodeById.get(id);
    const button = element("button", { type: "button", class: "net-link" });
    if (!node) {
      button.textContent = "Unknown";
      return button;
    }
    button.append(
      icon(
        node.status === "retired" ? "retired" : node.kind,
        node.details.type,
      ),
      document.createTextNode(node.label),
    );
    if (!visible.nodes.has(id))
      button.append(
        element(
          "small",
          {},
          PEOPLE_KINDS.has(node.kind) && !state.people
            ? " (people are hidden on the map)"
            : " (hidden by your choices)",
        ),
      );
    button.addEventListener("click", () =>
      select("node", id, { center: true }),
    );
    return button;
  }

  function clusterButton(id) {
    const cluster = clusterById.get(id);
    const button = element("button", { type: "button", class: "net-link" });
    button.append(
      icon("group"),
      document.createTextNode(cluster?.name ?? "Unknown"),
    );
    button.addEventListener("click", () =>
      select("cluster", id, { center: true }),
    );
    return button;
  }

  function stateBadges(id) {
    const holder = element("p", { class: "net-tags" });
    for (const one of statesOf.get(id) ?? []) {
      holder.append(
        element(
          "span",
          {
            class: "badge badge-state",
            "data-state": one,
            title: legend.states[one].meaning,
          },
          legend.states[one].label,
        ),
      );
    }
    return holder;
  }

  function breadcrumbFor(clusterId) {
    const nav = element("nav", {
      class: "crumbs",
      "aria-label": "Where it sits",
    });
    groupPath(clusterById, clusterId).forEach((cluster, index) => {
      if (index > 0)
        nav.append(
          element("span", { class: "sep", "aria-hidden": "true" }, "/"),
        );
      const button = element("button", { type: "button" }, cluster.name);
      button.addEventListener("click", () =>
        select("cluster", cluster.id, { center: true }),
      );
      nav.append(button);
    });
    return nav;
  }

  function connections(id) {
    const wrap = element("div", { class: "net-connections" });
    const groups = new Map();
    for (const edge of edgesOf.get(id) ?? []) {
      const outgoing = edge.from === id;
      const key = `${outgoing ? "out" : "in"}:${edge.relation}`;
      if (!groups.has(key))
        groups.set(key, {
          title: (outgoing ? OUTGOING : INCOMING)[edge.relation],
          items: [],
        });
      groups
        .get(key)
        .items.push({ edge, other: outgoing ? edge.to : edge.from });
    }
    if (groups.size === 0) {
      wrap.append(paragraph("No connections you can see.", "empty"));
      return wrap;
    }
    const order = [
      ...Object.keys(OUTGOING)
        .filter((relation) => relation !== "owns")
        .map((relation) => `out:${relation}`),
      "out:owns",
      "in:owns",
      ...Object.keys(INCOMING)
        .filter((relation) => relation !== "owns")
        .map((relation) => `in:${relation}`),
    ];
    for (const key of order) {
      const group = groups.get(key);
      if (!group) continue;
      wrap.append(element("h4", {}, group.title));
      const ul = element("ul", { class: "plain" });
      for (const { edge, other } of group.items) {
        const li = element("li");
        li.append(nodeButton(other));
        const why = element(
          "button",
          {
            type: "button",
            class: "net-why",
            "aria-label": "Why this connection exists",
          },
          "why?",
        );
        why.addEventListener("click", () => select("edge", edge.id));
        li.append(why);
        ul.append(li);
      }
      wrap.append(ul);
    }
    return wrap;
  }

  function header(kind, name, memoryType) {
    const top = element("div", { class: "net-detail-head" });
    top.append(icon(kind, memoryType), element("h2", {}, name));
    return top;
  }

  function tags(texts) {
    const holder = element("p", { class: "net-tags" });
    for (const text of texts)
      holder.append(element("span", { class: "badge" }, text));
    return holder;
  }

  function tierTag(kind) {
    const tier = tierOf(kind);
    return element(
      "span",
      { class: `badge badge-tier tier-${tier}` },
      TIER_INFO[tier].label,
    );
  }

  /** The questions people bring to the diagram, each answered from the records shown. */
  function questions(node) {
    const holder = element("div", {
      class: "net-questions",
      role: "group",
      "aria-label": "Ask about it",
    });
    const ask = (text, handler, pressed) => {
      const button = element("button", { type: "button" }, text);
      if (pressed !== undefined)
        button.setAttribute("aria-pressed", pressed ? "true" : "false");
      button.addEventListener("click", handler);
      holder.append(button);
    };
    ask("Why?", () => {
      const target = details.querySelector("[data-why]");
      target?.scrollIntoView({
        block: "nearest",
        behavior: reduceMotion ? "auto" : "smooth",
      });
      target?.querySelector("h3")?.setAttribute("tabindex", "-1");
      target?.querySelector("h3")?.focus();
    });
    ask("What depends on this?", () => toggleImpact(), state.impact);
    const owner = ownerOf(node.id);
    if (owner)
      ask("Who owns this?", () => select("node", owner, { center: true }));
    if (!PEOPLE_KINDS.has(node.kind)) {
      ask(
        "Where did this come from?",
        () => showProvenance(node.id),
        trace?.kind === "provenance",
      );
    }
    ask("What changed?", () => {
      setMode("timeline");
      document
        .querySelector(`[data-event="${CSS.escape(node.id)}"]`)
        ?.scrollIntoView({ block: "center" });
    });
    ask("What did the AI receive?", () => setMode("trace"));
    return holder;
  }

  function actions(node) {
    const holder = element("div", { class: "net-actions" });
    const button = (text, handler, pressed, title) => {
      const b = element("button", { type: "button", title }, text);
      if (pressed !== undefined)
        b.setAttribute("aria-pressed", pressed ? "true" : "false");
      b.addEventListener("click", handler);
      holder.append(b);
    };
    const pinned = state.pins.includes(node.id);
    button(
      pinned ? "Unpin" : "Pin",
      () => togglePin(node.id),
      pinned,
      "Pin to compare side by side (P)",
    );
    button(
      "Focus",
      () => toggleIsolate(),
      state.isolate,
      "Only what connects to it (F)",
    );
    button(
      "Zoom to",
      () => zoomToSelection(),
      undefined,
      "Zoom to it and its connections (Z)",
    );
    const link = pageLink(node.href, "Open its page");
    if (link) holder.append(link);
    if (DEFINITION_KINDS.has(node.kind)) {
      const prompt = pageLink(`${node.href}/prompt`, "Prompt anatomy");
      if (prompt) holder.append(prompt);
    }
    return holder;
  }

  function impactSection(node) {
    const map = impactMap() ?? new Map();
    const byDepth = new Map();
    for (const [id, depth] of map) {
      const key = Math.min(depth, 3);
      if (!byDepth.has(key)) byDepth.set(key, []);
      byDepth.get(key).push(id);
    }
    const parts = [
      paragraph(
        map.size === 0
          ? "Nothing you can see relies on it."
          : `${plural(map.size, "thing relies", "things rely")} on it, through uses, follows, hands off to, based on, runs as, and cites. Ownership is not counted.`,
        map.size === 0 ? "empty" : "hint",
      ),
    ];
    for (const depth of [1, 2, 3]) {
      const ids = byDepth.get(depth);
      if (!ids) continue;
      parts.push(element("h4", {}, `${DEPTH_WORDS[depth]} (${ids.length})`));
      const ul = element("ul", { class: "plain" });
      for (const id of ids) {
        const li = element("li");
        li.append(nodeButton(id));
        ul.append(li);
      }
      parts.push(ul);
    }
    return section(`What depends on ${shortLabel(node.label)}`, ...parts);
  }

  function provenanceSection() {
    if (!trace || trace.kind !== "provenance") return null;
    if (trace.paths.length === 0) {
      return section(
        "Where it came from",
        paragraph(
          "No evidence chain you can see: it is not based on a memory, and cites no source.",
          "empty",
        ),
      );
    }
    const parts = [];
    for (const path of trace.paths) {
      const chain = element("ol", { class: "net-path-chain" });
      path.forEach((id, index) => {
        const li = element("li");
        li.append(nodeButton(id));
        const next = path[index + 1];
        if (next) {
          const edge = (edgesOf.get(id) ?? []).find(
            (one) => one.from === id && one.to === next,
          );
          if (edge)
            li.append(
              element("small", {}, legend.relations[edge.relation].label),
            );
        }
        const node = nodeById.get(id);
        if (
          node?.kind === "source" &&
          node.details.url?.startsWith("https://")
        ) {
          const small = element("small");
          small.append(
            element(
              "a",
              {
                href: node.details.url,
                rel: "noopener noreferrer",
                target: "_blank",
              },
              `Pull request ${node.details.reference}`,
            ),
          );
          li.append(small);
        }
        chain.append(li);
      });
      parts.push(chain);
    }
    return section("Where it came from", ...parts);
  }

  function aiUse() {
    return section(
      "AI use",
      paragraph(
        "Not recorded yet. MemoryNet records what it supplies to AI tools once they connect.",
        "hint",
      ),
    );
  }

  function renderDefinition(node) {
    const d = node.details;
    const info = legend.kinds[d.kind];
    const tagRow = tags([
      info.label.toLowerCase(),
      `version ${d.revision}`,
      ...(d.flags ?? []).map((flag) => flag.replaceAll("_", " ")),
    ]);
    tagRow.prepend(tierTag(node.kind));
    const parts = [
      header(node.kind, node.label),
      stateBadges(node.id),
      tagRow,
      questions(node),
      actions(node),
    ];
    if (d.warnings.length > 0) {
      const box = element("div", { class: "warning", role: "note" });
      box.append(list(d.warnings, ""));
      parts.push(box);
    }
    const purpose = section(
      "Purpose",
      paragraph(d.purpose),
      paragraph(info.meaning, "hint"),
    );
    purpose.setAttribute("data-why", "");
    parts.push(
      purpose,
      section(info.duties, list(d.responsibilities, "None listed.")),
      section(info.limits, list(d.boundaries, "None listed.")),
      section(
        "Applies to",
        paragraph(d.appliesTo ?? "Everywhere at this level."),
      ),
    );
    if (d.instructions !== "") {
      const box = element("details", { class: "net-instructions" });
      box.append(
        element("summary", {}, "Instructions"),
        element("p", { class: "content" }, d.instructions),
      );
      parts.push(box);
    }
    if (d.kind === "agent") {
      parts.push(
        section(
          "Runs as",
          paragraph(
            d.runsAsName === null
              ? "No agent account is named."
              : d.runsAsRole === undefined
                ? `${d.runsAsName}. Agent accounts can only read and propose, never approve.`
                : `${d.runsAsName}, with the ${d.runsAsRole ?? "no"} role at this level. Agent accounts can only read and propose, never approve.`,
          ),
        ),
      );
    }
    if (d.pendingChanges !== null && d.pendingChanges > 0) {
      const box = element("p", { class: "warning" });
      box.append(
        `${plural(d.pendingChanges, "change", "changes")} waiting for review. `,
      );
      const link = pageLink(node.href, "Review it on its page");
      if (link) box.append(link);
      parts.push(box);
    }
    if (state.impact) parts.push(impactSection(node));
    const provenance = provenanceSection();
    if (provenance) parts.push(provenance);
    const history = pageLink(node.href, "See every version");
    parts.push(
      section("Connections", connections(node.id)),
      section(
        "History",
        paragraph(
          d.revision > 1
            ? `Version ${d.revision} is current; ${plural(d.revision - 1, "earlier version is", "earlier versions are")} kept on its page.`
            : "Version 1, the first approved version.",
        ),
        ...(history ? [history] : []),
      ),
      section(
        "Where it comes from",
        facts([
          ["Level", `${legend.levels[d.scopeLevel].label}: ${d.scopeName}`],
          ["Owner", d.ownerName],
          [
            "This version",
            `${d.revision}, proposed by ${d.proposedByName}, approved by ${d.approvedByName} on ${formatDate(d.approvedAt)}`,
          ],
          ["Note", d.changeNote],
          ["Stored in", "definitions and definition_revisions"],
        ]),
      ),
      aiUse(),
    );
    return parts;
  }

  function renderMemory(node) {
    const d = node.details;
    const type = legend.memoryTypes[d.type];
    const knowledge = section(
      "Knowledge",
      element("p", { class: "content" }, d.content),
      paragraph(`${type.label}: ${type.meaning}`, "hint"),
    );
    knowledge.setAttribute("data-why", "");
    const tagRow = tags([type.label.toLowerCase(), `version ${d.revision}`]);
    tagRow.prepend(tierTag(node.kind));
    const parts = [
      header("memory", node.label, d.type),
      stateBadges(node.id),
      tagRow,
      questions(node),
      actions(node),
      knowledge,
    ];
    if (state.impact) parts.push(impactSection(node));
    const provenance = provenanceSection();
    if (provenance) parts.push(provenance);
    parts.push(
      section("Connections", connections(node.id)),
      section(
        "Where it comes from",
        facts([
          ["Owner", d.ownerName],
          ["Proposed by", d.proposedByName],
          ["Approved by", `${d.approvedByName} on ${formatDate(d.approvedAt)}`],
          ["Evidence", plural(d.evidenceCount, "source", "sources")],
          ["Stored in", "memories and memory_revisions"],
        ]),
      ),
      aiUse(),
    );
    return parts;
  }

  function renderSource(node) {
    const d = node.details;
    const link = d.url.startsWith("https://")
      ? element(
          "a",
          { href: d.url, rel: "noopener noreferrer", target: "_blank" },
          d.reference,
        )
      : d.reference;
    const excerpt = section(
      "Excerpt",
      element("blockquote", {}, d.excerpt),
      paragraph(legend.nodes.source.meaning, "hint"),
    );
    excerpt.setAttribute("data-why", "");
    const tagRow = tags(
      (d.flags ?? []).map((flag) => flag.replaceAll("_", " ")),
    );
    tagRow.prepend(tierTag(node.kind));
    const parts = [
      header("source", node.label),
      stateBadges(node.id),
      tagRow,
      questions(node),
      actions(node),
      excerpt,
    ];
    if (state.impact) parts.push(impactSection(node));
    parts.push(
      section("Connections", connections(node.id)),
      section(
        "Where it comes from",
        facts([
          ["Pull request", link],
          ["Repository", d.repository],
          [
            "Commit",
            d.revision === null ? "no commit" : d.revision.slice(0, 7),
          ],
          [
            "Captured",
            `${d.captureMethod === "github_app" ? "by the GitHub App" : `by ${d.capturedByName ?? "someone"}`} on ${formatDate(d.capturedAt)}`,
          ],
          ["Stored in", "sources"],
        ]),
      ),
    );
    return parts;
  }

  function renderPrincipal(node) {
    const d = node.details;
    const cluster = clusterById.get(node.clusterId);
    const owned = (edgesOf.get(node.id) ?? []).filter(
      (edge) => edge.from === node.id && edge.relation === "owns",
    );
    const memories = owned.filter(
      (edge) => nodeById.get(edge.to)?.kind === "memory",
    ).length;
    const definitions = owned.length - memories;
    const runs = (edgesOf.get(node.id) ?? []).filter(
      (edge) => edge.relation === "runs_as",
    ).length;
    const summary =
      node.kind === "person"
        ? `Accountable for ${plural(memories, "memory", "memories")} and ${plural(definitions, "definition", "definitions")} shown here.`
        : `${plural(runs, "agent definition runs", "agent definitions run")} as this account.`;
    const why = section(
      "Why it is here",
      paragraph(summary),
      paragraph(
        `Shown in ${cluster?.name ?? "the organization"} because it is the smallest group holding everything linked to ${d.kind === "agent" ? "this account" : "them"} here. It is not a membership list.`,
        "hint",
      ),
    );
    why.setAttribute("data-why", "");
    const tagRow = tags([legend.nodes[node.kind].label.toLowerCase()]);
    tagRow.prepend(tierTag(node.kind));
    const parts = [
      header(node.kind, node.label),
      tagRow,
      questions(node),
      actions(node),
      why,
    ];
    if (state.impact) parts.push(impactSection(node));
    parts.push(section("Connections", connections(node.id)));
    return parts;
  }

  function renderEdge(edge) {
    const info = legend.relations[edge.relation];
    const line = element("p", { class: "net-edge-sentence" });
    line.append(
      nodeButton(edge.from),
      element("strong", {}, ` ${info.label} `),
      nodeButton(edge.to),
    );
    const why = section(
      "Why it is here",
      paragraph(edge.why),
      facts([["Stored in", edge.table]]),
    );
    why.setAttribute("data-why", "");
    return [
      header("connection", `Connection: ${info.label}`),
      line,
      paragraph(info.meaning, "hint"),
      why,
    ];
  }

  function renderStream(chosen) {
    const stream = streams.find((one) => one.id === chosen.id);
    if (!stream)
      return [
        paragraph("This stream is not drawn at this zoom any more.", "empty"),
      ];
    const parts = [
      header("stream", plural(stream.count, "connection", "connections")),
      paragraph(
        "Connections between groups, drawn together at this zoom. Zoom in, or pick one below, to see each on its own.",
        "hint",
      ),
    ];
    const ul = element("ul", { class: "plain" });
    for (const id of stream.edges) {
      const edge = edgeById.get(id);
      const li = element("li");
      li.append(
        nodeButton(edge.from),
        element("small", {}, ` ${legend.relations[edge.relation].label} `),
        nodeButton(edge.to),
      );
      const why = element(
        "button",
        { type: "button", class: "net-why" },
        "why?",
      );
      why.addEventListener("click", () => select("edge", edge.id));
      li.append(why);
      ul.append(li);
    }
    parts.push(section("Inside this stream", ul));
    return parts;
  }

  function renderCluster(cluster) {
    const measure = measures.get(cluster.id);
    const lines = Object.entries(measure?.kinds ?? {}).map(
      ([kind, count]) => `${legend.nodes[kind].label}: ${count}`,
    );
    const actionsRow = element("div", { class: "net-actions" });
    const zoom = element("button", { type: "button" }, "Frame it");
    zoom.addEventListener("click", () => {
      userMoved = true;
      frameGroup(cluster.id);
    });
    actionsRow.append(zoom);
    const only = element(
      "button",
      { type: "button", "aria-pressed": state.isolate ? "true" : "false" },
      "Only this group",
    );
    only.addEventListener("click", () => {
      toggleIsolate();
      renderDetails();
    });
    actionsRow.append(only);
    for (const [href, text] of [
      [cluster.href, "Open its page"],
      [cluster.definitionsHref, "Its definitions"],
    ]) {
      const link = pageLink(href, text);
      if (link) actionsRow.append(link);
    }
    const children = clusters.filter((other) => other.parentId === cluster.id);
    const where =
      cluster.parentId === null
        ? "The center of the map: what the whole organization shares."
        : cluster.level === "business_unit"
          ? "A slice of the first ring: shared by every project in this business unit. Its projects sit in the ring outside it."
          : "A slice of the outer ring: only for this project.";
    const parts = [
      header("group", cluster.name),
      tags([legend.levels[cluster.level].label.toLowerCase()]),
      actionsRow,
      paragraph(legend.levels[cluster.level].meaning, "hint"),
      paragraph(where, "hint"),
      facts([
        [
          "Your role",
          cluster.role ?? "none here; you see it because you work inside it",
        ],
        [
          "New definitions waiting",
          cluster.pendingNewDefinitions === null
            ? null
            : String(cluster.pendingNewDefinitions),
        ],
        [
          "Changes waiting inside",
          (measure?.pending ?? 0) > 0 ? String(measure.pending) : null,
        ],
        [
          "Incidents inside",
          (measure?.incidents ?? 0) > 0 ? String(measure.incidents) : null,
        ],
      ]),
      section("Inside, that you can see", list(lines, "Nothing yet.")),
    ];
    if (children.length > 0) {
      const ul = element("ul", { class: "plain" });
      for (const child of children) {
        const li = element("li");
        li.append(clusterButton(child.id));
        ul.append(li);
      }
      parts.push(section("Groups inside", ul));
    }
    return parts;
  }

  function renderList(chosen) {
    const parts = [element("h2", {}, chosen.title)];
    if (chosen.note) parts.push(paragraph(chosen.note, "hint"));
    if (chosen.id === "pending") {
      const groupsWaiting = clusters.filter(
        (cluster) => (cluster.pendingNewDefinitions ?? 0) > 0,
      );
      if (groupsWaiting.length > 0) {
        const ul = element("ul", { class: "plain" });
        for (const cluster of groupsWaiting) {
          const li = element("li");
          li.append(
            clusterButton(cluster.id),
            element(
              "small",
              {},
              ` ${plural(cluster.pendingNewDefinitions, "new definition", "new definitions")} waiting`,
            ),
          );
          const link = pageLink(cluster.definitionsHref, "Review");
          if (link) li.append(" ", link);
          ul.append(li);
        }
        parts.push(section("New definitions", ul));
      }
    }
    const ul = element("ul", { class: "plain" });
    for (const id of chosen.ids ?? []) {
      const li = element("li");
      li.append(nodeButton(id));
      ul.append(li);
    }
    if ((chosen.ids ?? []).length > 0) parts.push(section("On the map", ul));
    return parts;
  }

  function pinsStrip() {
    const strip = element("div", { class: "net-pins", "aria-label": "Pinned" });
    if (state.pins.length === 0) {
      strip.hidden = true;
      return strip;
    }
    strip.append(element("span", { class: "muted" }, "Pinned:"));
    for (const id of state.pins) {
      const chip = element("span", { class: "net-pin-chip" });
      const go = element(
        "button",
        { type: "button" },
        shortLabel(nodeById.get(id)?.label ?? "?"),
      );
      go.addEventListener("click", () => select("node", id, { center: true }));
      const remove = element(
        "button",
        {
          type: "button",
          "aria-label": `Unpin ${nodeById.get(id)?.label ?? ""}`,
        },
        "×",
      );
      remove.addEventListener("click", () => togglePin(id));
      chip.append(go, remove);
      strip.append(chip);
    }
    return strip;
  }

  function listButton(text, key, ids, note) {
    const button = element(
      "button",
      { type: "button", class: "net-link" },
      text,
    );
    button.addEventListener("click", () =>
      select("list", key, { ids, title: text, note }),
    );
    return button;
  }

  /** The brain registry: what is in the brain, what AI tools would get, and what needs a person. */
  function overview() {
    const registry = brainRegistry(nodes, clusters);
    const parts = [
      element("h2", {}, "Brain registry"),
      paragraph(
        `What ${data.organization.name} knows and how it works, as far as you may see. Select anything on the map to see why it exists, what depends on it, who owns it, and where it came from.`,
        "hint",
      ),
    ];
    const grid = element("div", { class: "net-registry" });
    for (const tier of TIER_ORDER) {
      const info = TIER_INFO[tier];
      const entry = registry.tiers[tier];
      const tile = element("button", {
        type: "button",
        class: `net-reg-tile tier-${tier}`,
      });
      tile.append(
        icon(info.icon),
        element("span", { class: "net-reg-count" }, String(entry.count)),
        element("span", { class: "net-reg-label" }, info.label),
        element("small", {}, info.detail),
      );
      tile.disabled = entry.count === 0;
      tile.addEventListener("click", () => {
        if (tier === "people" && !state.people) setPeople(true);
        else if (!tierOn(tier)) toggleTier(tier);
        select("list", `tier-${tier}`, {
          ids: entry.ids,
          title: `${info.label}: ${plural(entry.count, "item", "items")}`,
        });
      });
      grid.append(tile);
    }
    parts.push(grid);
    const ready = element("p", { class: "net-reg-ready" });
    ready.append(
      listButton(
        plural(
          registry.ready.count,
          "approved, current record",
          "approved, current records",
        ),
        "ready",
        registry.ready.ids,
        "Only approved, current guidance and knowledge. Nothing waiting for review and nothing retired is included.",
      ),
    );
    parts.push(
      section(
        "Ready for AI tools",
        ready,
        paragraph(
          "This is what MemoryNet would give AI tools once they connect. Proposals waiting for review and retired records are never included.",
          "hint",
        ),
      ),
    );
    const needs = element("ul", { class: "plain" });
    const add = (count, text, key, ids, note) => {
      if (count === 0) return;
      const li = element("li");
      li.append(listButton(text, key, ids, note));
      needs.append(li);
    };
    add(
      registry.pending.count,
      plural(
        registry.pending.count,
        "change waiting for review",
        "changes waiting for review",
      ),
      "pending",
      registry.pending.ids,
    );
    add(
      registry.warnings.count,
      plural(
        registry.warnings.count,
        "definition needs a look",
        "definitions need a look",
      ),
      "warnings",
      registry.warnings.ids,
    );
    add(
      registry.flagged.count,
      plural(registry.flagged.count, "flagged item", "flagged items"),
      "flagged",
      registry.flagged.ids,
      "Possible personal data, or a secret was removed before storing.",
    );
    add(
      registry.retired.count,
      plural(
        registry.retired.count,
        "retired definition (history only)",
        "retired definitions (history only)",
      ),
      "retired",
      registry.retired.ids,
      "Kept for history. Nothing should rely on them, and AI tools never get them.",
    );
    parts.push(
      section(
        "Needs a person",
        needs.children.length > 0
          ? needs
          : paragraph("Nothing you can see needs attention.", "empty"),
      ),
    );
    const recent = events.slice(0, 5);
    if (recent.length > 0) {
      const ul = element("ul", { class: "plain" });
      for (const event of recent) {
        const li = element("li");
        li.append(
          nodeButton(event.id),
          element("small", {}, ` ${event.what} ${day(event.at)}`),
        );
        ul.append(li);
      }
      parts.push(section("Latest changes", ul));
    }
    parts.push(
      section(
        "How to read the map",
        list(
          [
            "Big glowing spheres are hubs: the organization in the middle, its business units, and their projects. Everything a team keeps gathers around its hub.",
            "Colour says what a thing is: memories by type (decision, lesson, constraint, incident…), evidence in teal, rules, instructions, skills, and agents in their own colours. The key is at the bottom left.",
            "Point at anything to preview its connections; click to light its path to the core. Drag to move the map, scroll to zoom, or press ⌘K to find something.",
            "Turn on People to see owners and agent accounts on the map.",
          ],
          "",
        ),
      ),
      section(
        "This picture",
        facts([
          ["Organization", data.organization.name],
          [
            "You are",
            `${data.viewer.displayName} (${data.viewer.kind === "agent" ? "agent" : "person"})`,
          ],
          ["Snapshot", formatDate(data.generatedAt)],
          [
            "Contains",
            `${plural(clusters.length, "group", "groups")}, ${plural(nodes.length, "item", "items")}, ${plural(edges.length, "connection", "connections")}`,
          ],
        ]),
        paragraph(
          "Only what you may see is here. Anything else is left out completely, including its name and count.",
          "hint",
        ),
      ),
    );
    if (nodes.length === 0) {
      parts.push(
        paragraph(
          "Nothing to show yet: approve a memory or a definition first.",
          "empty",
        ),
      );
    }
    return parts;
  }

  let missingLink = false;
  function renderDetails() {
    const parts = [pinsStrip()];
    if (missingLink && selected === null) {
      parts.push(
        paragraph(
          "Nothing you can see in this network matches that link.",
          "warning",
        ),
      );
    }
    if (selected === null) {
      parts.push(...overview());
    } else if (selected.type === "node") {
      const node = nodeById.get(selected.id);
      parts.push(breadcrumbFor(node.clusterId));
      if (DEFINITION_KINDS.has(node.kind))
        parts.push(...renderDefinition(node));
      else if (node.kind === "memory") parts.push(...renderMemory(node));
      else if (node.kind === "source") parts.push(...renderSource(node));
      else parts.push(...renderPrincipal(node));
    } else if (selected.type === "edge") {
      parts.push(...renderEdge(edgeById.get(selected.id)));
    } else if (selected.type === "stream") {
      parts.push(...renderStream(selected));
    } else if (selected.type === "list") {
      parts.push(...renderList(selected));
    } else {
      const cluster = clusterById.get(selected.id);
      parts.push(breadcrumbFor(cluster.id), ...renderCluster(cluster));
    }
    if (selected !== null) {
      const clear = element(
        "button",
        { type: "button", class: "secondary net-clear" },
        "Back to the registry",
      );
      clear.addEventListener("click", () => select(null, null));
      parts.push(clear);
    }
    details.replaceChildren(...parts);
    renderCompare();
  }

  // Impact, provenance, focus, and pins -------------------------------------------------------------
  function toggleImpact() {
    if (selected?.type !== "node") return;
    state.impact = !state.impact;
    trace = null;
    refresh();
    renderDetails();
    pushHistory(true);
  }

  function showProvenance(id) {
    if (trace?.kind === "provenance" && trace.id === id) {
      trace = null;
    } else {
      const paths = provenancePaths(
        edges.filter((edge) => visible.edges.has(edge.id)),
        id,
      );
      const traced = new Set([id]);
      const tracedEdges = new Set();
      for (const path of paths) {
        path.forEach((one, index) => {
          traced.add(one);
          const next = path[index + 1];
          const edge = next
            ? (edgesOf.get(one) ?? []).find(
                (e) => e.from === one && e.to === next,
              )
            : null;
          if (edge) tracedEdges.add(edge.id);
        });
      }
      state.impact = false;
      trace = {
        kind: "provenance",
        id,
        paths,
        nodes: traced,
        edges: tracedEdges,
      };
    }
    refresh();
    renderDetails();
  }

  function toggleIsolate() {
    state.isolate = !state.isolate;
    syncControls();
    refresh();
    renderPanels();
    pushHistory(true);
  }

  function togglePin(id) {
    if (!id) return;
    if (state.pins.includes(id))
      state.pins = state.pins.filter((one) => one !== id);
    else state.pins = [...state.pins, id].slice(-MAX_PINS);
    refresh();
    renderDetails();
    pushHistory(true);
  }

  function renderCompare() {
    if (!compare) return;
    if (state.pins.length < 2) {
      compare.hidden = true;
      compare.replaceChildren();
      return;
    }
    compare.hidden = false;
    const head = element("div", { class: "net-compare-head" });
    head.append(element("h2", {}, `Side by side (${state.pins.length})`));
    const clear = element(
      "button",
      { type: "button", class: "secondary" },
      "Unpin all",
    );
    clear.addEventListener("click", () => {
      state.pins = [];
      refresh();
      renderDetails();
      pushHistory(true);
    });
    head.append(clear);
    const grid = element("div", { class: "net-compare-grid" });
    for (const id of state.pins) {
      const node = nodeById.get(id);
      if (!node) continue;
      const d = node.details;
      const card = element("div", { class: "net-compare-card" });
      const title = element("div", { class: "net-detail-head" });
      title.append(nodeButton(id));
      const incoming = (edgesOf.get(id) ?? []).filter(
        (edge) => edge.to === id,
      ).length;
      const outgoing = (edgesOf.get(id) ?? []).filter(
        (edge) => edge.from === id,
      ).length;
      const text = d.purpose ?? d.content ?? d.excerpt ?? "";
      card.append(
        title,
        stateBadges(id),
        facts([
          ["Kind", legend.nodes[node.kind].label],
          ["Memory", TIER_INFO[tierOf(node.kind)].label],
          [
            "Where",
            groupPath(clusterById, node.clusterId)
              .map((cluster) => cluster.name)
              .join(" / "),
          ],
          ["Owner", d.ownerName ?? null],
          ["Version", d.revision ?? null],
          ["Approved", d.approvedAt ? day(d.approvedAt) : null],
          ["Captured", d.capturedAt ? day(d.capturedAt) : null],
          ["Connections", `${outgoing} out, ${incoming} in`],
        ]),
        text === ""
          ? paragraph("", "empty")
          : paragraph(
              text.length > 220 ? `${text.slice(0, 219)}…` : text,
              "hint",
            ),
      );
      grid.append(card);
    }
    compare.replaceChildren(head, grid);
  }

  // Modes: Network, Timeline, AI Trace, Table -------------------------------------------------------
  const tabs = [...document.querySelectorAll(".net-modes [role=tab]")];
  function setMode(mode, options = {}) {
    if (!MODES.includes(mode)) return;
    state.mode = mode;
    for (const tab of tabs) {
      const on = tab.getAttribute("data-mode") === mode;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.setAttribute("tabindex", on ? "0" : "-1");
      const panel = $(tab.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    }
    renderPanels();
    updateMinimap();
    if (mode === "network") scheduleLabels();
    saveWorkspace();
    if (options.history !== false) pushHistory(options.history === "replace");
  }

  function renderPanels() {
    if (state.mode === "timeline") renderTimeline();
    if (state.mode === "table") renderTable();
    renderDock();
  }

  function eventText(event) {
    const node = nodeById.get(event.id);
    const where = clusterById.get(node.clusterId)?.name ?? "";
    if (event.what === "captured")
      return `captured by ${event.by ?? "someone"} · ${where}`;
    const version = event.version ? `version ${event.version} ` : "";
    return `${version}${event.what}${event.by ? ` by ${event.by}` : ""} · ${where}`;
  }

  function renderTimeline() {
    const panel = $("net-panel-timeline");
    if (!panel) return;
    const allowed = allowedNodes();
    const shown = events.filter(
      (event) =>
        allowed.has(event.id) && inDayRange(event, state.from, state.to),
    );
    const head = element("div", { class: "net-panel-head" });
    head.append(element("h2", {}, "Timeline"));
    const range = element("div", { class: "field-row" });
    const from = element("input", {
      type: "date",
      id: "net-from",
      value: state.from ?? "",
      "aria-label": "From",
    });
    const to = element("input", {
      type: "date",
      id: "net-to",
      value: state.to ?? "",
      "aria-label": "To",
    });
    const all = element(
      "button",
      { type: "button", class: "secondary" },
      "All dates",
    );
    from.addEventListener("change", () => {
      state.from = from.value || null;
      renderTimeline();
      pushHistory(true);
    });
    to.addEventListener("change", () => {
      state.to = to.value || null;
      renderTimeline();
      pushHistory(true);
    });
    all.addEventListener("click", () => {
      state.from = null;
      state.to = null;
      renderTimeline();
      pushHistory(true);
    });
    range.append(
      element("span", {}, "From"),
      from,
      element("span", {}, "to"),
      to,
      all,
    );
    head.append(range);
    const note = paragraph(
      "When each current version was approved, and when evidence was captured. Earlier versions are on each record's page; replaced and suspended memories join the timeline with memory history.",
      "hint",
    );
    const parts = [head, note];
    if (shown.length === 0) {
      parts.push(
        paragraph(
          events.length === 0
            ? "Nothing dated yet."
            : "Nothing in this range matches your choices.",
          "empty",
        ),
      );
    } else {
      const ol = element("ol", { class: "net-timeline" });
      for (const group of eventsByDay(shown)) {
        const li = element("li");
        li.append(element("time", { datetime: group.day }, group.day));
        const ul = element("ul");
        for (const event of group.events) {
          const row = element("li", {
            "data-event": event.id,
            class: `tier-${tierOf(nodeById.get(event.id)?.kind ?? "memory")}`,
          });
          if (selected?.type === "node" && selected.id === event.id)
            row.classList.add("selected");
          row.append(
            nodeButton(event.id),
            element("small", {}, eventText(event)),
          );
          ul.append(row);
        }
        li.append(ul);
        ol.append(li);
      }
      parts.push(ol);
    }
    panel.replaceChildren(...parts);
  }

  function ownerText(node) {
    const d = node.details;
    if (d.ownerName) return d.ownerName;
    if (node.kind === "source")
      return d.captureMethod === "github_app"
        ? "GitHub App"
        : (d.capturedByName ?? "");
    return "";
  }

  function rowOf(node) {
    const d = node.details;
    return {
      id: node.id,
      label: node.label,
      tier: TIER_INFO[tierOf(node.kind)].label,
      tierRank: TIER_ORDER.indexOf(tierOf(node.kind)),
      kind: legend.nodes[node.kind].label,
      state: (statesOf.get(node.id) ?? [])
        .map((one) => legend.states[one].label)
        .join(", "),
      group: groupPath(clusterById, node.clusterId)
        .map((cluster) => cluster.name)
        .join(" / "),
      owner: ownerText(node),
      // A source's revision is its commit; the short form is enough in a table.
      version:
        node.kind === "source"
          ? String(d.revision ?? "").slice(0, 7)
          : (d.revision ?? ""),
      date: day(d.approvedAt ?? d.capturedAt ?? ""),
      links: (edgesOf.get(node.id) ?? []).length,
    };
  }

  let tableFilter = "";
  function renderTable() {
    const panel = $("net-panel-table");
    if (!panel) return;
    const focusWasFilter = document.activeElement?.id === "net-table-filter";
    const allowed = visible.nodes;
    const words = tableFilter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let rows = nodes
      .filter((node) => allowed.has(node.id))
      .map(rowOf)
      .filter((row) =>
        words.every((word) =>
          `${row.label} ${row.tier} ${row.kind} ${row.group} ${row.owner} ${row.state}`
            .toLowerCase()
            .includes(word),
        ),
      );
    const { key, dir } = tableSort;
    rows.sort((a, b) => {
      const x = key === "tier" ? a.tierRank : a[key];
      const y = key === "tier" ? b.tierRank : b[key];
      const order =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y));
      return order * dir || a.label.localeCompare(b.label);
    });
    const total = rows.length;
    rows = rows.slice(0, tableLimit);
    const head = element("div", { class: "net-panel-head" });
    head.append(element("h2", {}, "Table"));
    const tools = element("div", { class: "net-table-tools" });
    const filter = element("input", {
      type: "search",
      id: "net-table-filter",
      placeholder: "Filter by name, kind, group, owner, or state",
      "aria-label": "Filter rows",
      value: tableFilter,
    });
    filter.addEventListener("input", () => {
      tableFilter = filter.value;
      tableLimit = TABLE_PAGE;
      renderTable();
    });
    tools.append(
      filter,
      element("span", { class: "muted" }, `${total} of ${nodes.length} items`),
    );
    head.append(tools);
    const columns = [
      ["label", "Name"],
      ["tier", "Memory"],
      ["kind", "Kind"],
      ["state", "State"],
      ["group", "Where"],
      ["owner", "Owner"],
      ["version", "Version"],
      ["date", "Date"],
      ["links", "Links"],
    ];
    const table = element("table", { class: "net-table" });
    const thead = element("thead");
    const headRow = element("tr");
    for (const [column, text] of columns) {
      const th = element("th", {
        scope: "col",
        "aria-sort":
          tableSort.key === column
            ? tableSort.dir === 1
              ? "ascending"
              : "descending"
            : "none",
      });
      const button = element("button", { type: "button" }, text);
      button.addEventListener("click", () => {
        tableSort = {
          key: column,
          dir: tableSort.key === column ? -tableSort.dir : 1,
        };
        renderTable();
      });
      th.append(button);
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = element("tbody");
    for (const row of rows) {
      const tr = element("tr");
      if (selected?.type === "node" && selected.id === row.id)
        tr.classList.add("selected");
      const name = element("td");
      name.append(nodeButton(row.id));
      tr.append(name);
      const node = nodeById.get(row.id);
      const tierCell = element("td", { class: "short" });
      tierCell.append(tierTag(node.kind));
      tr.append(tierCell);
      tr.append(element("td", { class: "short" }, row.kind));
      const stateCell = element("td", { class: "short" });
      for (const one of statesOf.get(row.id) ?? []) {
        stateCell.append(
          element(
            "span",
            { class: "badge badge-state", "data-state": one },
            legend.states[one].label,
          ),
        );
      }
      tr.append(stateCell);
      tr.append(
        element(
          "td",
          { title: row.group },
          clusterById.get(node.clusterId)?.name ?? "",
        ),
      );
      tr.append(element("td", {}, row.owner));
      for (const value of [row.version, row.date, row.links]) {
        tr.append(element("td", { class: "short" }, String(value)));
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const wrap = element("div", { class: "table-wrap" });
    wrap.append(table);
    const parts = [head, wrap];
    if (total === 0)
      parts.push(paragraph("Nothing you can see matches.", "empty"));
    if (total > rows.length) {
      const more = element(
        "button",
        { type: "button", class: "secondary" },
        `Show ${Math.min(TABLE_PAGE, total - rows.length)} more`,
      );
      more.addEventListener("click", () => {
        tableLimit += TABLE_PAGE;
        renderTable();
      });
      parts.push(more);
    }
    const edgeRows = [...visible.edges].map((id) => edgeById.get(id));
    parts.push(element("h3", {}, `Connections (${edgeRows.length})`));
    const edgeTable = element("table", { class: "net-table" });
    const edgeHead = element("thead");
    const edgeHeadRow = element("tr");
    for (const text of ["From", "Connection", "To", "Why it is here"])
      edgeHeadRow.append(element("th", { scope: "col" }, text));
    edgeHead.append(edgeHeadRow);
    const edgeBody = element("tbody");
    for (const edge of edgeRows.slice(0, tableLimit)) {
      const tr = element("tr");
      const from = element("td");
      from.append(nodeButton(edge.from));
      const to = element("td");
      to.append(nodeButton(edge.to));
      tr.append(
        from,
        element("td", {}, legend.relations[edge.relation].label),
        to,
        element("td", {}, edge.why),
      );
      edgeBody.append(tr);
    }
    edgeTable.append(edgeHead, edgeBody);
    const edgeWrap = element("div", { class: "table-wrap" });
    edgeWrap.append(edgeTable);
    parts.push(edgeWrap);
    panel.replaceChildren(...parts);
    if (focusWasFilter) {
      const input = $("net-table-filter");
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function renderDock() {
    if (!dock) return;
    const allowed = allowedNodes();
    const recent = events.filter((event) => allowed.has(event.id)).slice(0, 12);
    const ol = element("ol");
    for (const event of recent) {
      const li = element("li");
      li.append(
        nodeButton(event.id),
        element("small", {}, `${day(event.at)} · ${eventText(event)}`),
      );
      ol.append(li);
    }
    dock.replaceChildren(
      element("h2", {}, "Recent changes"),
      recent.length > 0 ? ol : paragraph("Nothing dated yet.", "empty"),
    );
  }

  // The address, history, and saved views ----------------------------------------------------------
  function viewState(withCamera = true) {
    return {
      mode: state.mode,
      node: selected?.type === "node" ? selected.id : null,
      focus: selected?.type === "cluster" ? selected.id : null,
      isolate: state.isolate,
      depth: state.depth,
      impact: state.impact,
      hideKinds: [...state.hideKinds],
      hideRelations: [...state.hideRelations],
      retired: state.retired,
      people: state.people,
      pins: state.pins,
      camera: withCamera && userMoved ? cameraState() : null,
      from: state.from,
      to: state.to,
    };
  }

  function urlFor(query) {
    const params = new URLSearchParams(query);
    const evidence = new URLSearchParams(window.location.search).get("evidence");
    if (evidence === "all" || evidence === "cited") params.set("evidence", evidence);
    const encoded = params.toString();
    return `${window.location.pathname}${encoded === "" ? "" : `?${encoded}`}`;
  }

  function updateNavButtons() {
    const back = $("net-back");
    const forward = $("net-forward");
    if (back) back.disabled = navIndex <= 0;
    if (forward) forward.disabled = navIndex >= navMax;
  }

  function pushHistory(replace = false) {
    const url = urlFor(encodeViewState(viewState()));
    if (replace) {
      window.history.replaceState({ net: navIndex }, "", url);
    } else {
      // Keep the camera on the entry being left, so Back returns to the same view.
      window.history.replaceState(
        { net: navIndex },
        "",
        window.location.pathname + window.location.search,
      );
      navIndex += 1;
      navMax = navIndex;
      window.history.pushState({ net: navIndex }, "", url);
    }
    updateNavButtons();
  }

  let urlTimer = 0;
  function scheduleUrl() {
    clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => {
      window.history.replaceState(
        { net: navIndex },
        "",
        urlFor(encodeViewState(viewState())),
      );
    }, 250);
  }

  function applyState(next, { animate = true } = {}) {
    state.hideKinds = new Set(next.hideKinds);
    state.hideRelations = new Set(next.hideRelations);
    state.retired = next.retired;
    state.isolate = next.isolate;
    state.depth = next.depth;
    state.pins = next.pins;
    state.from = next.from;
    state.to = next.to;
    if (next.people !== state.people) setPeople(next.people, { quiet: true });
    syncControls();
    selected = next.node
      ? { type: "node", id: next.node }
      : next.focus
        ? { type: "cluster", id: next.focus }
        : null;
    trace = null;
    state.impact = next.impact && selected?.type === "node";
    if (selected?.type === "node") reveal(selected.id);
    setMode(next.mode, { history: false });
    refresh();
    renderDetails();
    updateWhere();
    if (next.camera) {
      userMoved = true;
      const target = cameraTarget(next.camera);
      if (animate) animateTo(target);
      else {
        Object.assign(view, target);
        applyView();
      }
    } else if (selected?.type === "node") {
      const place = nodePlace(selected.id);
      if (place) centerOn(place.x, place.y, 0.9, animate);
    } else if (selected?.type === "cluster") {
      frameGroup(selected.id, animate);
    } else {
      userMoved = false;
      fitAll(animate);
    }
    renderPanels();
  }

  window.addEventListener("popstate", (event) => {
    navIndex = typeof event.state?.net === "number" ? event.state.net : 0;
    updateNavButtons();
    missingLink = false;
    applyState(decodeViewState(window.location.search, known));
  });

  function savedViews() {
    return parseSavedViews(storageGet(storeKey("views")));
  }

  function renderSavedViews() {
    const holder = $("net-saved");
    if (!holder) return;
    const views = savedViews();
    holder.replaceChildren();
    if (views.length === 0) {
      holder.append(element("li", { class: "muted" }, "None yet."));
      return;
    }
    for (const saved of views) {
      const li = element("li");
      const open = element(
        "button",
        { type: "button", class: "net-link" },
        saved.name,
      );
      open.addEventListener("click", () => {
        $("net-views-menu")?.removeAttribute("open");
        applyState(decodeViewState(saved.query, known));
        pushHistory();
      });
      const remove = element(
        "button",
        {
          type: "button",
          class: "net-why",
          "aria-label": `Delete ${saved.name}`,
        },
        "delete",
      );
      remove.addEventListener("click", () => {
        storageSet(
          storeKey("views"),
          JSON.stringify(savedViews().filter((one) => one.name !== saved.name)),
        );
        renderSavedViews();
      });
      li.append(open, remove);
      holder.append(li);
    }
  }

  $("net-save-view")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("net-view-name");
    const name = input?.value ?? "";
    if (name.trim() === "") return;
    const query = encodeViewState({ ...viewState(), camera: cameraState() });
    storageSet(
      storeKey("views"),
      JSON.stringify(
        withSavedView(savedViews(), name, query, new Date().toISOString()),
      ),
    );
    if (input) input.value = "";
    renderSavedViews();
    if (announcer) announcer.textContent = `Saved the view “${name.trim()}”.`;
  });

  $("net-copy-link")?.addEventListener("click", async () => {
    const url = `${window.location.origin}${urlFor(encodeViewState({ ...viewState(), camera: cameraState() }))}`;
    const button = $("net-copy-link");
    try {
      await navigator.clipboard.writeText(url);
      if (button) button.textContent = "Link copied";
    } catch {
      window.prompt("Copy this link", url);
    }
    window.setTimeout(() => {
      if (button) button.textContent = "Copy a link to this view";
    }, 1800);
  });

  function saveWorkspace() {
    storageSet(
      storeKey("workspace"),
      JSON.stringify({
        mode: state.mode,
        edgeMode: state.edgeMode,
        shade: state.shade,
        labels: state.labels,
        flow: state.flow,
        people: state.people,
        hideKinds: [...state.hideKinds],
        hideRelations: [...state.hideRelations],
        retired: state.retired,
        closed: [...state.closed].filter((id) => clusterById.has(id)),
      }),
    );
  }

  /** Display choices from last time; filters only when the address brings none. */
  function loadWorkspace(withFilters) {
    let saved;
    try {
      saved = JSON.parse(storageGet(storeKey("workspace")) ?? "null");
    } catch {
      saved = null;
    }
    if (!saved || typeof saved !== "object") return null;
    if (["auto", "all", "bundled", "selection"].includes(saved.edgeMode))
      state.edgeMode = saved.edgeMode;
    if (
      ["none", "items", "pending", "incidents", "recent"].includes(saved.shade)
    )
      state.shade = saved.shade;
    if (typeof saved.labels === "boolean") state.labels = saved.labels;
    if (typeof saved.flow === "boolean")
      state.flow = saved.flow;
    if (Array.isArray(saved.closed))
      state.closed = new Set(saved.closed.filter((id) => clusterById.has(id)));
    const filters = withFilters
      ? {
          hideKinds: Array.isArray(saved.hideKinds)
            ? saved.hideKinds.filter((kind) => known.kinds.has(kind))
            : [],
          hideRelations: Array.isArray(saved.hideRelations)
            ? saved.hideRelations.filter((relation) =>
                known.relations.has(relation),
              )
            : [],
          retired: saved.retired === true,
          people: saved.people === true,
        }
      : null;
    return { mode: MODES.includes(saved.mode) ? saved.mode : null, filters };
  }

  // Controls -----------------------------------------------------------------------------------------
  function syncControls() {
    document.querySelectorAll("input[data-kind]").forEach((box) => {
      const kind = box.getAttribute("data-kind");
      box.checked =
        !state.hideKinds.has(kind) && (state.people || !PEOPLE_KINDS.has(kind));
    });
    document.querySelectorAll("input[data-relation]").forEach((box) => {
      box.checked = !state.hideRelations.has(box.getAttribute("data-relation"));
    });
    const set = (id, value, prop = "checked") => {
      const control = $(id);
      if (control) control[prop] = value;
    };
    set("net-retired", state.retired);
    set("net-focus-mode", state.isolate);
    set("net-depth", String(state.depth), "value");
    set("net-edge-mode", state.edgeMode, "value");
    set("net-shade", state.shade, "value");
    set("net-labels", state.labels);
    set("net-flow", state.flow);
    svg.classList.toggle("hide-labels", !state.labels);
    svg.classList.toggle("show-edge-labels", state.flow);
    svg.classList.toggle("people-hidden", !state.people);
    updateLegend();
  }

  const onChange = (id, handler) => $(id)?.addEventListener("change", handler);
  onChange("net-retired", (event) => {
    state.retired = event.target.checked;
    refresh();
    renderDetails();
    renderPanels();
    pushHistory(true);
  });
  onChange("net-focus-mode", (event) => {
    state.isolate = event.target.checked;
    refresh();
    renderPanels();
    pushHistory(true);
  });
  onChange("net-depth", (event) => {
    state.depth = Number(event.target.value) || 1;
    refresh();
    renderPanels();
    pushHistory(true);
  });
  onChange("net-edge-mode", (event) => {
    state.edgeMode = event.target.value;
    refresh();
    saveWorkspace();
  });
  onChange("net-shade", (event) => {
    state.shade = event.target.value;
    refresh();
    saveWorkspace();
  });
  onChange("net-labels", (event) => {
    state.labels = event.target.checked;
    syncControls();
    scheduleLabels();
    saveWorkspace();
  });
  onChange("net-flow", (event) => {
    state.flow = event.target.checked;
    syncControls();
    scheduleLabels();
    saveWorkspace();
  });
  document.querySelectorAll("input[data-kind]").forEach((box) => {
    box.addEventListener("change", () => {
      const kind = box.getAttribute("data-kind");
      if (box.checked && PEOPLE_KINDS.has(kind) && !state.people) {
        for (const other of PEOPLE_KINDS) {
          if (other !== kind) state.hideKinds.add(other);
        }
        setPeople(true);
        return;
      }
      if (box.checked) state.hideKinds.delete(kind);
      else state.hideKinds.add(kind);
      refresh();
      renderDetails();
      renderPanels();
      pushHistory(true);
    });
  });
  document.querySelectorAll("input[data-relation]").forEach((box) => {
    box.addEventListener("change", () => {
      const relation = box.getAttribute("data-relation");
      if (box.checked) state.hideRelations.delete(relation);
      else state.hideRelations.add(relation);
      refresh();
      renderPanels();
      pushHistory(true);
    });
  });

  for (const tab of tabs) {
    tab.addEventListener("click", () => setMode(tab.getAttribute("data-mode")));
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      const step =
        event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const next = tabs[(index + step + tabs.length) % tabs.length];
      next.focus();
      setMode(next.getAttribute("data-mode"));
    });
  }

  // Only one menu open at a time.
  const menus = [...document.querySelectorAll(".net-menu")];
  for (const menu of menus) {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      for (const other of menus) if (other !== menu) other.open = false;
    });
  }
  document.addEventListener("pointerdown", (event) => {
    for (const menu of menus) {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    }
  });

  $("net-zoom-in")?.addEventListener("click", () => zoomCenter(1.3));
  $("net-zoom-out")?.addEventListener("click", () => zoomCenter(1 / 1.3));
  $("net-fit")?.addEventListener("click", () => {
    userMoved = false;
    fitAll();
  });
  $("net-back")?.addEventListener("click", () => window.history.back());
  $("net-forward")?.addEventListener("click", () => window.history.forward());

  document
    .querySelectorAll(".net-attention [data-attention]")
    .forEach((chip) => {
      const key = chip.getAttribute("data-attention");
      const entry = brainRegistry(nodes, clusters)[key];
      if (!entry) return;
      const button = element(
        "button",
        { type: "button", "data-tone": chip.getAttribute("data-tone") },
        chip.textContent.trim(),
      );
      button.addEventListener("click", () =>
        select("list", key, { ids: entry.ids, title: chip.textContent.trim() }),
      );
      chip.replaceWith(button);
    });

  // Pointer input -----------------------------------------------------------------------------------
  function localPoint(event) {
    const size = box();
    return { x: event.clientX - size.left, y: event.clientY - size.top };
  }

  function targetOf(event) {
    const point = localPoint(event);
    const id = engine.hitTest(point.x, point.y);
    if (!id) return null;
    if (clusterById.has(id)) return { type: "cluster", id };
    if (nodeById.has(id)) return { type: "node", id };
    return null;
  }

  function chooseTarget(target) {
    if (!target) return select(null, null);
    if (target.type === "cluster") {
      select("cluster", target.id);
      userMoved = true;
      return frameGroup(target.id);
    }
    return select(target.type, target.id);
  }

  const pointers = new Map();
  let gesture = null;
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    hideTooltip();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    svg.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = {
        mode: "pinch",
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        moved: true,
      };
      return;
    }
    const target = targetOf(event);
    const origin = { x: event.clientX, y: event.clientY };
    if (target?.type === "node") {
      const place = nodePlace(target.id);
      const point = localPoint(event);
      const world = engine.toWorld(point.x, point.y);
      gesture = {
        mode: "node",
        target,
        start: origin,
        last: origin,
        moved: false,
        grab: { x: world.x - place.x, y: world.y - place.y },
      };
    } else {
      gesture = { mode: "pan", target, start: origin, last: origin, moved: false };
    }
    svg.classList.add("dragging");
  });

  let hoverFrame = 0;
  let hoverPoint = null;
  svg.addEventListener("pointermove", (event) => {
    if (!gesture) {
      hoverPoint = event;
      if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover);
      return;
    }
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture.mode === "pinch" && pointers.size === 2) {
      userMoved = true;
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const size = box();
      zoomAt(
        distance / (gesture.distance || distance),
        (a.x + b.x) / 2 - size.left,
        (a.y + b.y) / 2 - size.top,
      );
      gesture.distance = distance;
      return;
    }
    const dx = event.clientX - gesture.start.x;
    const dy = event.clientY - gesture.start.y;
    if (!gesture.moved && Math.hypot(dx, dy) > 4) gesture.moved = true;
    if (!gesture.moved) return;
    userMoved = true;
    if (gesture.mode === "pan") {
      engine.panBy(event.clientX - gesture.last.x, event.clientY - gesture.last.y);
      gesture.last = { x: event.clientX, y: event.clientY };
    } else if (gesture.mode === "node") {
      // Dragging only tidies the picture; it never changes a record. Let go and it settles back.
      const point = localPoint(event);
      const world = engine.toWorld(point.x, point.y);
      engine.pin(gesture.target.id, world.x - gesture.grab.x, world.y - gesture.grab.y);
    }
  });

  function endGesture(event) {
    pointers.delete(event.pointerId);
    if (!gesture) return;
    const finished = gesture;
    if (pointers.size === 0) {
      gesture = null;
      svg.classList.remove("dragging");
    }
    if (finished.mode === "node" && finished.moved) engine.release(finished.target.id);
    if (finished.mode !== "pinch" && !finished.moved && event.type === "pointerup") {
      chooseTarget(finished.target);
    }
  }
  svg.addEventListener("pointerup", endGesture);
  svg.addEventListener("pointercancel", endGesture);

  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      hideTooltip();
      userMoved = true;
      const point = localPoint(event);
      const speed = event.ctrlKey ? 0.012 : 0.0018;
      zoomAt(Math.exp(-event.deltaY * speed), point.x, point.y);
    },
    { passive: false },
  );

  svg.addEventListener("dblclick", (event) => {
    const target = targetOf(event);
    if (target?.type === "cluster") {
      userMoved = true;
      frameGroup(target.id);
    } else if (target?.type === "node") {
      zoomToSelection();
    }
  });

  function setHovered(id) {
    if (hovered === id) return;
    hovered = id;
    svg.style.cursor = id ? "pointer" : "";
    refresh();
  }

  function updateHover() {
    hoverFrame = 0;
    const event = hoverPoint;
    if (!event || gesture) return;
    const target = targetOf(event);
    if (target?.type === "node") {
      const id = target.id;
      setHovered(id);
      const item = nodeById.get(id);
      const states = (statesOf.get(id) ?? []).map(
        (one) => legend.states[one].label,
      );
      const owner = ownerOf(id);
      const kind =
        item.kind === "memory" && legend.memoryTypes[item.details.type]
          ? `${legend.memoryTypes[item.details.type].label} memory`
          : legend.nodes[item.kind].label;
      showTooltip(event, item.label, [
        `${kind} · ${TIER_INFO[tierOf(item.kind)].label}`,
        ...(states.length > 0 ? [states.join(" · ")] : []),
        ...(owner ? [`Owner: ${nodeById.get(owner)?.label ?? ""}`] : []),
        `${plural((edgesOf.get(id) ?? []).length, "connection", "connections")} · ${clusterById.get(item.clusterId)?.name ?? ""}`,
      ]);
      return;
    }
    setHovered(null);
    if (target?.type === "cluster") {
      svg.style.cursor = "pointer";
      showTooltip(event, clusterById.get(target.id).name, clusterLines(target.id));
      return;
    }
    hideTooltip();
  }
  svg.addEventListener("pointerleave", () => {
    hoverPoint = null;
    setHovered(null);
    hideTooltip();
  });

  // Keyboard ----------------------------------------------------------------------------------------
  svg.setAttribute("tabindex", "0");
  svg.addEventListener("keydown", (event) => {
    const direction = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    }[event.key];
    if (selected?.type === "node" && direction) {
      // Arrow keys walk to the nearest visible node in that direction.
      event.preventDefault();
      const from = nodePlace(selected.id);
      if (!from) return;
      const candidates = [...visible.nodes]
        .filter((id) => id !== selected.id)
        .map((id) => ({ id, ...nodePlace(id) }))
        .filter((place) => Number.isFinite(place.x));
      const next = nearestInDirection(from, candidates, direction);
      if (next) {
        select("node", next, { history: "replace" });
        const place = nodePlace(next);
        const screen = engine.toScreen(place.x, place.y);
        const size = engine.size;
        if (screen.x < 60 || screen.y < 60 || screen.x > size.width - 60 || screen.y > size.height - 60)
          centerOn(place.x, place.y, view.k);
      }
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && hovered) {
      event.preventDefault();
      select("node", hovered, { center: true });
      return;
    }
    const pan = {
      ArrowLeft: [60, 0],
      ArrowRight: [-60, 0],
      ArrowUp: [0, 60],
      ArrowDown: [0, -60],
    }[event.key];
    if (pan) {
      event.preventDefault();
      userMoved = true;
      engine.panBy(pan[0], pan[1]);
    }
  });


  function typingIn(target) {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable
    );
  }

  document.addEventListener("keydown", (event) => {
    const typing = typingIn(event.target);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
      return;
    }
    if (event.key === "Escape") {
      if (results && !results.hidden) return closeSearch();
      const menu = document.querySelector(".net-menu[open]");
      if (menu) {
        menu.removeAttribute("open");
        menu.querySelector("summary")?.focus();
        return;
      }
      if (typing) return;
      if (trace || state.impact) {
        trace = null;
        state.impact = false;
        refresh();
        renderDetails();
        return;
      }
      if (selected) select(null, null);
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (key === "/") {
      event.preventDefault();
      openSearch();
    } else if (key === "?") {
      const menu = $("net-keys-menu");
      if (menu) menu.open = !menu.open;
    } else if (key === "[") {
      window.history.back();
    } else if (key === "]") {
      window.history.forward();
    } else if (["1", "2", "3", "4"].includes(key)) {
      setMode(MODES[Number(key) - 1]);
    } else if (
      state.mode !== "network" &&
      !["f", "F", "i", "I", "p", "P"].includes(key)
    ) {
      return;
    } else if (key === "f" || key === "F") {
      toggleIsolate();
    } else if (key === "i" || key === "I") {
      toggleImpact();
    } else if (key === "p" || key === "P") {
      if (selected?.type === "node") togglePin(selected.id);
    } else if (key === "h" || key === "H") {
      setPeople(!state.people);
    } else if (key === "z" || key === "Z") {
      zoomToSelection();
    } else if (key === "0") {
      userMoved = false;
      fitAll();
    } else if (key === "+" || key === "=") {
      zoomCenter(1.25);
    } else if (key === "-" || key === "_") {
      zoomCenter(0.8);
    }
  });

  // Search and commands ---------------------------------------------------------------------------
  const themeButton = (value) =>
    document.querySelector(`.theme-switch button[value="${value}"]`);
  function commands() {
    const list = [
      {
        id: "mode-network",
        label: "Show the network",
        run: () => setMode("network"),
      },
      {
        id: "mode-timeline",
        label: "Show the timeline",
        run: () => setMode("timeline"),
      },
      {
        id: "mode-trace",
        label: "Show the AI trace",
        run: () => setMode("trace"),
      },
      {
        id: "mode-table",
        label: "Show the table",
        run: () => setMode("table"),
      },
      {
        id: "fit",
        label: "Fit everything",
        run: () => ((userMoved = false), fitAll()),
      },
      {
        id: "people",
        label: state.people
          ? "Hide people and agent accounts"
          : "Show people and agent accounts",
        run: () => setPeople(!state.people),
      },
      {
        id: "isolate",
        label: state.isolate
          ? "Show everything again"
          : "Only what connects to the selection",
        run: toggleIsolate,
      },
      {
        id: "edge-labels",
        label: state.flow
          ? "Hide connection labels"
          : "Show connection labels",
        run: () => {
          state.flow = !state.flow;
          syncControls();
          scheduleLabels();
          saveWorkspace();
        },
      },
      {
        id: "save",
        label: "Save this view…",
        run: () => {
          const menu = $("net-views-menu");
          if (menu) menu.open = true;
          $("net-view-name")?.focus();
        },
      },
      {
        id: "copy",
        label: "Copy a link to this view",
        run: () => $("net-copy-link")?.click(),
      },
      {
        id: "org",
        label: `Open the ${data.organization.name} page`,
        run: () => window.location.assign(`/orgs/${data.organization.id}`),
      },
      {
        id: "theme-dark",
        label: "Use the dark theme",
        run: () => themeButton("dark")?.click(),
      },
      {
        id: "theme-light",
        label: "Use the light theme",
        run: () => themeButton("light")?.click(),
      },
      {
        id: "theme-system",
        label: "Match this computer's theme",
        run: () => themeButton("system")?.click(),
      },
    ];
    if (selected?.type === "node") {
      const node = nodeById.get(selected.id);
      list.unshift(
        {
          id: "impact",
          label: `What depends on ${shortLabel(node.label)}`,
          run: toggleImpact,
        },
        {
          id: "provenance",
          label: `Where ${shortLabel(node.label)} came from`,
          run: () => showProvenance(node.id),
        },
        {
          id: "pin",
          label: state.pins.includes(node.id)
            ? "Unpin the selection"
            : "Pin the selection to compare",
          run: () => togglePin(node.id),
        },
        { id: "zoom", label: "Zoom to the selection", run: zoomToSelection },
      );
    }
    if (state.pins.length > 0)
      list.push({
        id: "unpin",
        label: "Unpin everything",
        run: () => {
          state.pins = [];
          refresh();
          renderDetails();
        },
      });
    return list.map((command, index) => ({
      ...command,
      type: "command",
      rank: 100 + index,
      keywords: "command",
    }));
  }

  function searchable() {
    return [
      ...nodes.map((node) => ({
        id: node.id,
        type: "node",
        label: node.label,
        keywords: `${legend.nodes[node.kind].label} ${TIER_INFO[tierOf(node.kind)].label} ${node.details.type ?? ""} ${clusterById.get(node.clusterId)?.name ?? ""} ${node.details.ownerName ?? ""}`,
        rank: node.status === "retired" ? 2 : 0,
        hint: `${legend.nodes[node.kind].label} · ${clusterById.get(node.clusterId)?.name ?? ""}`,
        iconKind: node.status === "retired" ? "retired" : node.kind,
        memoryType: node.details.type,
      })),
      ...clusters.map((cluster) => ({
        id: cluster.id,
        type: "cluster",
        label: cluster.name,
        keywords: `group ${legend.levels[cluster.level].label}`,
        rank: 1,
        hint: legend.levels[cluster.level].label,
        iconKind: "group",
      })),
    ];
  }

  let options = [];
  let activeOption = -1;
  function openSearch() {
    search?.focus();
    search?.select();
    showResults();
  }

  function closeSearch() {
    if (!results || !search) return;
    results.hidden = true;
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
  }

  function run(option) {
    closeSearch();
    if (!option) return;
    // Leave the search box, so single-key shortcuts such as P and F work next.
    search?.blur();
    if (search) search.value = "";
    if (option.type === "command") return option.run();
    if (
      state.mode !== "network" &&
      state.mode !== "table" &&
      state.mode !== "timeline"
    )
      setMode("network");
    select(option.type, option.id, { center: true });
    if (state.mode === "network" && option.type === "node") {
      nodeElements.get(option.id)?.group.focus({ preventScroll: true });
    } else {
      svg.focus({ preventScroll: true });
    }
  }

  function showResults() {
    if (!search || !results) return;
    const text = search.value;
    const found = text.trim() === "" ? [] : searchItems(text, searchable(), 8);
    const matchingCommands =
      text.trim() === ""
        ? commands().slice(0, 6)
        : searchItems(text, commands(), 5);
    options = [...found, ...matchingCommands];
    results.replaceChildren();
    if (found.length > 0)
      results.append(
        element(
          "li",
          { class: "net-results-head", role: "presentation" },
          "In this network",
        ),
      );
    if (text.trim() !== "" && found.length === 0) {
      results.append(
        element(
          "li",
          { class: "net-results-head", role: "presentation" },
          "Nothing you can see matches",
        ),
      );
    }
    options.forEach((option, index) => {
      if (index === found.length && matchingCommands.length > 0) {
        results.append(
          element(
            "li",
            { class: "net-results-head", role: "presentation" },
            "Commands",
          ),
        );
      }
      const li = element("li", {
        role: "option",
        id: `net-option-${index}`,
        "aria-selected": "false",
      });
      if (option.type !== "command")
        li.append(icon(option.iconKind, option.memoryType));
      li.append(element("span", {}, option.label));
      if (option.hint) li.append(element("small", {}, option.hint));
      li.addEventListener("pointerdown", (event) => event.preventDefault());
      li.addEventListener("click", () => run(option));
      results.append(li);
    });
    activeOption = options.length > 0 && text.trim() !== "" ? 0 : -1;
    highlightOption();
    results.hidden = options.length === 0 && text.trim() === "";
    search.setAttribute("aria-expanded", results.hidden ? "false" : "true");
  }

  function highlightOption() {
    if (!results || !search) return;
    results.querySelectorAll("[role=option]").forEach((li, index) => {
      li.setAttribute(
        "aria-selected",
        index === activeOption ? "true" : "false",
      );
    });
    if (activeOption >= 0) {
      search.setAttribute(
        "aria-activedescendant",
        `net-option-${activeOption}`,
      );
      $(`net-option-${activeOption}`)?.scrollIntoView({ block: "nearest" });
    } else {
      search.removeAttribute("aria-activedescendant");
    }
  }

  search?.addEventListener("input", showResults);
  search?.addEventListener("focus", showResults);
  search?.addEventListener("blur", () => window.setTimeout(closeSearch, 120));
  search?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      activeOption = (activeOption + step + options.length) % options.length;
      highlightOption();
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(options[activeOption] ?? options[0]);
    }
  });

  // Start ---------------------------------------------------------------------------------------------
  const params = new URLSearchParams(window.location.search);
  const hasQuery = [...params.keys()].length > 0;
  const stored = loadWorkspace(!hasQuery);
  const initial = decodeViewState(window.location.search, known);
  const asked = params.get("node");
  missingLink = asked !== null && initial.node === null;
  if (!hasQuery && stored?.mode) initial.mode = stored.mode;
  if (stored?.filters) Object.assign(initial, stored.filters);
  if (
    !params.has("mode") &&
    !stored?.mode &&
    window.matchMedia("(max-width: 40rem)").matches
  ) {
    initial.mode = "table";
  }
  syncControls();
  applyState(initial, { animate: false });
  window.history.replaceState(
    { net: 0 },
    "",
    urlFor(encodeViewState(viewState())),
  );
  updateNavButtons();
  renderSavedViews();
  new ResizeObserver(() => {
    engine.resize();
    if (!userMoved) fitAll(false);
  }).observe(svg);
  $("net-inspector-toggle")?.addEventListener("click", () => {
    const inspector = $("net-inspector");
    if (!inspector) return;
    const collapsed = inspector.classList.toggle("collapsed");
    $("net-inspector-toggle").setAttribute("aria-expanded", collapsed ? "false" : "true");
  });
  document.body.classList.add("js-ready");
}


const source = document.getElementById("network-data");
if (source) {
  try {
    start(JSON.parse(source.textContent ?? "{}"));
  } catch (error) {
    document.getElementById("network")?.classList.remove("ready");
    const head = document.querySelector(".net-head");
    const message = document.createElement("p");
    message.className = "error";
    message.textContent =
      "The diagram could not be drawn. The same network is listed below.";
    head?.append(message);
    const listing = document.getElementById("net-list");
    if (listing) listing.open = true;
    document.body.classList.remove("js-ready");
    console.error(error);
  }
}
