// Pure helpers for the prompt anatomy stage. The server draws the stage with them, and the page's
// script times the assembly with them. They only use numbers and labels the page already shows.

export const STAGES = Object.freeze({
  wide: Object.freeze({ width: 1000, height: 420 }),
  tall: Object.freeze({ width: 420, height: 960 }),
});
export const NODE_R = 30;
export const SATELLITE_R = 8;
export const SATELLITE_ORBIT = 74;
/** Degrees between neighbouring satellites. */
export const SATELLITE_SPREAD = 26;
export const MAX_SATELLITES = 6;

/** Milliseconds. The stylesheet's [data-at] delays and .pa-clock use the same numbers. */
export const TIMING = Object.freeze({ start: 500, step: 900, light: 650 });

const OUTWARD = { up: -90, down: 90, left: 180, right: 0 };

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Where each block sits: a zigzag from left to right on wide screens, and from top to bottom on
 * narrow ones. `out` points away from the zigzag, where a block's linked records go.
 */
export function blockSpots(count, orientation) {
  const { width, height } = STAGES[orientation];
  const spots = [];
  for (let index = 0; index < count; index += 1) {
    const t = count === 1 ? 0.5 : index / (count - 1);
    const even = index % 2 === 0;
    if (orientation === "wide") {
      spots.push({
        x: round1(width * (0.09 + 0.82 * t)),
        y: round1(height * (even ? 0.65 : 0.31)),
        out: even ? "down" : "up",
      });
    } else {
      spots.push({
        x: round1(width * (even ? 0.3 : 0.7)),
        y: round1(height * (0.085 + 0.83 * t)),
        out: even ? "left" : "right",
      });
    }
  }
  return spots;
}

/** A smooth curve from one block's edge to the next block's edge. */
export function linkPath(a, b, orientation) {
  if (orientation === "wide") {
    const x1 = round1(a.x + NODE_R);
    const x2 = round1(b.x - NODE_R);
    const bend = round1((x2 - x1) / 2);
    return `M${x1} ${a.y} C${round1(x1 + bend)} ${a.y} ${round1(x2 - bend)} ${b.y} ${x2} ${b.y}`;
  }
  const y1 = round1(a.y + NODE_R);
  const y2 = round1(b.y - NODE_R);
  const bend = round1((y2 - y1) / 2);
  return `M${a.x} ${y1} C${a.x} ${round1(y1 + bend)} ${b.x} ${round1(y2 - bend)} ${b.x} ${y2}`;
}

/** Linked records fan out on the outer side of their block, each with a line to its edge. */
export function satelliteSpots(spot, count) {
  const shown = Math.min(Math.max(count, 0), MAX_SATELLITES);
  const spots = [];
  for (let index = 0; index < shown; index += 1) {
    const degrees =
      OUTWARD[spot.out] + (index - (shown - 1) / 2) * SATELLITE_SPREAD;
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const at = (radius) => ({
      x: round1(spot.x + radius * cos),
      y: round1(spot.y + radius * sin),
    });
    const center = at(SATELLITE_ORBIT);
    const from = at(NODE_R + 4);
    const to = at(SATELLITE_ORBIT - SATELLITE_R - 3);
    spots.push({
      x: center.x,
      y: center.y,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    });
  }
  return spots;
}

/** Where "+3" goes when a block links more records than the stage draws. */
export function moreSpot(spot) {
  const radians = (OUTWARD[spot.out] * Math.PI) / 180;
  const radius = SATELLITE_ORBIT + SATELLITE_R + 16;
  return {
    x: round1(spot.x + radius * Math.cos(radians)),
    y: round1(spot.y + radius * Math.sin(radians) + 4),
  };
}

/** A block's name and size sit on the inner side, between the rows, away from its records. */
export function labelSpot(spot) {
  switch (spot.out) {
    case "up":
      return {
        x: spot.x,
        y: round1(spot.y + NODE_R + 21),
        y2: round1(spot.y + NODE_R + 37),
        anchor: "middle",
      };
    case "down":
      return {
        x: spot.x,
        y: round1(spot.y - NODE_R - 26),
        y2: round1(spot.y - NODE_R - 10),
        anchor: "middle",
      };
    case "left":
      return {
        x: round1(spot.x + NODE_R + 14),
        y: round1(spot.y - 3),
        y2: round1(spot.y + 14),
        anchor: "start",
      };
    default:
      return {
        x: round1(spot.x - NODE_R - 14),
        y: round1(spot.y - 3),
        y2: round1(spot.y + 14),
        anchor: "end",
      };
  }
}

/** One bar per block, each as wide as its share of the tokens, with gaps between them. */
export function barSegments(values, width, gap) {
  const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0);
  const shown = values.filter((value) => value > 0).length;
  const room = width - gap * Math.max(shown - 1, 0);
  const segments = [];
  let x = 0;
  for (const value of values) {
    if (value <= 0 || total === 0) {
      segments.push({ x: round1(x), width: 0 });
      continue;
    }
    const share = (room * value) / total;
    segments.push({ x: round1(x), width: round1(share) });
    x += share + gap;
  }
  return segments;
}

/** When block `step` (1, 2, …) starts to light up, counted from the start of the assembly. */
export function stepStart(step) {
  return TIMING.start + (step - 1) * TIMING.step;
}

/** How long the whole assembly takes. */
export function assemblyLength(count) {
  return count <= 0 ? 0 : stepStart(count) + TIMING.light;
}

/** The totals once the first `step` blocks are in. */
export function totalsAt(blocks, step) {
  const upTo = Math.min(Math.max(step, 0), blocks.length);
  const totals = { step: upTo, tokens: 0, passed: 0, records: 0 };
  for (const block of blocks.slice(0, upTo)) {
    totals.tokens += block.tokens;
    totals.passed += block.passed;
    totals.records += block.records;
  }
  return totals;
}

function easeOut(progress) {
  return 1 - (1 - progress) ** 3;
}

/**
 * What the dashboard shows `ms` after the assembly started: tokens climb while each block lights
 * up, and its checks and records count once it is halfway lit. Never goes down as time passes.
 */
export function frameAt(blocks, ms) {
  const frame = { step: 0, tokens: 0, passed: 0, records: 0, done: false };
  blocks.forEach((block, index) => {
    const begin = stepStart(index + 1);
    if (ms < begin) return;
    const progress = Math.min((ms - begin) / TIMING.light, 1);
    frame.step = index + 1;
    frame.tokens += Math.round(block.tokens * easeOut(progress));
    if (progress >= 0.5) {
      frame.passed += block.passed;
      frame.records += block.records;
    }
  });
  frame.done = blocks.length === 0 || ms >= assemblyLength(blocks.length);
  return frame;
}

/** "1,234". */
export function formatCount(value) {
  return Math.round(value).toLocaleString("en-US");
}

/** "01", the number on a block. */
export function stepNumber(step) {
  return String(step).padStart(2, "0");
}
