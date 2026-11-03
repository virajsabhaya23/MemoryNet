// Pure helpers for "Your network", shared by the server and the page's script: the drawing budgets,
// and the graph builder that turns what you may see into the network graph-engine.js draws on a canvas.
import { ICON_GLYPHS } from "./icons.js";
import { seedPositions } from "./graph-engine.js";

/** Projects drawn at first; past it, only the ones you have a role in show until you open their unit. */
export const PLACE_BUDGET = 160;
/** Business units drawn; past it, the rest are listed under one "more" node. */
export const UNIT_BUDGET = 60;
/** Most knowledge items or projects drawn for one opened place. */
export const OPEN_BUDGET = 40;
/** Most places open at once; opening one more closes the oldest. */
export const OPEN_LIMIT = 3;
const TAU = Math.PI * 2;

// The canvas map ---------------------------------------------------------------------------------

/** The viewer's own node, at the middle of the map. */
export const YOU = "you";
/** Your own roles: the bright lines straight from you, and you. */
export const ACCENT = Object.freeze({ dark: "#8dbbff", light: "#0861cf" });
/** The canvas behind everything, the same as graph-engine.js draws, for dimming colours toward it. */
const BACKDROP = { dark: "#111722", light: "#f7fafc" };

/** Colours by kind, the same as on the full network map. Darker variants for the light theme. */
export const PALETTE = Object.freeze({
  dark: Object.freeze({
    organization: "#c6d6ee",
    business_unit: "#acb7e7",
    project: "#90b6ff",
    rule: "#acb7e7",
    instruction: "#b2bfdc",
    skill: "#dbc186",
    agent: "#9bbcdf",
    memory: "#90b6ff",
    source: "#8dbbff",
    more: "#acbfd9",
  }),
  light: Object.freeze({
    organization: "#536c8e",
    business_unit: "#5968a8",
    project: "#215dc6",
    rule: "#5968a8",
    instruction: "#536c8e",
    skill: "#896518",
    agent: "#3d6a98",
    memory: "#215dc6",
    source: "#21766d",
    more: "#536c8e",
  }),
});
/** Sizes as on the full network map; hubs grow a little with what they hold. */
export const YOU_RADIUS = 21;
export const HUB_RADIUS = Object.freeze({
  organization: 17,
  business_unit: 12.5,
  project: 9.5,
});
export const NODE_RADIUS = Object.freeze({
  agent: 9,
  skill: 8,
  rule: 8,
  instruction: 7.5,
  memory: 5.6,
  source: 3.8,
  more: 6.5,
});
/** How far apart a connection holds its two ends, by what it means. */
const LINK_DISTANCE = {
  cites: 14,
  based_on: 34,
  uses: 46,
  follows: 54,
  hands_off_to: 52,
};
/** How far your role lines reach, so they barely pull on the picture. */
const ACCESS_DISTANCE = { organization: 64, business_unit: 200, project: 320 };
/** Places with no role of yours are drawn this much toward the background. */
const INSIDE_DIM = 0.45;

/** White signs drawn on each node, in a box from -10 to 10, the same as on the full map. */
export const GLYPHS = Object.freeze({ ...ICON_GLYPHS, you: ICON_GLYPHS.person, more: ICON_GLYPHS.plus });

/** Mixes a "#rrggbb" colour toward another by t in [0, 1], as "#rrggbb" (the engine reads hex). */
export function mixHex(hex, other, t) {
  const parse = (value) =>
    [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
  const a = parse(hex);
  const b = parse(other);
  return `#${a
    .map((v, i) =>
      Math.round(v + ((b[i] ?? v) - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function placeColor(place, theme) {
  const palette = PALETTE[theme];
  const color = palette[place.level] ?? palette.project;
  return place.access === "inside"
    ? mixHex(color, BACKDROP[theme], INSIDE_DIM)
    : color;
}

/** The colour of any node for a theme, so the page can repaint without rebuilding. */
export function colorOf(node, theme) {
  const palette = PALETTE[theme === "light" ? "light" : "dark"];
  const name = theme === "light" ? "light" : "dark";
  if (node.kind === "you") return ACCENT[name];
  if (node.place) return placeColor(node.place, name);
  return palette[node.kind] ?? palette.memory;
}

/** Projects drawn under a business unit: the ones drawn at first, then any its opening brought. */
export function projectsOf(unitId, kids, opened) {
  const ids = [...(kids[unitId] ?? [])];
  for (const child of opened.get(unitId)?.children ?? []) {
    if (!ids.includes(child.id)) ids.push(child.id);
  }
  return ids;
}

/**
 * The network to draw: you in the middle; the organization, its business units and projects as
 * hubs; whatever opened places hold gathered around them; a bright line from you to every place
 * where you have a role of your own. `places` maps place IDs to what the server said about them.
 */
export function buildGraph({
  org,
  tops,
  kids,
  places,
  opened,
  listedCount = 0,
  theme = "dark",
}) {
  const nodes = [];
  const links = [];
  const parentOf = new Map();
  const accent = ACCENT[theme === "light" ? "light" : "dark"];
  const add = (node) => {
    nodes.push(node);
    if (node.group !== null) parentOf.set(node.id, node.group);
    return node;
  };
  const you = add({
    id: YOU,
    group: null,
    hub: true,
    fixed: true,
    kind: "you",
    depth: 0,
    label: "You",
    r: YOU_RADIUS,
    weight: 1000,
    glyph: GLYPHS.you,
  });
  const hubs = [];
  const addPlace = (id, group, depth) => {
    const place = places.get(id);
    if (!place) return null;
    const hub = add({
      id,
      group,
      hub: true,
      kind: place.level,
      depth,
      label: `${place.name ?? place.title}${place.suffix ?? ""}`,
      r:
        (HUB_RADIUS[place.level] ?? 9.5) +
        Math.min(Math.sqrt(place.total ?? 0) * 0.35, 9),
      weight: place.total ?? 0,
      place,
    });
    hubs.push(hub);
    return hub;
  };
  const addItems = (placeId) => {
    const contents = opened.get(placeId);
    if (!contents) return;
    for (const item of contents.items ?? []) {
      add({
        id: item.id,
        group: placeId,
        hub: false,
        kind: item.kind,
        family: item.family,
        label: item.label,
        r: NODE_RADIUS[item.kind] ?? 6,
        weight: 0,
        labelAt: item.family === "work" ? 5 : 8,
        glyph: GLYPHS[item.kind] ?? GLYPHS.memory,
        badge: item.owned ? accent : null,
        item,
      });
    }
    if ((contents.more ?? 0) > 0) {
      add({
        id: `more:${placeId}`,
        group: placeId,
        hub: false,
        kind: "more",
        label: `${contents.more} more`,
        r: NODE_RADIUS.more,
        weight: 0,
        labelAt: 6,
        glyph: GLYPHS.more,
      });
    }
  };
  if (!addPlace(org, YOU, 1)) return { nodes, links, parentOf };
  addItems(org);
  for (const top of tops) {
    if (top.startsWith("more:")) {
      add({
        id: top,
        group: org,
        hub: false,
        kind: "more",
        label: `${listedCount} more business units`,
        r: NODE_RADIUS.more + 2,
        weight: 0,
        labelAt: 4,
        glyph: GLYPHS.more,
      });
      continue;
    }
    if (!addPlace(top, org, 2)) continue;
    addItems(top);
    for (const project of projectsOf(top, kids, opened)) {
      if (addPlace(project, top, 3)) addItems(project);
    }
  }
  // How much is drawn under each hub, so busy hubs keep more room around them.
  const under = new Map();
  for (const node of nodes) {
    let step = node.group;
    while (step !== null && step !== undefined) {
      under.set(step, (under.get(step) ?? 0) + 1);
      step = parentOf.get(step);
    }
  }
  const drawn = new Set(nodes.map((node) => node.id));
  // You are inside the organization even without a role there: an unseen line keeps it close.
  links.push({
    id: `you:${org}`,
    source: org,
    target: YOU,
    structure: true,
    hidden: true,
    distance: 64,
    strength: 0.8,
  });
  for (const node of nodes) {
    if (node === you || node.group === null) continue;
    if (node.hub) {
      if (node.group !== YOU) {
        links.push({
          id: `hub:${node.id}`,
          source: node.id,
          target: node.group,
          structure: true,
          distance: 70 + Math.sqrt(under.get(node.id) ?? 0) * 9,
          strength: 0.5,
        });
      }
      // Business units also hang around you, so the map spreads out on every side of you.
      if (node.kind === "business_unit") {
        links.push({
          id: `around:${node.id}`,
          source: node.id,
          target: YOU,
          structure: true,
          hidden: true,
          distance: 150 + Math.sqrt(under.get(node.id) ?? 0) * 12,
          strength: 0.25,
        });
      }
      if (node.place?.access === "direct") {
        links.push({
          id: `access:${node.id}`,
          source: YOU,
          target: node.id,
          structure: true,
          access: true,
          color: accent,
          distance: ACCESS_DISTANCE[node.kind] ?? 300,
          strength: 0.04,
        });
      }
    } else {
      links.push({
        id: `in:${node.id}`,
        source: node.id,
        target: node.group,
        structure: true,
        distance: 26 + (node.r ?? 6) * 2,
        strength: 0.16,
      });
    }
  }
  const seen = new Set();
  for (const contents of opened.values()) {
    for (const relation of contents.links ?? []) {
      const id = `rel:${relation.from}>${relation.to}`;
      if (seen.has(id) || !drawn.has(relation.from) || !drawn.has(relation.to))
        continue;
      seen.add(id);
      links.push({
        id,
        source: relation.from,
        target: relation.to,
        relation: relation.relation,
        distance: LINK_DISTANCE[relation.relation] ?? 40,
        strength: 0.7,
      });
    }
  }
  for (const node of nodes) node.color = colorOf(node, theme);
  return { nodes, links, parentOf };
}

/**
 * Where the first picture starts: you at the middle, its business units all the way around you, and
 * the organization beside you in the widest gap between them, so you sit at the center of everything.
 */
export function firstPositions(nodes, org) {
  const rest = nodes
    .filter((node) => node.id !== YOU)
    .map((node) => (node.id === org ? { ...node, group: null } : node));
  const seeds = seedPositions(rest);
  const around = rest
    .filter((node) => node.hub && node.group === org)
    .map((node) => seeds.get(node.id))
    .filter((p) => p !== undefined);
  let angle = -Math.PI / 2;
  let reach = Infinity;
  if (around.length > 0) {
    const angles = around.map((p) => Math.atan2(p.y, p.x)).sort((a, b) => a - b);
    let widest = -1;
    angles.forEach((a, index) => {
      const next = angles[(index + 1) % angles.length] ?? a;
      const gap = (next - a + TAU) % TAU || TAU;
      if (gap > widest) {
        widest = gap;
        angle = a + gap / 2;
      }
    });
    reach = Math.min(...around.map((p) => Math.hypot(p.x, p.y)));
  }
  const distance = Math.min(YOU_RADIUS + HUB_RADIUS.organization + 52, reach * 0.55);
  const dx = Math.cos(angle) * distance;
  const dy = Math.sin(angle) * distance;
  for (const node of rest) {
    if (node.id !== org && (node.hub || node.group !== org)) continue;
    const p = seeds.get(node.id);
    if (p) seeds.set(node.id, { x: p.x + dx, y: p.y + dy });
  }
  seeds.set(YOU, { x: 0, y: 0 });
  return seeds;
}

/** The way from you to a node: the node, the hubs it sits in, and you. */
export function chainOf(parentOf, id) {
  const chain = [id];
  let step = id;
  for (let depth = 0; parentOf.has(step) && depth < 64; depth += 1) {
    step = parentOf.get(step);
    chain.push(step);
  }
  if (!chain.includes(YOU)) chain.push(YOU);
  return chain;
}

/**
 * What lights up for a node: its way from you (with the role line it comes through) and everything
 * it touches. For you, your role lines and the places they reach.
 */
export function focusOf(graph, id) {
  const near = new Set([id]);
  const edges = new Set();
  const chain = new Set(chainOf(graph.parentOf, id));
  for (const link of graph.links) {
    if (link.hidden) continue;
    const touches = link.source === id || link.target === id;
    const onChain = chain.has(link.source) && chain.has(link.target);
    if (id === YOU ? link.access === true : touches || onChain) {
      edges.add(link.id);
      near.add(link.source);
      near.add(link.target);
    }
  }
  for (const step of chain) near.add(step);
  return { near, edges };
}

/** Opens one more place, closing the oldest ones not on its way from you, to stay within `limit`. */
export function closeForRoom(order, keep, limit) {
  const left = [...order];
  const closed = [];
  while (left.length >= limit) {
    const oldest = left.find((id) => !keep.has(id));
    if (oldest === undefined) break;
    left.splice(left.indexOf(oldest), 1);
    closed.push(oldest);
  }
  return closed;
}
