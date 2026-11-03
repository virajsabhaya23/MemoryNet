// MemoryNet graph engine: a force-directed network drawn on a canvas, with no outside libraries.
// The top half is pure (seeding, simulation, label placement) and runs in Node for tests; the
// bottom half draws on a canvas in the browser. It only ever sees what the page already holds.

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** A stable number in [0, 1) for a piece of text, so the same data always lands the same way. */
export function hashUnit(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619) >>> 0;
  }
  return value / 4294967296;
}

// Seeding ----------------------------------------------------------------------------------------

/**
 * Starting positions: hubs as a radial tree (the root at the center, each child in a slice sized
 * by how much it holds), and every member in a sunflower spiral around its hub. The simulation
 * only has to tidy this, so the picture settles quickly and the same data gives the same map.
 */
export function seedPositions(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map();
  const members = new Map();
  const roots = [];
  for (const node of nodes) {
    const parent = node.group !== null && byId.has(node.group) ? node.group : null;
    if (node.hub) {
      if (parent === null) roots.push(node.id);
      else {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(node.id);
      }
    } else if (parent !== null) {
      if (!members.has(parent)) members.set(parent, []);
      members.get(parent).push(node.id);
    } else {
      roots.push(node.id);
    }
  }
  const weight = new Map();
  const weigh = (id) => {
    if (weight.has(id)) return weight.get(id);
    let total = 1 + (members.get(id)?.length ?? 0);
    for (const child of children.get(id) ?? []) total += weigh(child);
    weight.set(id, total);
    return total;
  };
  for (const id of roots) weigh(id);

  const spread = (count) => 14 * Math.sqrt(count + 1);
  const positions = new Map();
  const place = (id, x, y, angle, arc, depth) => {
    positions.set(id, { x, y });
    const own = members.get(id) ?? [];
    const cloud = spread(own.length);
    own.forEach((memberId, index) => {
      const r = 18 + 14 * Math.sqrt(index + 0.5);
      const theta = index * GOLDEN_ANGLE + hashUnit(id) * TAU;
      positions.set(memberId, { x: x + r * Math.cos(theta), y: y + r * Math.sin(theta) });
    });
    const kids = (children.get(id) ?? [])
      .slice()
      .sort((a, b) => weigh(b) - weigh(a) || (a < b ? -1 : 1));
    if (kids.length === 0) return;
    const total = kids.reduce((sum, kid) => sum + weigh(kid), 0);
    let start = angle - arc / 2;
    for (const kid of kids) {
      const share = (arc * weigh(kid)) / total;
      const mid = start + share / 2;
      const distance = cloud + spread(weigh(kid)) * (depth === 0 ? 1.6 : 1.25) + 40;
      place(
        kid,
        x + distance * Math.cos(mid),
        y + distance * Math.sin(mid),
        mid,
        Math.min(share * 1.15, Math.PI * 0.9),
        depth + 1,
      );
      start += share;
    }
  };
  if (roots.length === 1) place(roots[0], 0, 0, -Math.PI / 2, TAU, 0);
  else {
    const total = roots.reduce((sum, id) => sum + weigh(id), 0) || 1;
    let start = -Math.PI / 2;
    for (const id of roots) {
      const share = (TAU * weigh(id)) / total;
      const mid = start + share / 2;
      const distance = roots.length === 1 ? 0 : spread(weigh(id)) * 1.4 + 60;
      place(id, distance * Math.cos(mid), distance * Math.sin(mid), mid, Math.min(share, Math.PI), 1);
      start += share;
    }
  }
  return positions;
}

/**
 * Starting positions for a graph that grew: every node that was already placed keeps its spot,
 * and each new one starts beside its hub (members on the outside of the hub's sunflower, new hubs
 * a step further out), so what was on screen stays put and only the new part has to settle.
 */
export function growPositions(nodes, previous) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const positions = new Map();
  for (const node of nodes) {
    const p = previous.get(node.id);
    if (p) positions.set(node.id, { x: p.x, y: p.y });
  }
  if (positions.size === nodes.length) return positions;
  // Parts with nothing placed above them are new roots: they get the ordinary layout.
  const kept = new Set(positions.keys());
  const placedAbove = (node) => {
    let step = node;
    for (let depth = 0; step && depth < 64; depth += 1) {
      if (kept.has(step.id)) return true;
      step = step.group == null ? undefined : byId.get(step.group);
    }
    return false;
  };
  // New members continue each hub's spiral after the ones already around it.
  const members = new Map();
  const hubs = new Map();
  for (const node of nodes) {
    if (!positions.has(node.id) || node.group == null) continue;
    const counts = node.hub ? hubs : members;
    counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
  }
  let fresh = null;
  const place = (node, depth) => {
    const known = positions.get(node.id);
    if (known) return known;
    const parent = node.group == null ? undefined : byId.get(node.group);
    const anchor = parent && parent !== node && depth < 64 && placedAbove(parent) ? place(parent, depth + 1) : null;
    let p;
    if (!anchor) {
      // Nothing to grow from: lay the graph out from scratch and use this node's spot.
      fresh ??= seedPositions(nodes);
      p = fresh.get(node.id) ?? { x: 0, y: 0 };
    } else if (node.hub) {
      // A new hub opens away from where its parent hangs, so it does not land on its siblings.
      const grand = parent.group == null ? null : positions.get(parent.group);
      const index = hubs.get(parent.id) ?? 0;
      hubs.set(parent.id, index + 1);
      const away = grand && (grand.x !== anchor.x || grand.y !== anchor.y)
        ? Math.atan2(anchor.y - grand.y, anchor.x - grand.x)
        : hashUnit(parent.id) * TAU;
      const angle = away + (hashUnit(node.id) - 0.5) * Math.PI * 0.9;
      const distance = 60 + (node.r ?? 9) * 3 + 10 * Math.sqrt(index);
      p = { x: anchor.x + distance * Math.cos(angle), y: anchor.y + distance * Math.sin(angle) };
    } else {
      const index = members.get(parent.id) ?? 0;
      members.set(parent.id, index + 1);
      const r = 18 + 14 * Math.sqrt(index + 0.5);
      const theta = index * GOLDEN_ANGLE + hashUnit(parent.id) * TAU;
      p = { x: anchor.x + r * Math.cos(theta), y: anchor.y + r * Math.sin(theta) };
    }
    positions.set(node.id, p);
    return p;
  };
  for (const node of nodes) place(node, 0);
  return positions;
}

// Simulation -------------------------------------------------------------------------------------

/** A quadtree over the bodies for Barnes-Hut repulsion: far groups push as one. */
function buildTree(count, xs, ys, charges, active) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i += 1) {
    if (!active[i]) continue;
    if (xs[i] < minX) minX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  if (minX === Infinity) return null;
  const size = Math.max(maxX - minX, maxY - minY, 1) + 1;
  // Cells live in flat arrays: four children, a center of charge, and a body when it is a leaf.
  const capacity = count * 4 + 8;
  const child = new Int32Array(capacity * 4).fill(-1);
  const cx = new Float64Array(capacity);
  const cy = new Float64Array(capacity);
  const charge = new Float64Array(capacity);
  const body = new Int32Array(capacity).fill(-1);
  const x0 = new Float64Array(capacity);
  const y0 = new Float64Array(capacity);
  const width = new Float64Array(capacity);
  let cells = 1;
  x0[0] = minX;
  y0[0] = minY;
  width[0] = size;
  const insert = (cell, i, depth) => {
    for (;;) {
      if (child[cell * 4] === -1 && body[cell] === -1 && charge[cell] === 0) {
        body[cell] = i;
        return;
      }
      if (body[cell] !== -1) {
        const other = body[cell];
        body[cell] = -1;
        if (depth > 40 || (xs[other] === xs[i] && ys[other] === ys[i])) {
          // Same spot: nudge instead of splitting forever.
          xs[i] += 1e-3 * (1 + (i % 7));
          ys[i] += 1e-3 * (1 + (i % 5));
        }
        placeIn(cell, other, depth);
      }
      const half = width[cell] / 2;
      const right = xs[i] >= x0[cell] + half ? 1 : 0;
      const down = ys[i] >= y0[cell] + half ? 1 : 0;
      const slot = cell * 4 + right + down * 2;
      if (child[slot] === -1) {
        if (cells >= capacity) return;
        const next = cells;
        cells += 1;
        child[slot] = next;
        x0[next] = x0[cell] + right * half;
        y0[next] = y0[cell] + down * half;
        width[next] = half;
        body[next] = i;
        return;
      }
      cell = child[slot];
      depth += 1;
    }
  };
  const placeIn = (cell, i, depth) => {
    const half = width[cell] / 2;
    const right = xs[i] >= x0[cell] + half ? 1 : 0;
    const down = ys[i] >= y0[cell] + half ? 1 : 0;
    const slot = cell * 4 + right + down * 2;
    if (child[slot] === -1) {
      if (cells >= capacity) return;
      const next = cells;
      cells += 1;
      child[slot] = next;
      x0[next] = x0[cell] + right * half;
      y0[next] = y0[cell] + down * half;
      width[next] = half;
      body[next] = i;
    } else {
      insert(child[slot], i, depth + 1);
    }
  };
  for (let i = 0; i < count; i += 1) if (active[i]) insert(0, i, 0);
  // Centers of charge, children before parents.
  const order = [];
  const stack = [0];
  while (stack.length > 0) {
    const cell = stack.pop();
    order.push(cell);
    for (let q = 0; q < 4; q += 1) {
      const next = child[cell * 4 + q];
      if (next !== -1) stack.push(next);
    }
  }
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const cell = order[index];
    if (body[cell] !== -1) {
      const i = body[cell];
      charge[cell] = charges[i];
      cx[cell] = xs[i];
      cy[cell] = ys[i];
      continue;
    }
    let total = 0;
    let sx = 0;
    let sy = 0;
    for (let q = 0; q < 4; q += 1) {
      const next = child[cell * 4 + q];
      if (next === -1) continue;
      const weight = Math.abs(charge[next]);
      total += charge[next];
      sx += cx[next] * weight;
      sy += cy[next] * weight;
    }
    charge[cell] = total;
    const abs = Math.abs(total) || 1;
    cx[cell] = sx / abs;
    cy[cell] = sy / abs;
  }
  return { child, cx, cy, charge, body, width };
}

/**
 * A force simulation in flat arrays: Barnes-Hut repulsion, springs along links, a pull toward
 * each node's hub, soft collision, and a weak pull to the middle. Deterministic for the same input.
 */
export function createSimulation({ nodes, links, positions }) {
  const count = nodes.length;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const vx = new Float64Array(count);
  const vy = new Float64Array(count);
  const radius = new Float64Array(count);
  const charges = new Float64Array(count);
  const pinned = new Uint8Array(count);
  const active = new Uint8Array(count).fill(1);
  const hubOf = new Int32Array(count).fill(-1);
  const seeds = positions ?? seedPositions(nodes);
  nodes.forEach((node, i) => {
    const seed = seeds.get(node.id) ?? {
      x: (hashUnit(node.id) - 0.5) * 400,
      y: (hashUnit(`${node.id}:y`) - 0.5) * 400,
    };
    xs[i] = seed.x;
    ys[i] = seed.y;
    radius[i] = node.r ?? 6;
    charges[i] = node.hub ? -260 - radius[i] * 18 : -34 - radius[i] * 4;
    if (node.group !== null && node.group !== undefined && !node.hub) {
      hubOf[i] = index.get(node.group) ?? -1;
    }
    // A fixed node holds its starting spot, such as the viewer at the middle of their own map.
    if (node.fixed) pinned[i] = 1;
  });
  const linkSource = [];
  const linkTarget = [];
  const linkDistance = [];
  const linkStrength = [];
  const degree = new Float64Array(count);
  for (const link of links) {
    const s = index.get(link.source);
    const t = index.get(link.target);
    if (s === undefined || t === undefined || s === t) continue;
    linkSource.push(s);
    linkTarget.push(t);
    linkDistance.push(link.distance ?? radius[s] + radius[t] + 26);
    linkStrength.push(link.strength ?? 1);
    degree[s] += 1;
    degree[t] += 1;
  }
  const L = linkSource.length;
  const strength = new Float64Array(L);
  const bias = new Float64Array(L);
  for (let l = 0; l < L; l += 1) {
    const s = linkSource[l];
    const t = linkTarget[l];
    strength[l] = linkStrength[l] / Math.min(degree[s] || 1, degree[t] || 1);
    bias[l] = degree[s] / ((degree[s] + degree[t]) || 1);
  }
  let maxRadius = 1;
  for (let i = 0; i < count; i += 1) maxRadius = Math.max(maxRadius, radius[i]);

  const sim = {
    alpha: 1,
    alphaMin: 0.002,
    alphaDecay: 1 - Math.pow(0.002, 1 / 320),
    alphaTarget: 0,
    velocityDecay: 0.42,
    theta2: 0.81,
    distanceMax2: 900 * 900,
    groupPull: 0.06,
    count,
    index,
    xs,
    ys,
    radius,
    pinned,
    active,
  };

  function repel(alpha) {
    const tree = buildTree(count, xs, ys, charges, active);
    if (!tree) return;
    const { child, cx, cy, charge, body, width } = tree;
    const stack = new Int32Array(count * 4 + 64);
    for (let i = 0; i < count; i += 1) {
      if (!active[i]) continue;
      let top = 0;
      stack[top++] = 0;
      while (top > 0) {
        const cell = stack[--top];
        if (charge[cell] === 0) continue;
        let dx = cx[cell] - xs[i];
        let dy = cy[cell] - ys[i];
        let l = dx * dx + dy * dy;
        const w = width[cell];
        const leaf = body[cell] !== -1;
        if (leaf || (w * w) / sim.theta2 < l) {
          if (leaf && body[cell] === i) continue;
          if (l >= sim.distanceMax2) continue;
          if (dx === 0) {
            dx = (hashUnit(`${i}x`) - 0.5) * 1e-6;
            l += dx * dx;
          }
          if (dy === 0) {
            dy = (hashUnit(`${i}y`) - 0.5) * 1e-6;
            l += dy * dy;
          }
          if (l < 1) l = Math.sqrt(l);
          const f = (charge[cell] * alpha) / l;
          vx[i] += dx * f;
          vy[i] += dy * f;
          continue;
        }
        for (let q = 0; q < 4; q += 1) {
          const next = child[cell * 4 + q];
          if (next !== -1) stack[top++] = next;
        }
      }
    }
  }

  function springs(alpha) {
    for (let l = 0; l < L; l += 1) {
      const s = linkSource[l];
      const t = linkTarget[l];
      if (!active[s] || !active[t]) continue;
      let dx = xs[t] + vx[t] - xs[s] - vx[s] || 1e-6;
      let dy = ys[t] + vy[t] - ys[s] - vy[s] || 1e-6;
      let d = Math.sqrt(dx * dx + dy * dy);
      d = ((d - linkDistance[l]) / d) * alpha * strength[l];
      dx *= d;
      dy *= d;
      vx[t] -= dx * bias[l];
      vy[t] -= dy * bias[l];
      vx[s] += dx * (1 - bias[l]);
      vy[s] += dy * (1 - bias[l]);
    }
  }

  function gather(alpha) {
    const k = sim.groupPull * alpha;
    for (let i = 0; i < count; i += 1) {
      const hub = hubOf[i];
      if (hub < 0 || !active[i] || !active[hub]) continue;
      vx[i] += (xs[hub] - xs[i]) * k;
      vy[i] += (ys[hub] - ys[i]) * k;
    }
    // A very weak pull to the middle keeps separate parts from drifting away.
    const c = 0.004 * alpha;
    for (let i = 0; i < count; i += 1) {
      if (!active[i]) continue;
      vx[i] -= xs[i] * c;
      vy[i] -= ys[i] * c;
    }
  }

  function collide() {
    const cell = maxRadius * 2 + 4;
    const grid = new Map();
    for (let i = 0; i < count; i += 1) {
      if (!active[i]) continue;
      const key = `${Math.floor(xs[i] / cell)},${Math.floor(ys[i] / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }
    for (let i = 0; i < count; i += 1) {
      if (!active[i]) continue;
      const gx = Math.floor(xs[i] / cell);
      const gy = Math.floor(ys[i] / cell);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          const bucket = grid.get(`${gx + ox},${gy + oy}`);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const dx = xs[j] + vx[j] - xs[i] - vx[i];
            const dy = ys[j] + vy[j] - ys[i] - vy[i];
            const min = radius[i] + radius[j] + 2;
            const l2 = dx * dx + dy * dy;
            if (l2 >= min * min) continue;
            const l = Math.sqrt(l2) || 1e-3;
            const push = ((min - l) / l) * 0.5;
            const share = radius[j] * radius[j] / (radius[i] * radius[i] + radius[j] * radius[j]);
            vx[i] -= dx * push * share;
            vy[i] -= dy * push * share;
            vx[j] += dx * push * (1 - share);
            vy[j] += dy * push * (1 - share);
          }
        }
      }
    }
  }

  sim.tick = (times = 1) => {
    for (let n = 0; n < times; n += 1) {
      sim.alpha += (sim.alphaTarget - sim.alpha) * sim.alphaDecay;
      const alpha = sim.alpha;
      repel(alpha);
      springs(alpha);
      gather(alpha);
      collide();
      const keep = 1 - sim.velocityDecay;
      for (let i = 0; i < count; i += 1) {
        if (pinned[i] || !active[i]) {
          vx[i] = 0;
          vy[i] = 0;
          continue;
        }
        vx[i] *= keep;
        vy[i] *= keep;
        xs[i] += vx[i];
        ys[i] += vy[i];
      }
    }
    return sim.alpha;
  };
  sim.running = () => sim.alpha > sim.alphaMin || sim.alphaTarget > 0;
  sim.reheat = (to = 0.3) => {
    sim.alpha = Math.max(sim.alpha, to);
  };
  sim.position = (id) => {
    const i = index.get(id);
    return i === undefined ? null : { x: xs[i], y: ys[i], r: radius[i] };
  };
  sim.pin = (id, x, y) => {
    const i = index.get(id);
    if (i === undefined) return;
    pinned[i] = 1;
    xs[i] = x;
    ys[i] = y;
  };
  sim.release = (id) => {
    const i = index.get(id);
    if (i !== undefined) pinned[i] = 0;
  };
  /** Bodies left out (hidden kinds) stop pushing and being pushed, so the rest closes the gap. */
  sim.setActive = (ids) => {
    for (let i = 0; i < count; i += 1) active[i] = ids.has(nodes[i].id) ? 1 : 0;
  };
  /** Runs until settled or the budget is spent. Returns the ticks used. */
  sim.settle = (budget = 400) => {
    let used = 0;
    while (sim.running() && used < budget) {
      sim.tick();
      used += 1;
    }
    return used;
  };
  return sim;
}

/**
 * The next simulation after the data changed, starting where the last one left off: nodes that
 * stay keep their positions (and pins), new ones start beside their hub, and it begins only
 * gently warm, so the picture grows instead of being laid out again. `positions` seeds nodes the
 * previous simulation did not have.
 */
export function growSimulation(previous, { nodes, links }, { alpha = 0.3, positions } = {}) {
  const known = new Map(positions ?? []);
  const pins = [];
  if (previous) {
    for (const [id, i] of previous.index) {
      known.set(id, { x: previous.xs[i], y: previous.ys[i] });
      if (previous.pinned[i]) pins.push(id);
    }
  }
  const seeds = growPositions(nodes, known);
  const sim = createSimulation({ nodes, links, positions: seeds });
  for (const id of pins) {
    const p = seeds.get(id);
    if (p && sim.index.has(id)) sim.pin(id, p.x, p.y);
  }
  sim.alpha = previous ? Math.min(alpha, 1) : 1;
  return sim;
}

// Labels -----------------------------------------------------------------------------------------

/**
 * Keeps the most important names that fit: each candidate is a box in screen space with a
 * priority; higher priorities go first, and a box that overlaps an accepted one is dropped.
 */
export function pickLabels(candidates, { width, height, limit = 240, gap = 3 } = {}) {
  const sorted = candidates.slice().sort((a, b) => b.priority - a.priority);
  const cell = 96;
  const grid = new Map();
  const accepted = [];
  const overlaps = (a, b) =>
    a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
  for (const box of sorted) {
    if (accepted.length >= limit) break;
    if (box.x + box.w < 0 || box.y + box.h < 0 || box.x > width || box.y > height) continue;
    const x0 = Math.floor(box.x / cell);
    const x1 = Math.floor((box.x + box.w) / cell);
    const y0 = Math.floor(box.y / cell);
    const y1 = Math.floor((box.y + box.h) / cell);
    let clash = false;
    for (let gx = x0; gx <= x1 && !clash; gx += 1) {
      for (let gy = y0; gy <= y1 && !clash; gy += 1) {
        for (const other of grid.get(`${gx},${gy}`) ?? []) {
          if (overlaps(box, other)) {
            clash = true;
            break;
          }
        }
      }
    }
    if (clash && !box.force) continue;
    accepted.push(box);
    for (let gx = x0; gx <= x1; gx += 1) {
      for (let gy = y0; gy <= y1; gy += 1) {
        const key = `${gx},${gy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(box);
      }
    }
  }
  return accepted;
}

/** Shortens a name to fit, with an ellipsis. */
export function clip(text, max = 34) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

// Colours ----------------------------------------------------------------------------------------

function parseHex(hex) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
}

/** Mixes a colour toward another by t in [0, 1]. */
export function mix(hex, other, t) {
  const a = parseHex(hex);
  const b = parseHex(other);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(" ")})`;
}

export function withAlpha(hex, alpha) {
  const [r, g, b] = parseHex(hex);
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

/** Perspective projection of a point in the graph's depth field. */
export function projectDepth(x, y, z, pose) {
  const dx = x - pose.cx, dy = y - pose.cy;
  const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw);
  const cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
  const rx = dx * cy + z * sy, rz = -dx * sy + z * cy;
  const ry = dy * cp - rz * sp, depth = dy * sp + rz * cp;
  const scale = pose.focal / Math.max(pose.focal * .4, pose.focal + depth);
  return { x: pose.cx + rx * scale, y: pose.cy + ry * scale, z: depth, scale };
}

/** Inverse on one node's depth plane; keeps dragging under the pointer in perspective. */
export function unprojectDepth(x, y, z, pose) {
  let px = x, py = y;
  for (let i = 0; i < 6; i++) {
    const a = projectDepth(px, py, z, pose);
    const bx = projectDepth(px + .01, py, z, pose), by = projectDepth(px, py + .01, z, pose);
    const xx = (bx.x - a.x) / .01, xy = (by.x - a.x) / .01;
    const yx = (bx.y - a.y) / .01, yy = (by.y - a.y) / .01;
    const det = xx * yy - xy * yx;
    if (Math.abs(det) < 1e-8) break;
    px += ((x - a.x) * yy - (y - a.y) * xy) / det;
    py += ((y - a.y) * xx - (x - a.x) * yx) / det;
  }
  return { x: px, y: py };
}

// Drawing (browser only) -------------------------------------------------------------------------

const THEMES = {
  dark: {
    bg0: "#080e1c",
    bg1: "#142744",
    star: "rgb(190 210 255 / 0.5)",
    edge: 0.28,
    edgeDim: 0.035,
    edgeActive: 0.85,
    glow: 0.8,
    halo: 0.085,
    labelBg: "rgb(12 16 24 / 0.78)",
    labelBorder: "rgb(255 255 255 / 0.08)",
    labelText: "#e6edf7",
    labelMuted: "#9aaec8",
    ring: "#ffffff",
    dimAlpha: 0.13,
    blend: "lighter",
    shadow: null,
  },
  light: {
    bg0: "#f7fafc",
    bg1: "#fcfdff",
    star: "rgb(60 50 30 / 0.07)",
    edge: 0.32,
    edgeDim: 0.05,
    edgeActive: 0.9,
    glow: 0.24,
    halo: 0.07,
    labelBg: "rgb(255 255 255 / 0.92)",
    labelBorder: "rgb(20 20 30 / 0.10)",
    labelText: "#172131",
    labelMuted: "#606e81",
    ring: "#172131",
    dimAlpha: 0.16,
    blend: "source-over",
    shadow: "rgb(40 30 20 / 0.22)",
  },
};

function offscreen(size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/**
 * Draws a network on a canvas. `getStyle()` is asked for the current look every frame; the
 * engine owns positions, camera, animation, and hit testing.
 */
export function createGraphView(canvas, options = {}) {
  const ctx = canvas.getContext("2d", { alpha: false });
  const reduceMotion = options.reduceMotion ?? false;
  const listeners = { frame: [], settle: [] };
  let theme = THEMES[options.theme === "light" ? "light" : "dark"];
  let themeName = options.theme === "light" ? "light" : "dark";
  let nodes = [];
  let links = [];
  let byId = new Map();
  let sim = null;
  let style = null;
  let width = 1;
  let height = 1;
  let ratio = 1;
  const camera = { x: 0, y: 0, k: 1 };
  let cameraAnimation = null;
  let dirty = true;
  let frameHandle = 0;
  let lastTime = 0;
  let clock = 0;
  let starTile = null;
  const sphereCache = new Map();
  const glowCache = new Map();
  const textWidth = new Map();
  const glyphCache = new Map();
  let labelBoxes = [];
  const groupShapes = new Map();
  const projected = new Map();
  let depthEnabled = true, motionEnabled = !reduceMotion, dragging = false;
  let pointer = { x: 0, y: 0 }, targetPointer = { x: 0, y: 0 };
  let pose = { cx: 0, cy: 0, yaw: .18, pitch: -.12, focal: 1100 };
  const depthOf = id => (hashUnit(`depth:${id}`) - .5) * 190;
  function renderPosition(id) {
    if (projected.has(id)) return projected.get(id);
    const raw = sim?.position(id);
    if (!raw) return null;
    const point = depthEnabled ? projectDepth(raw.x, raw.y, depthOf(id), pose) : { ...raw, z: 0, scale: 1 };
    const result = { ...point, r: raw.r * point.scale };
    projected.set(id, result);
    return result;
  }
  if (typeof document !== 'undefined' && canvas.parentElement) {
  canvas.addEventListener('pointermove', event => {
    if (event.buttons || reduceMotion || !motionEnabled) return;
    const rect = canvas.getBoundingClientRect();
    targetPointer = { x: ((event.clientX - rect.left) / rect.width - .5) * 2, y: ((event.clientY - rect.top) / rect.height - .5) * 2 };
    dirty = true; schedule();
  });
  canvas.addEventListener('pointerleave', () => { targetPointer = { x: 0, y: 0 }; dirty = true; schedule(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastTime = 0; dirty = true; schedule(); } });
  }


  function sphere(color) {
    const key = `${themeName}:${color}`;
    if (sphereCache.has(key)) return sphereCache.get(key);
    const size = 96;
    const c = offscreen(size);
    const g = c.getContext("2d");
    const r = size / 2 - 1;
    const gradient = g.createRadialGradient(size * 0.36, size * 0.32, r * 0.05, size / 2, size / 2, r);
    gradient.addColorStop(0, mix(color, "#ffffff", 0.62));
    gradient.addColorStop(0.38, mix(color, "#ffffff", 0.12));
    gradient.addColorStop(0.78, color);
    gradient.addColorStop(1, mix(color, "#000000", themeName === "dark" ? 0.45 : 0.3));
    g.fillStyle = gradient;
    g.beginPath();
    g.arc(size / 2, size / 2, r, 0, TAU);
    g.fill();
    sphereCache.set(key, c);
    return c;
  }

  function glow(color) {
    if (glowCache.has(color)) return glowCache.get(color);
    const size = 128;
    const c = offscreen(size);
    const g = c.getContext("2d");
    const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, withAlpha(color, 0.9));
    gradient.addColorStop(0.25, withAlpha(color, 0.35));
    gradient.addColorStop(0.6, withAlpha(color, 0.08));
    gradient.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = gradient;
    g.fillRect(0, 0, size, size);
    glowCache.set(color, c);
    return c;
  }

  function stars() {
    if (starTile && starTile.theme === themeName) return starTile.canvas;
    const size = 640;
    const c = offscreen(size);
    const g = c.getContext("2d");
    if (themeName === "dark") {
      for (let i = 0; i < 260; i += 1) {
        const x = ((i * .754877666 + hashUnit(`jitter-x:${i}`) * .09) % 1) * size;
        const y = ((i * .569840296 + hashUnit(`jitter-y:${i}`) * .09) % 1) * size;
        const big = hashUnit(`sb${i}`);
        g.fillStyle = `rgb(200 215 255 / ${0.08 + big * 0.22})`;
        g.beginPath();
        g.arc(x, y, big > 0.94 ? 1.3 : 0.6, 0, TAU);
        g.fill();
      }
    } else {
      g.fillStyle = theme.star;
      for (let x = 16; x < size; x += 32) {
        for (let y = 16; y < size; y += 32) {
          g.beginPath();
          g.arc(x, y, 0.9, 0, TAU);
          g.fill();
        }
      }
    }
    starTile = { theme: themeName, canvas: c };
    return c;
  }

  function glyphPaths(shape) {
    if (!shape) return null;
    if (glyphCache.has(shape)) return glyphCache.get(shape);
    const paths = {
      fill: shape.fill ? new Path2D(shape.fill) : null,
      stroke: shape.stroke ? new Path2D(shape.stroke) : null,
      dots: shape.dots ?? [],
      ring: shape.ring ?? null,
    };
    glyphCache.set(shape, paths);
    return paths;
  }

  function measure(text, font) {
    const key = `${font}|${text}`;
    let value = textWidth.get(key);
    if (value === undefined) {
      ctx.font = font;
      value = ctx.measureText(text).width;
      textWidth.set(key, value);
    }
    return value;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    dirty = true;
    schedule();
  }

  /**
   * Shows new data. With `{ keepPositions: true }` the graph grows from what is on screen: nodes
   * that stay keep their places, new ones start beside their hub, and the simulation is only
   * gently reheated (`alpha`, default 0.3). `positions` seeds nodes that are not on screen yet.
   */
  function setData(next, options = {}) {
    const grow = options.keepPositions === true;
    const previous = sim;
    nodes = next.nodes;
    links = next.links;
    byId = new Map(nodes.map((node) => [node.id, node]));
    projected.clear();
    if (grow) {
      sim = growSimulation(previous, { nodes, links }, { alpha: options.alpha, positions: options.positions });
    } else {
      sim = createSimulation({ nodes, links });
    }
    if (!grow || !previous) {
      // Most of the settling happens before the first frame, so the map arrives almost in place.
      const warm = reduceMotion ? 420 : Math.max(40, Math.min(240, Math.round(60000 / Math.max(nodes.length, 1))));
      sim.settle(warm);
      // Keep large maps behind the near plane without moving existing nodes when a group opens.
      let extent = 0;
      for (let i = 0; i < nodes.length; i++) extent = Math.max(extent, Math.hypot(sim.xs[i], sim.ys[i]));
      pose.focal = Math.max(1100, extent * 2.5);
      if (!reduceMotion) sim.reheat(0.12);
    } else if (reduceMotion) {
      sim.settle(420);
    }
    dirty = true;
    schedule();
  }

  function setActive(ids) {
    if (!sim) return;
    sim.setActive(ids);
    sim.reheat(0.25);
    schedule();
  }

  function bounds(ids) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const p = renderPosition(id);
      if (!p) continue;
      minX = Math.min(minX, p.x - p.r);
      minY = Math.min(minY, p.y - p.r);
      maxX = Math.max(maxX, p.x + p.r);
      maxY = Math.max(maxY, p.y + p.r);
    }
    if (minX === Infinity) return null;
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, r: Math.max(40, Math.hypot(maxX - minX, maxY - minY) / 2) };
  }

  function frameTarget(x, y, r, margin = 48, insets = { left: 0, right: 0, top: 0, bottom: 0 }) {
    const w = width - insets.left - insets.right - margin * 2;
    const h = height - insets.top - insets.bottom - margin * 2;
    const k = clampK(Math.min(Math.max(w, 80) / (2 * r), Math.max(h, 80) / (2 * r)));
    const cx = insets.left + margin + Math.max(w, 80) / 2;
    const cy = insets.top + margin + Math.max(h, 80) / 2;
    return { k, x: cx - x * k, y: cy - y * k };
  }

  let minK = 0.02;
  let maxK = 6;
  function clampK(k) {
    return Math.max(minK, Math.min(maxK, k));
  }

  function animateTo(target, duration = 520) {
    const goal = { ...target, k: clampK(target.k) };
    if (reduceMotion || duration <= 0) {
      Object.assign(camera, goal);
      cameraAnimation = null;
      dirty = true;
      schedule();
      return;
    }
    cameraAnimation = { from: { ...camera }, to: goal, start: performance.now(), duration };
    schedule();
  }

  function zoomAt(factor, sx, sy) {
    cameraAnimation = null;
    const k = clampK(camera.k * factor);
    const wx = (sx - camera.x) / camera.k;
    const wy = (sy - camera.y) / camera.k;
    camera.k = k;
    camera.x = sx - wx * k;
    camera.y = sy - wy * k;
    dirty = true;
    schedule();
  }

  function panBy(dx, dy) {
    cameraAnimation = null;
    camera.x += dx;
    camera.y += dy;
    dirty = true;
    schedule();
  }

  function toScreen(x, y) {
    return { x: x * camera.k + camera.x, y: y * camera.k + camera.y };
  }

  function toWorld(sx, sy) {
    return { x: (sx - camera.x) / camera.k, y: (sy - camera.y) / camera.k };
  }

  /** The node under a screen point, or a group name. Small nodes get a bigger target. */
  function hitTest(sx, sy) {
    for (let index = labelBoxes.length - 1; index >= 0; index -= 1) {
      const box = labelBoxes[index];
      if (box.hub && sx >= box.x && sx <= box.x + box.w && sy >= box.y && sy <= box.y + box.h) {
        return box.id;
      }
    }
    if (!sim) return null;
    const world = toWorld(sx, sy);
    let best = null;
    let bestScore = Infinity;
    const visibleIds = style?.visible;
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (visibleIds && !visibleIds.has(node.id)) continue;
      const point = renderPosition(node.id);
      if (!point || !sim.active[i]) continue;
      const dx = point.x - world.x;
      const dy = point.y - world.y;
      const reach = Math.max(point.r, 9 / camera.k);
      const d2 = dx * dx + dy * dy;
      if (d2 <= reach * reach && d2 < bestScore) {
        best = node.id;
        bestScore = d2;
      }
    }
    return best;
  }

  function schedule() {
    if (frameHandle || (typeof document !== 'undefined' && document.hidden)) return;
    frameHandle = requestAnimationFrame(loop);
  }

  function animating() {
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (cameraAnimation) return true;
    if (sim && sim.running() && !reduceMotion) return true;
    if (!reduceMotion && motionEnabled && style && (style.flow?.size ?? 0) > 0) return true;
    if (!reduceMotion && motionEnabled && style?.ambient?.length) return true;
    return false;
  }

  function loop(now) {
    frameHandle = 0;
    const dt = lastTime === 0 ? 16 : Math.min(now - lastTime, 50);
    lastTime = now;
    if (motionEnabled && !dragging) clock += dt;
    if (cameraAnimation) {
      const t = Math.min((now - cameraAnimation.start) / cameraAnimation.duration, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const { from, to } = cameraAnimation;
      camera.k = from.k * Math.pow(to.k / from.k, ease);
      // Keep the screen center on a straight path in world space while the zoom changes.
      const fromCenter = { x: (width / 2 - from.x) / from.k, y: (height / 2 - from.y) / from.k };
      const toCenter = { x: (width / 2 - to.x) / to.k, y: (height / 2 - to.y) / to.k };
      const cx = fromCenter.x + (toCenter.x - fromCenter.x) * ease;
      const cy = fromCenter.y + (toCenter.y - fromCenter.y) * ease;
      camera.x = width / 2 - cx * camera.k;
      camera.y = height / 2 - cy * camera.k;
      if (t >= 1) {
        Object.assign(camera, to);
        cameraAnimation = null;
      }
      dirty = true;
    }
    if (sim && sim.running()) {
      const wasRunning = true;
      sim.tick(nodes.length > 2500 ? 1 : 2);
      dirty = true;
      if (!sim.running() && wasRunning) for (const fn of listeners.settle) fn();
    }
    if (animating()) dirty = true;
    if (dirty) {
      draw();
      dirty = false;
      for (const fn of listeners.frame) fn();
    }
    if (animating()) schedule();
    else lastTime = 0;
  }

  function drawBackground() {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const gradient = ctx.createRadialGradient(width * 0.5, height * 0.42, 0, width * 0.5, height * 0.5, Math.max(width, height) * 0.75);
    gradient.addColorStop(0, theme.bg1);
    gradient.addColorStop(1, theme.bg0);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    const tile = stars();
    const parallax = themeName === "dark" ? 0.12 : 1;
    const scale = themeName === "dark" ? 1 : Math.max(0.5, Math.min(2, camera.k));
    const size = tile.width * scale;
    const ox = (((camera.x * parallax + (motionEnabled && !reduceMotion ? Math.sin(clock / 22000) * 14 + pointer.x * 12 : 0)) % size) + size) % size;
    const oy = (((camera.y * parallax + (motionEnabled && !reduceMotion ? Math.cos(clock / 27000) * 10 + pointer.y * 10 : 0)) % size) + size) % size;
    for (let x = ox - size; x < width; x += size) {
      for (let y = oy - size; y < height; y += size) {
        ctx.drawImage(tile, x, y, size, size);
      }
    }
  }

  function computeGroups() {
    groupShapes.clear();
    if (!sim) return;
    const sums = new Map();
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node.hub || !sim.active[i] || node.group == null) continue;
      if (style?.visible && !style.visible.has(node.id)) continue;
      let entry = sums.get(node.group);
      if (!entry) {
        entry = { x: 0, y: 0, n: 0 };
        sums.set(node.group, entry);
      }
      const point = renderPosition(node.id);
      entry.x += point.x;
      entry.y += point.y;
      entry.n += 1;
    }
    const centers = new Map();
    for (const [id, entry] of sums) {
      const hub = renderPosition(id);
      if (!hub) continue;
      // The cloud is centred between the hub and its members, and reaches most of them.
      const mx = entry.x / entry.n;
      const my = entry.y / entry.n;
      centers.set(id, {
        x: (mx * entry.n + hub.x * 2) / (entry.n + 2),
        y: (my * entry.n + hub.y * 2) / (entry.n + 2),
        spread: 0,
        n: entry.n,
      });
    }
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node.hub || !sim.active[i]) continue;
      if (style?.visible && !style.visible.has(node.id)) continue;
      const center = centers.get(node.group);
      if (center) center.spread += Math.hypot(renderPosition(node.id).x - center.x, renderPosition(node.id).y - center.y);
    }
    for (const [id, c] of centers) {
      groupShapes.set(id, { x: c.x, y: c.y, r: (c.spread / c.n) * 1.6 + 30, n: c.n });
    }
  }

  function draw() {
    projected.clear();
    if (sim && depthEnabled) {
      const moving = motionEnabled && !reduceMotion && !dragging;
      if (moving) {
        pointer.x += (targetPointer.x - pointer.x) * .07;
        pointer.y += (targetPointer.y - pointer.y) * .07;
        pose = { ...pose,
          yaw: .18 + Math.sin(clock / 15000) * .13 + pointer.x * .16,
          pitch: -.12 + Math.cos(clock / 19000) * .055 + pointer.y * .1 };
      }
    }
    if (!sim) {
      drawBackground();
      return;
    }
    drawBackground();
    const s = style ?? {};
    const visible = s.visible ?? null;
    const highlighting = s.highlighting ?? false;
    const near = s.near ?? new Set();
    const activeEdges = s.activeEdges ?? new Set();
    const k = camera.k;
    ctx.setTransform(ratio * k, 0, 0, ratio * k, ratio * camera.x, ratio * camera.y);
    const view = { x0: -camera.x / k, y0: -camera.y / k, x1: (width - camera.x) / k, y1: (height - camera.y) / k };
    const inView = (x, y, r) => x + r >= view.x0 && x - r <= view.x1 && y + r >= view.y0 && y - r <= view.y1;
    const isShown = (id) => !visible || visible.has(id);

    // Group clouds: a soft nebula behind each hub's members.
    computeGroups();
    ctx.globalCompositeOperation = themeName === "dark" ? "lighter" : "source-over";
    for (const [id, shape] of groupShapes) {
      const hub = byId.get(id);
      if (!hub || !isShown(id) || !inView(shape.x, shape.y, shape.r)) continue;
      const heat = s.heat?.get(id) ?? 0;
      const focused = s.focusGroups?.has(id) ?? false;
      let alpha = theme.halo * (1 + heat * 2.4) * (focused ? 1.8 : 1);
      if (highlighting && !focused && !near.has(id)) alpha *= 0.35;
      const gradient = ctx.createRadialGradient(shape.x, shape.y, 0, shape.x, shape.y, shape.r);
      gradient.addColorStop(0, withAlpha(hub.color, alpha));
      gradient.addColorStop(0.7, withAlpha(hub.color, alpha * 0.45));
      gradient.addColorStop(1, withAlpha(hub.color, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, shape.r, 0, TAU);
      ctx.fill();
      if (focused) {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = withAlpha(hub.color, 0.55);
        ctx.lineWidth = 1.2 / k;
        ctx.setLineDash([6 / k, 5 / k]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalCompositeOperation = themeName === "dark" ? "lighter" : "source-over";
      }
    }
    ctx.globalCompositeOperation = "source-over";

    // Connections: faint everywhere, bright along the selection.
    const lineWidth = Math.max(0.5, 0.9 / Math.sqrt(k)) / k * Math.min(1.6, Math.sqrt(k) + 0.3);
    const batches = new Map();
    const bright = [];
    for (const link of links) {
      if (link.hidden) continue;
      if (!isShown(link.source) || !isShown(link.target)) continue;
      if (s.drawEdges && !s.drawEdges.has(link.id) && !link.structure) continue;
      const a = renderPosition(link.source);
      const b = renderPosition(link.target);
      if (!a || !b) continue;
      if (!inView((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y) / 2 + 4)) continue;
      const on = activeEdges.has(link.id);
      if (on) {
        bright.push({ link, a, b });
        continue;
      }
      const tint = byId.get(link.structure ? link.target : link.source);
      let alpha = link.structure ? theme.edge * 0.6 : theme.edge;
      if (highlighting) alpha = theme.edgeDim;
      const key = `${link.color ?? tint?.color ?? "#888888"}|${alpha}`;
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(a, b);
    }
    ctx.lineCap = "round";
    for (const [key, points] of batches) {
      const [color, alpha] = key.split("|");
      ctx.strokeStyle = withAlpha(color, Number(alpha));
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      for (let i = 0; i < points.length; i += 2) {
        ctx.moveTo(points[i].x, points[i].y);
        ctx.lineTo(points[i + 1].x, points[i + 1].y);
      }
      ctx.stroke();
    }
    for (const { link, a, b } of bright) {
      const source = byId.get(link.structure ? link.target : link.source);
      const color = link.color ?? source?.color ?? "#ffffff";
      const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      gradient.addColorStop(0, withAlpha(color, theme.edgeActive));
      gradient.addColorStop(1, withAlpha(byId.get(link.target)?.color ?? color, theme.edgeActive * 0.75));
      ctx.strokeStyle = gradient;
      ctx.lineWidth = Math.max(1.6 / k, lineWidth * 2.2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (!link.structure) {
        // An arrowhead on the target's rim shows which way the connection reads.
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const size = 7 / k;
        const tx = b.x - Math.cos(angle) * (b.r + 1.5 / k);
        const ty = b.y - Math.sin(angle) * (b.r + 1.5 / k);
        ctx.fillStyle = withAlpha(color, 0.95);
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - Math.cos(angle - 0.42) * size, ty - Math.sin(angle - 0.42) * size);
        ctx.lineTo(tx - Math.cos(angle + 0.42) * size, ty - Math.sin(angle + 0.42) * size);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Light travelling along connections: the selection's, and a quiet sample everywhere.
    if (!reduceMotion && motionEnabled) {
      const particles = [];
      for (const { link, a, b } of bright) particles.push({ link, a, b, strong: true });
      if (s.ambient && !highlighting) {
        for (const link of s.ambient) {
          if (!isShown(link.source) || !isShown(link.target)) continue;
          const a = renderPosition(link.source);
          const b = renderPosition(link.target);
          if (a && b && inView((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y) / 2)) {
            particles.push({ link, a, b, strong: false });
          }
        }
      }
      ctx.globalCompositeOperation = themeName === "dark" ? "lighter" : "source-over";
      for (const { link, a, b, strong } of particles) {
        const color = byId.get(link.source)?.color ?? "#ffffff";
        const sprite = glow(color);
        const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const speed = strong ? 0.13 : 0.085;
        const count = strong ? 3 : 2;
        for (let n = 0; n < count; n += 1) {
          const t = ((clock / 1000) * speed * (180 / Math.max(length, 60)) * 3 + hashUnit(link.id) + n / count) % 1;
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t;
          const size = (strong ? 9 : 6) / Math.sqrt(k) / Math.max(1, Math.sqrt(k));
          ctx.globalAlpha = strong ? 0.95 : 0.55;
          ctx.drawImage(sprite, x - size, y - size, size * 2, size * 2);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    // Nodes: a glow behind, a lit sphere in front.
    const drawOrder = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!sim.active[i] || !isShown(node.id)) continue;
      const point = renderPosition(node.id);
      const { x, y, r } = point;
      if (!inView(x, y, r * 3)) continue;
      const dim = highlighting && !near.has(node.id);
      drawOrder.push({ node, x, y, r, dim, i, z: point.z });
    }
    // Dim first, then lit, then the selection on top.
    drawOrder.sort((a, b) => Number(!a.dim) - Number(!b.dim) || b.z - a.z || a.r - b.r);
    const screenMin = 1.2;
    if (themeName === "dark") {
      ctx.globalCompositeOperation = "lighter";
      for (const item of drawOrder) {
        if (item.dim) continue;
        const sr = item.r * k;
        if (sr < screenMin) continue;
        const selectedNode = s.selected === item.node.id;
        const g = (item.node.hub ? 3.6 : 2.8) * item.r * (selectedNode ? 1.5 : 1);
        ctx.globalAlpha = theme.glow * (item.node.hub ? 0.9 : 0.6) * (highlighting ? 1.2 : 1);
        ctx.drawImage(glow(item.node.color), item.x - g, item.y - g, g * 2, g * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    for (const item of drawOrder) {
      const { node, x, y, r, dim } = item;
      const sr = r * k;
      ctx.globalAlpha = dim ? theme.dimAlpha : node.retired ? 0.55 : 1;
      if (sr < screenMin) {
        ctx.fillStyle = node.color;
        const size = screenMin / k;
        ctx.fillRect(x - size, y - size, size * 2, size * 2);
        continue;
      }
      if (theme.shadow && !dim) {
        ctx.fillStyle = theme.shadow;
        ctx.beginPath();
        ctx.ellipse(x + r * 0.15, y + r * 0.85, r * 0.85, r * 0.32, 0, 0, TAU);
        ctx.fill();
      }
      ctx.drawImage(sphere(node.retired ? "#8a8f99" : node.color), x - r, y - r, r * 2, r * 2);
      if (node.hub && !dim && depthEnabled) {
        ctx.strokeStyle = withAlpha(node.color, themeName === 'dark' ? .48 : .28);
        ctx.lineWidth = 1 / k;
        ctx.beginPath(); ctx.ellipse(x, y + r * .2, r * 1.65, r * .52, -.3, 0, TAU); ctx.stroke();
        ctx.strokeStyle = withAlpha(themeName === 'dark' ? '#e4efff' : '#ffffff', .75);
        ctx.beginPath(); ctx.arc(x, y, r * .86, -2.7, -1.1); ctx.stroke();
      }

      if (sr >= 9 && !dim) {
        const paths = glyphPaths(node.glyph);
        if (paths) {
          ctx.save();
          ctx.translate(x, y);
          const g = (r / 11) * 0.82;
          ctx.scale(g, g);
          ctx.fillStyle = "rgb(255 255 255 / 0.92)";
          ctx.strokeStyle = "rgb(255 255 255 / 0.92)";
          ctx.lineWidth = 1.7;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          if (paths.fill) ctx.fill(paths.fill);
          if (paths.stroke) ctx.stroke(paths.stroke);
          for (const [dx, dy] of paths.dots) {
            ctx.beginPath();
            ctx.arc(dx, dy, 1.9, 0, TAU);
            ctx.stroke();
          }
          if (paths.ring) {
            ctx.beginPath();
            ctx.arc(paths.ring[0], paths.ring[1], paths.ring[2], 0, TAU);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
      // State marks: a dot for work waiting, a ring for the selection, pins, and impact depth.
      if (!dim && node.badge && sr >= 4) {
        ctx.fillStyle = node.badge;
        ctx.beginPath();
        ctx.arc(x + r * 0.72, y - r * 0.72, Math.max(r * 0.32, 2.4 / k), 0, TAU);
        ctx.fill();
        ctx.strokeStyle = theme.bg0;
        ctx.lineWidth = 1.2 / k;
        ctx.stroke();
      }
      const impact = s.impact?.get(node.id) ?? 0;
      const ringed = s.selected === node.id || s.pins?.has(node.id) || impact > 0 || s.hovered === node.id;
      if (ringed && !dim) {
        ctx.strokeStyle = s.selected === node.id ? theme.ring : impact > 0 ? ["", "#ff6b6b", "#ffa94d", "#ffd43b"][Math.min(impact, 3)] : withAlpha(node.color, 0.9);
        ctx.lineWidth = (s.selected === node.id ? 2 : 1.4) / k;
        if (s.pins?.has(node.id)) ctx.setLineDash([3 / k, 2.5 / k]);
        ctx.beginPath();
        ctx.arc(x, y, r + 3.5 / k, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (node.retired && !dim && sr >= 5) {
        ctx.strokeStyle = withAlpha("#9aa0aa", 0.9);
        ctx.lineWidth = 1 / k;
        ctx.setLineDash([2 / k, 2 / k]);
        ctx.beginPath();
        ctx.arc(x, y, r + 1.5 / k, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;

    // Names: a pill above each node that fits, the most important first.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const candidates = [];
    const showNames = s.labels !== false;
    for (const item of drawOrder) {
      const { node, x, y, r, dim } = item;
      const sx = x * k + camera.x;
      const sy = y * k + camera.y;
      const sr = r * k;
      const selectedNode = s.selected === node.id;
      const hoveredNode = s.hovered === node.id;
      let priority = -1;
      if (selectedNode) priority = 10000;
      else if (hoveredNode) priority = 9000;
      else if (!showNames) continue;
      else if (dim) continue;
      else if (s.pins?.has(node.id)) priority = 8000;
      else if (node.hub) priority = 6000 - node.depth * 500 + Math.min(node.weight ?? 0, 400);
      else if (highlighting && near.has(node.id)) priority = 4000 + sr;
      else if (sr >= (node.labelAt ?? 7)) priority = 1000 + sr * 10 + (node.weight ?? 0);
      if (priority < 0) continue;
      const hub = node.hub;
      const font = hub ? `600 ${node.depth === 0 ? 13 : 12}px ${FONT}` : `500 11px ${FONT}`;
      const text = clip(node.label, hub ? 30 : selectedNode || hoveredNode ? 60 : 30);
      const w = measure(text, font) + 14;
      const h = hub ? 22 : 19;
      candidates.push({
        id: node.id,
        hub,
        text,
        font,
        color: node.color,
        selected: selectedNode,
        hovered: hoveredNode,
        priority,
        force: selectedNode || hoveredNode,
        x: sx - w / 2,
        y: sy - Math.max(sr, 3) - h - 5,
        w,
        h,
      });
    }
    labelBoxes = pickLabels(candidates, { width, height, limit: s.labelLimit ?? 260 });
    for (const box of labelBoxes) {
      const radius = 5;
      ctx.beginPath();
      ctx.roundRect(box.x, box.y, box.w, box.h, radius);
      if (box.selected) {
        ctx.fillStyle = theme.labelBg;
        ctx.fill();
        ctx.strokeStyle = box.color; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = theme.labelText;
      } else {
        ctx.fillStyle = theme.labelBg;
        ctx.fill();
        ctx.strokeStyle = box.hub ? withAlpha(box.color, 0.55) : theme.labelBorder;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = box.hub ? theme.labelText : box.hovered ? theme.labelText : theme.labelMuted;
        if (!box.hub) ctx.fillStyle = theme.labelText;
      }
      ctx.font = box.font;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(box.text, box.x + box.w / 2, box.y + box.h / 2 + 0.5);
    }
  }

  const FONT = options.font ?? (typeof getComputedStyle === "function" ? getComputedStyle(canvas).getPropertyValue("--font").trim() || "system-ui" : "system-ui");

  const api = {
    camera,
    setData,
    setActive,
    setStyle(next) {
      style = next;
      dirty = true;
      schedule();
    },
    setTheme(name) {
      themeName = name === "light" ? "light" : "dark";
      theme = THEMES[themeName];
      dirty = true;
      schedule();
    },
    setZoomLimits(min, max) {
      minK = min;
      maxK = max;
    },
    get theme() {
      return themeName;
    },
    get size() {
      return { width, height };
    },
    get settled() {
      return !sim || !sim.running();
    },
    resize,
    redraw() {
      dirty = true;
      schedule();
    },
    position: (id) => renderPosition(id),
    groupShape: (id) => {
      if (groupShapes.size === 0) computeGroups();
      return groupShapes.get(id) ?? null;
    },
    bounds,
    frameTarget,
    animateTo,
    jumpTo(target) {
      animateTo(target, 0);
    },
    zoomAt,
    panBy,
    toScreen,
    toWorld,
    hitTest,
    pin: (id, x, y) => {
      dragging = true;
      const raw = depthEnabled ? unprojectDepth(x, y, depthOf(id), pose) : { x, y };
      sim?.pin(id, raw.x, raw.y);
      projected.clear();
      sim?.reheat(0.08);
      schedule();
    },
    release: (id) => {
      dragging = false;
      sim?.release(id);
      sim?.reheat(0.12);
      schedule();
    },
    on(event, fn) {
      listeners[event]?.push(fn);
    },
    /** Every node position, for the minimap. */
    each(fn) {
      if (!sim) return;
      for (let i = 0; i < nodes.length; i += 1) {
        if (!sim.active[i]) continue;
        const p = renderPosition(nodes[i].id);
        fn(nodes[i], p.x, p.y, p.r);
      }
    },
  };
  return api;
}
