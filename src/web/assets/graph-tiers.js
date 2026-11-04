// Pure tier logic for the Cobalt graph: which nodes are dots, chips, or cards at a
// given zoom, what shape each kind draws as, card meta lines, and territory hulls.
// No DOM, so tests call these directly (same pattern as network-view.js).

export const TIER_ZOOM_MID = 0.45;
export const TIER_ZOOM_NEAR = 1.1;
export const MAX_CARDS = 60;

export function tierForZoom(k) {
  if (k < TIER_ZOOM_MID) return "far";
  if (k < TIER_ZOOM_NEAR) return "mid";
  return "near";
}

const SHAPES = Object.freeze({
  memory: "circle",
  source: "diamond",
  rule: "triangle",
  instruction: "square",
  skill: "hexagon",
  agent: "pentagon",
  person: "ring",
  agent_account: "double-ring",
});

export function kindShape(kind) {
  return SHAPES[kind] ?? "circle";
}

const PROMOTE = Object.freeze({ far: "mid", mid: "near", near: "near" });

/**
 * Assigns a tier to every item. Out-of-viewport items are always far. Selected,
 * hovered, and pinned items are promoted one tier. Near-tier cards are capped at
 * MAX_CARDS by priority (selection first); overflow falls back to mid.
 */
export function assignTiers(items, k) {
  const base = tierForZoom(k);
  const tiers = new Map();
  const nearCandidates = [];
  for (const item of items) {
    if (item.inViewport === false) {
      tiers.set(item.id, "far");
      continue;
    }
    let tier = base;
    if (item.selected || item.hovered || item.pinned) tier = PROMOTE[tier];
    tiers.set(item.id, tier);
    if (tier === "near") nearCandidates.push(item);
  }
  if (nearCandidates.length > MAX_CARDS) {
    nearCandidates.sort((a, b) =>
      Number(b.selected ?? false) - Number(a.selected ?? false) ||
      (b.priority ?? 0) - (a.priority ?? 0) ||
      (a.id < b.id ? -1 : 1));
    for (const item of nearCandidates.slice(MAX_CARDS)) tiers.set(item.id, "mid");
  }
  return tiers;
}

/** Word-wraps a title into at most maxLines lines of maxChars, ellipsizing overflow. */
export function wrapTitle(text, maxChars = 26, maxLines = 2) {
  const words = String(text ?? "").split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [""];
  const lines = [];
  let line = "";
  let overflow = false;
  const full = () => lines.length >= maxLines;
  for (const word of words) {
    let rest = word;
    // Hard-split words longer than a whole line.
    while (rest.length > maxChars) {
      if (line !== "") { lines.push(line); line = ""; }
      if (full()) { overflow = true; rest = ""; break; }
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    if (rest === "") continue;
    if (overflow) break;
    if (line === "") {
      if (full()) { overflow = true; break; }
      line = rest;
    } else if (line.length + 1 + rest.length <= maxChars) {
      line += ` ${rest}`;
    } else {
      lines.push(line);
      line = "";
      if (full()) { overflow = true; break; }
      line = rest;
    }
  }
  if (line !== "" && !full()) lines.push(line);
  else if (line !== "") overflow = true;
  const shown = lines.slice(0, maxLines);
  if (overflow && shown.length > 0) {
    const last = shown[shown.length - 1];
    shown[shown.length - 1] = `${last.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return shown;
}

function ageLabel(value, nowIso) {
  if (!value) return null;
  const then = value instanceof Date ? value.getTime() : Date.parse(value);
  const now = nowIso instanceof Date ? nowIso.getTime() : Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The one-line card summary for a node, from the details the payload already carries. */
export function cardMeta(node, citedBy, nowIso) {
  const details = node?.details ?? {};
  const parts = [];
  const add = (value) => { if (value !== null && value !== undefined && String(value).trim() !== "") parts.push(String(value)); };
  if (node?.kind === "memory") {
    add(details.ownerName);
    if (typeof details.evidenceCount === "number") add(`${details.evidenceCount} ${details.evidenceCount === 1 ? "source" : "sources"}`);
    else if (citedBy > 0) add(`${citedBy} citing`);
    add(ageLabel(details.approvedAt, nowIso));
  } else if (node?.kind === "source") {
    add(details.repository ?? details.reference);
    add(ageLabel(details.capturedAt, nowIso));
  } else if (node?.kind === "person" || node?.kind === "agent_account") {
    add(details.displayName);
  } else {
    add(details.ownerName);
    add(details.scopeName);
    add(ageLabel(details.approvedAt, nowIso));
  }
  return parts.join(" · ");
}

/** Monotonic-chain convex hull; fewer than 3 points come back as-is. */
export function convexHull(points) {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const build = (list) => {
    const hull = [];
    for (const point of list) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop();
      hull.push(point);
    }
    return hull;
  };
  const lower = build(sorted);
  const upper = build([...sorted].reverse());
  // Drop each chain's last point: it is the other chain's first.
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
