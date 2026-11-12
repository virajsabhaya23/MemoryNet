// MemoryNet graph engine: a force-directed network drawn on a canvas, with no outside libraries.
// The top half is pure (seeding, simulation, label placement) and runs in Node for tests; the
// bottom half draws on a canvas in the browser. It only ever sees what the page already holds.

import { assignTiers, convexHull, kindShape } from "./graph-tiers.js";

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
    const parent =
      node.group !== null && byId.has(node.group) ? node.group : null;
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
      positions.set(memberId, {
        x: x + r * Math.cos(theta),
        y: y + r * Math.sin(theta),
      });
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
      const distance =
        cloud + spread(weigh(kid)) * (depth === 0 ? 1.6 : 1.25) + 40;
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
      place(
        id,
        distance * Math.cos(mid),
        distance * Math.sin(mid),
        mid,
        Math.min(share, Math.PI),
        1,
      );
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
    const anchor =
      parent && parent !== node && depth < 64 && placedAbove(parent)
        ? place(parent, depth + 1)
        : null;
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
      const away =
        grand && (grand.x !== anchor.x || grand.y !== anchor.y)
          ? Math.atan2(anchor.y - grand.y, anchor.x - grand.x)
          : hashUnit(parent.id) * TAU;
      const angle = away + (hashUnit(node.id) - 0.5) * Math.PI * 0.9;
      const distance = 60 + (node.r ?? 9) * 3 + 10 * Math.sqrt(index);
      p = {
        x: anchor.x + distance * Math.cos(angle),
        y: anchor.y + distance * Math.sin(angle),
      };
    } else {
      const index = members.get(parent.id) ?? 0;
      members.set(parent.id, index + 1);
      const r = 18 + 14 * Math.sqrt(index + 0.5);
      const theta = index * GOLDEN_ANGLE + hashUnit(parent.id) * TAU;
      p = {
        x: anchor.x + r * Math.cos(theta),
        y: anchor.y + r * Math.sin(theta),
      };
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
 * With `cells`, each hub and its own members form a cell, and cells push apart until they clear.
 */
export function createSimulation({ nodes, links, positions, cells = false }) {
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
  const cellOf = new Int32Array(count).fill(-1);
  let cellCount = 0;
  if (cells) {
    const slot = new Map();
    for (let i = 0; i < count; i += 1) {
      const owner = nodes[i].hub ? i : hubOf[i];
      if (owner < 0) continue;
      if (!slot.has(owner)) slot.set(owner, slot.size);
      cellOf[i] = slot.get(owner);
    }
    cellCount = slot.size;
  }
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
    // Between cells a member only leans toward its partner, so neither cell is torn open.
    const across =
      cells && cellOf[s] !== cellOf[t] && !(nodes[s].hub && nodes[t].hub);
    linkStrength.push((link.strength ?? 1) * (across ? 0.18 : 1));
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
    bias[l] = degree[s] / (degree[s] + degree[t] || 1);
  }
  let maxRadius = 1;
  for (let i = 0; i < count; i += 1) maxRadius = Math.max(maxRadius, radius[i]);

  const cellX = new Float64Array(cellCount);
  const cellY = new Float64Array(cellCount);
  const cellN = new Float64Array(cellCount);
  const cellReach = new Float64Array(cellCount);
  const pushX = new Float64Array(cellCount);
  const pushY = new Float64Array(cellCount);

  const sim = {
    alpha: 1,
    alphaMin: 0.002,
    alphaDecay: 1 - Math.pow(0.002, 1 / 320),
    alphaTarget: 0,
    velocityDecay: 0.42,
    theta2: 0.81,
    distanceMax2: 900 * 900,
    groupPull: 0.06,
    /** How hard overlapping cells push apart, and the clear space kept between their outlines. */
    cellPush: 0.3,
    cellGap: 64,
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
            const share =
              (radius[j] * radius[j]) /
              (radius[i] * radius[i] + radius[j] * radius[j]);
            vx[i] -= dx * push * share;
            vy[i] -= dy * push * share;
            vx[j] += dx * push * (1 - share);
            vy[j] += dy * push * (1 - share);
          }
        }
      }
    }
  }

  /** Whole cells move apart, members and hub together, the lighter cell further. */
  function separate(alpha) {
    if (cellCount < 2) return;
    cellX.fill(0);
    cellY.fill(0);
    cellN.fill(0);
    cellReach.fill(0);
    pushX.fill(0);
    pushY.fill(0);
    for (let i = 0; i < count; i += 1) {
      const c = cellOf[i];
      if (c < 0 || !active[i]) continue;
      cellX[c] += xs[i];
      cellY[c] += ys[i];
      cellN[c] += 1;
    }
    for (let c = 0; c < cellCount; c += 1) {
      if (cellN[c] === 0) continue;
      cellX[c] /= cellN[c];
      cellY[c] /= cellN[c];
    }
    for (let i = 0; i < count; i += 1) {
      const c = cellOf[i];
      if (c < 0 || !active[i]) continue;
      const reach = Math.hypot(xs[i] - cellX[c], ys[i] - cellY[c]) + radius[i];
      if (reach > cellReach[c]) cellReach[c] = reach;
    }
    const k = sim.cellPush * alpha;
    for (let a = 0; a < cellCount; a += 1) {
      if (cellN[a] === 0) continue;
      for (let b = a + 1; b < cellCount; b += 1) {
        if (cellN[b] === 0) continue;
        let dx = cellX[b] - cellX[a];
        let dy = cellY[b] - cellY[a];
        const min = cellReach[a] + cellReach[b] + sim.cellGap;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-6) {
          dx = hashUnit(`cell:${a}:${b}`) - 0.5;
          dy = hashUnit(`cell:${b}:${a}`) - 0.5;
          d = Math.hypot(dx, dy) || 1;
        }
        const push = ((min - d) / d) * k;
        const share = cellN[b] / (cellN[a] + cellN[b]);
        pushX[a] -= dx * push * share;
        pushY[a] -= dy * push * share;
        pushX[b] += dx * push * (1 - share);
        pushY[b] += dy * push * (1 - share);
      }
    }
    for (let i = 0; i < count; i += 1) {
      const c = cellOf[i];
      if (c < 0 || !active[i]) continue;
      vx[i] += pushX[c];
      vy[i] += pushY[c];
    }
  }

  sim.tick = (times = 1) => {
    for (let n = 0; n < times; n += 1) {
      sim.alpha += (sim.alphaTarget - sim.alpha) * sim.alphaDecay;
      const alpha = sim.alpha;
      repel(alpha);
      springs(alpha);
      gather(alpha);
      separate(alpha);
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
export function growSimulation(
  previous,
  { nodes, links },
  { alpha = 0.3, positions, cells = false } = {},
) {
  const known = new Map(positions ?? []);
  const pins = [];
  if (previous) {
    for (const [id, i] of previous.index) {
      known.set(id, { x: previous.xs[i], y: previous.ys[i] });
      if (previous.pinned[i]) pins.push(id);
    }
  }
  const seeds = growPositions(nodes, known);
  const sim = createSimulation({ nodes, links, positions: seeds, cells });
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
 * A box may name other spots to try (`alts`) before it gives up, and `obstacles` (such as the
 * nodes themselves) are kept clear except by the box with the same id.
 */
export function pickLabels(
  candidates,
  { width, height, limit = 240, gap = 3, obstacles = [] } = {},
) {
  const sorted = candidates.slice().sort((a, b) => b.priority - a.priority);
  const cell = 96;
  const grid = new Map();
  const accepted = [];
  const overlaps = (a, b) =>
    a.x < b.x + b.w + gap &&
    b.x < a.x + a.w + gap &&
    a.y < b.y + b.h + gap &&
    b.y < a.y + a.h + gap;
  const offscreen = (box) =>
    box.x + box.w < 0 || box.y + box.h < 0 || box.x > width || box.y > height;
  const span = (box) => [
    Math.floor(box.x / cell),
    Math.floor((box.x + box.w) / cell),
    Math.floor(box.y / cell),
    Math.floor((box.y + box.h) / cell),
  ];
  const add = (box) => {
    const [x0, x1, y0, y1] = span(box);
    for (let gx = x0; gx <= x1; gx += 1) {
      for (let gy = y0; gy <= y1; gy += 1) {
        const key = `${gx},${gy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(box);
      }
    }
  };
  const clashes = (box) => {
    const [x0, x1, y0, y1] = span(box);
    for (let gx = x0; gx <= x1; gx += 1) {
      for (let gy = y0; gy <= y1; gy += 1) {
        for (const other of grid.get(`${gx},${gy}`) ?? []) {
          if (other.obstacle && other.id === box.id) continue;
          if (overlaps(box, other)) return true;
        }
      }
    }
    return false;
  };
  for (const obstacle of obstacles) {
    if (!offscreen(obstacle)) add({ ...obstacle, obstacle: true });
  }
  for (const box of sorted) {
    if (accepted.length >= limit) break;
    let placed = null;
    for (const spot of [box, ...(box.alts ?? [])]) {
      const trial = spot === box ? box : { ...box, x: spot.x, y: spot.y };
      if (offscreen(trial)) continue;
      if (!clashes(trial)) {
        placed = trial;
        break;
      }
    }
    if (!placed && box.force && !offscreen(box)) placed = box;
    if (!placed) continue;
    accepted.push(placed);
    add(placed);
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
  const full =
    value.length === 3 ? [...value].map((c) => c + c).join("") : value;
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
  const dx = x - pose.cx,
    dy = y - pose.cy;
  const cy = Math.cos(pose.yaw),
    sy = Math.sin(pose.yaw);
  const cp = Math.cos(pose.pitch),
    sp = Math.sin(pose.pitch);
  const rx = dx * cy + z * sy,
    rz = -dx * sy + z * cy;
  const ry = dy * cp - rz * sp,
    depth = dy * sp + rz * cp;
  const scale = pose.focal / Math.max(pose.focal * 0.4, pose.focal + depth);
  return { x: pose.cx + rx * scale, y: pose.cy + ry * scale, z: depth, scale };
}

/** Inverse on one node's depth plane; keeps dragging under the pointer in perspective. */
export function unprojectDepth(x, y, z, pose) {
  let px = x,
    py = y;
  for (let i = 0; i < 6; i++) {
    const a = projectDepth(px, py, z, pose);
    const bx = projectDepth(px + 0.01, py, z, pose),
      by = projectDepth(px, py + 0.01, z, pose);
    const xx = (bx.x - a.x) / 0.01,
      xy = (by.x - a.x) / 0.01;
    const yx = (bx.y - a.y) / 0.01,
      yy = (by.y - a.y) / 0.01;
    const det = xx * yy - xy * yx;
    if (Math.abs(det) < 1e-8) break;
    px += ((x - a.x) * yy - (y - a.y) * xy) / det;
    py += ((y - a.y) * xx - (x - a.x) * yx) / det;
  }
  return { x: px, y: py };
}

/** How far in front of (−) or behind (+) the hub plane each kind floats, so the map reads in depth. */
const DEPTH_LAYERS = Object.freeze({
  agent: -96,
  rule: -90,
  instruction: -84,
  skill: -78,
  memory: -42,
  agent_account: -30,
  person: -24,
  source: 72,
});

/** A node's depth: its kind's layer plus a stable spread; hubs stay near the middle plane. */
export function depthFor(id, kind, hub = false) {
  const spread = hashUnit(`depth:${id}`) - 0.5;
  return hub ? spread * 36 : (DEPTH_LAYERS[kind] ?? 0) + spread * 110;
}

/** How far a travelling signal is along its connection, in [0, 1], or null while that connection rests. */
export function signalProgress(id, clock, period, travel) {
  if (!(period > 0) || !(travel > 0)) return null;
  const at = ((clock + hashUnit(`signal:${id}`) * period) % period) / travel;
  return at <= 1 ? at : null;
}

/** The control point that bows a connection to one side, the same side every time. */
export function curveControl(ax, ay, bx, by, bend) {
  return {
    x: (ax + bx) / 2 - (by - ay) * bend,
    y: (ay + by) / 2 + (bx - ax) * bend,
  };
}

// Drawing (browser only) -------------------------------------------------------------------------

const THEMES = {
  dark: {
    bg0: "#08090c",
    bg1: "#131920",
    dust: "#cfd8e6",
    dustAlpha: 0.5,
    edge: 0.26,
    edgeDim: 0.04,
    edgeActive: 0.92,
    membrane: 0.09,
    rim: 0.55,
    rimLight: "rgb(255 255 255 / 0.75)",
    halo: 0.38,
    shine: 0.34,
    cite: "#6ebcfc",
    labelBg: "rgb(21 25 28 / 0.97)",
    labelBorder: "#2d3135",
    labelText: "#eceff2",
    labelMuted: "#9da2a8",
    labelHalo: "rgb(8 9 12 / 0.88)",
    ring: "#f7b83d",
    dimAlpha: 0.14,
    glyphDark: "#0b0d10",
    glyphLight: "#ffffff",
  },
  light: {
    bg0: "#efebe4",
    bg1: "#fdfcf9",
    dust: "#5c554d",
    dustAlpha: 0.24,
    edge: 0.28,
    edgeDim: 0.05,
    edgeActive: 0.9,
    membrane: 0.075,
    rim: 0.5,
    rimLight: "rgb(255 255 255 / 0.95)",
    halo: 0.2,
    shine: 0.5,
    cite: "#116bb5",
    labelBg: "rgb(255 254 251 / 0.97)",
    labelBorder: "#dddad5",
    labelText: "#17130f",
    labelMuted: "#5a544f",
    labelHalo: "rgb(253 252 249 / 0.92)",
    ring: "#a15c00",
    dimAlpha: 0.16,
    glyphDark: "#17130f",
    glyphLight: "#ffffff",
  },
};

/** At most this many signals travel at once; the rest wait their turn. */
const MAX_SIGNALS = 240;
/** Ambient life redraws at about 30 frames a second; interaction still gets every frame. */
const LIVE_FRAME_MS = 33;
/** How long a live change keeps ringing on its node. */
const PULSE_MS = 4200;
const HOLLOW = new Set(["ring", "double-ring"]);
const DUST = Array.from({ length: 96 }, (_, index) => ({
  u: hashUnit(`dust:u:${index}`),
  v: hashUnit(`dust:v:${index}`),
  layer: index % 3,
  size: 0.7 + hashUnit(`dust:s:${index}`) * 1.2,
  phase: hashUnit(`dust:p:${index}`) * TAU,
}));

function luminance(hex) {
  const [r, g, b] = parseHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function mod(value, size) {
  return ((value % size) + size) % size;
}

/** A point on a quadratic curve, or on the straight line when there is no control point. */
function along(a, c, b, t) {
  if (!c) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

function bendOf(link) {
  if (typeof link.bend === "number") return link.bend;
  return (
    (hashUnit(`bend:${link.id ?? `${link.source}>${link.target}`}`) > 0.5
      ? 1
      : -1) * 0.14
  );
}

/** Typed connections: the line itself says what it means. */
function relationStroke(relation, theme) {
  if (relation === "cites")
    return { color: theme.cite, dash: [2, 3.5], alpha: 0.55 };
  if (relation === "owns")
    return { color: theme.ring, dash: [1, 3], alpha: 0.5 };
  if (relation === "runs_as") return { color: null, dash: [5, 4], alpha: 0.5 };
  return { color: null, dash: null, alpha: 0.45 };
}

const sprites = new Map();
function sprite(key, paint) {
  let canvas = sprites.get(key);
  if (!canvas) {
    canvas =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(64, 64)
        : Object.assign(document.createElement("canvas"), {
            width: 64,
            height: 64,
          });
    paint(canvas.getContext("2d"));
    sprites.set(key, canvas);
  }
  return canvas;
}

/** Soft light around a node or a travelling signal, in its colour. */
function haloSprite(color) {
  return sprite(`halo|${color}`, (g) => {
    const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, withAlpha(color, 0.85));
    gradient.addColorStop(0.3, withAlpha(color, 0.3));
    gradient.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = gradient;
    g.fillRect(0, 0, 64, 64);
  });
}

/** The highlight that makes a flat disc read as a lit sphere. */
function shineSprite() {
  return sprite("shine", (g) => {
    const gradient = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgb(255 255 255 / 0.9)");
    gradient.addColorStop(1, "rgb(255 255 255 / 0)");
    g.fillStyle = gradient;
    g.fillRect(0, 0, 64, 64);
  });
}

/**
 * Draws a network on a canvas. `getStyle()` is asked for the current look every frame; the
 * engine owns positions, camera, animation, and hit testing.
 */
export function createGraphView(canvas, options = {}) {
  const ctx = canvas.getContext("2d", { alpha: false });
  const reduceMotion = options.reduceMotion ?? false;
  const cells = options.cells === true;
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
  const textWidth = new Map();
  const glyphCache = new Map();
  let labelBoxes = [];
  const groupShapes = new Map();
  const projected = new Map();
  // Under reduced motion the map is flat and still: no depth, orbit, breathing, or signals.
  let depthEnabled = !reduceMotion,
    motionEnabled = !reduceMotion,
    dragging = false;
  let pointer = { x: 0, y: 0 },
    targetPointer = { x: 0, y: 0 };
  let pose = { cx: 0, cy: 0, yaw: 0.16, pitch: -0.1, focal: 1100 };
  let lastDraw = 0;
  let linkById = new Map();
  // Live changes ring out from their node for a few seconds; new records ring twice.
  const pulses = new Map();
  const depthCache = new Map();
  function depthOf(id) {
    let z = depthCache.get(id);
    if (z === undefined) {
      const node = byId.get(id);
      z = depthFor(id, node?.kind, node?.hub ?? false);
      depthCache.set(id, z);
    }
    return z;
  }
  function renderPosition(id) {
    if (projected.has(id)) return projected.get(id);
    const raw = sim?.position(id);
    if (!raw) return null;
    const point = depthEnabled
      ? projectDepth(raw.x, raw.y, depthOf(id), pose)
      : { ...raw, z: 0, scale: 1 };
    const result = { ...point, r: raw.r * point.scale };
    projected.set(id, result);
    return result;
  }
  if (typeof document !== "undefined" && canvas.parentElement) {
    canvas.addEventListener("pointermove", (event) => {
      if (event.buttons || reduceMotion || !motionEnabled) return;
      const rect = canvas.getBoundingClientRect();
      targetPointer = {
        x: ((event.clientX - rect.left) / rect.width - 0.5) * 2,
        y: ((event.clientY - rect.top) / rect.height - 0.5) * 2,
      };
      dirty = true;
      schedule();
    });
    canvas.addEventListener("pointerleave", () => {
      targetPointer = { x: 0, y: 0 };
      dirty = true;
      schedule();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        lastTime = 0;
        dirty = true;
        schedule();
      }
    });
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
    linkById = new Map(
      links.filter((link) => link.id != null).map((link) => [link.id, link]),
    );
    depthCache.clear();
    projected.clear();
    if (grow) {
      sim = growSimulation(
        previous,
        { nodes, links },
        { alpha: options.alpha, positions: options.positions, cells },
      );
    } else {
      sim = createSimulation({ nodes, links, cells });
    }
    if (!grow || !previous) {
      // Most of the settling happens before the first frame, so the map arrives almost in place.
      const warm = reduceMotion
        ? 420
        : Math.max(
            40,
            Math.min(240, Math.round(60000 / Math.max(nodes.length, 1))),
          );
      sim.settle(warm);
      // Keep large maps behind the near plane without moving existing nodes when a group opens.
      let extent = 0;
      for (let i = 0; i < nodes.length; i++)
        extent = Math.max(extent, Math.hypot(sim.xs[i], sim.ys[i]));
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
    return {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      r: Math.max(40, Math.hypot(maxX - minX, maxY - minY) / 2),
    };
  }

  function frameTarget(
    x,
    y,
    r,
    margin = 48,
    insets = { left: 0, right: 0, top: 0, bottom: 0 },
  ) {
    const w = width - insets.left - insets.right - margin * 2;
    const h = height - insets.top - insets.bottom - margin * 2;
    const k = clampK(
      Math.min(Math.max(w, 80) / (2 * r), Math.max(h, 80) / (2 * r)),
    );
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
    cameraAnimation = {
      from: { ...camera },
      to: goal,
      start: performance.now(),
      duration,
    };
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
      if (
        sx >= box.x &&
        sx <= box.x + box.w &&
        sy >= box.y &&
        sy <= box.y + box.h
      ) {
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
    if (frameHandle || (typeof document !== "undefined" && document.hidden))
      return;
    frameHandle = requestAnimationFrame(loop);
  }

  /** True while the map moves on its own: breathing, travelling signals, and a slow orbit. */
  function living() {
    return motionEnabled && !reduceMotion && sim !== null && nodes.length > 0;
  }

  function animating() {
    if (typeof document !== "undefined" && document.hidden) return false;
    if (cameraAnimation) return true;
    if (sim && sim.running() && !reduceMotion) return true;
    if (pulses.size > 0 && motionEnabled) return true;
    return living();
  }

  function loop(now) {
    frameHandle = 0;
    const dt = lastTime === 0 ? 16 : Math.min(now - lastTime, 50);
    lastTime = now;
    if (motionEnabled && !dragging) clock += dt;
    if (cameraAnimation) {
      const t = Math.min(
        (now - cameraAnimation.start) / cameraAnimation.duration,
        1,
      );
      const ease = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const { from, to } = cameraAnimation;
      camera.k = from.k * Math.pow(to.k / from.k, ease);
      // Keep the screen center on a straight path in world space while the zoom changes.
      const fromCenter = {
        x: (width / 2 - from.x) / from.k,
        y: (height / 2 - from.y) / from.k,
      };
      const toCenter = {
        x: (width / 2 - to.x) / to.k,
        y: (height / 2 - to.y) / to.k,
      };
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
    if (living() && now - lastDraw >= LIVE_FRAME_MS) dirty = true;
    if (dirty) {
      draw();
      lastDraw = now;
      dirty = false;
      for (const fn of listeners.frame) fn();
    }
    if (animating()) schedule();
    else lastTime = 0;
  }

  function drawBackground() {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    // A faint lift in the middle of the field, so the map reads as space rather than paper.
    const cx = width * 0.5;
    const cy = height * 0.46;
    const field = ctx.createRadialGradient(
      cx,
      cy,
      0,
      cx,
      cy,
      Math.hypot(width, height) * 0.62,
    );
    field.addColorStop(0, theme.bg1);
    field.addColorStop(1, theme.bg0);
    ctx.fillStyle = field;
    ctx.fillRect(0, 0, width, height);
    // Dust in three depths moves less than the map when you pan and drifts on its own: parallax.
    ctx.fillStyle = theme.dust;
    for (const mote of DUST) {
      const depth = 0.06 + mote.layer * 0.07;
      const x = mod(
        mote.u * width +
          camera.x * depth +
          pointer.x * 10 * (mote.layer + 1) +
          clock * 0.0025 * (mote.layer + 1),
        width,
      );
      const y = mod(
        mote.v * height +
          camera.y * depth +
          pointer.y * 8 * (mote.layer + 1) +
          Math.sin(clock * 0.0003 + mote.phase) * 5,
        height,
      );
      ctx.globalAlpha =
        theme.dustAlpha *
        (0.3 + mote.layer * 0.22) *
        (0.65 + 0.35 * Math.sin(clock * 0.0011 + mote.phase));
      ctx.fillRect(x, y, mote.size, mote.size);
    }
    ctx.globalAlpha = 1;
  }

  /** Closed curve through the points: the soft outline of a cell. */
  function smoothClosed(points) {
    const count = points.length;
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 0; index < count; index += 1) {
      const p0 = points[(index - 1 + count) % count];
      const p1 = points[index];
      const p2 = points[(index + 1) % count];
      const p3 = points[(index + 2) % count];
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6,
        p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6,
        p2.y - (p3.y - p1.y) / 6,
        p2.x,
        p2.y,
      );
    }
    ctx.closePath();
  }

  /** A group as a living cell: a tinted body with a lit rim that slowly ripples. */
  function drawMembrane(id, shape, color, fill, rim, live) {
    const phase = hashUnit(`cell:${id}`) * TAU;
    const ripple = live ? Math.min(5, shape.r * 0.04) : 0;
    // The rim swells in three slow lobes around the cell, so the outline stays smooth.
    const wave = (angle) =>
      Math.sin(clock * 0.0011 + angle * 3 + phase) * ripple;
    let points;
    if (shape.hull && shape.hull.length >= 3) {
      points = shape.hull.map((point) => {
        if (!ripple) return point;
        const dx = point.x - shape.x;
        const dy = point.y - shape.y;
        const length = Math.hypot(dx, dy) || 1;
        const swell = wave(Math.atan2(dy, dx));
        return {
          x: point.x + (dx / length) * swell,
          y: point.y + (dy / length) * swell,
        };
      });
    } else {
      points = Array.from({ length: 10 }, (_, index) => {
        const angle = (index / 10) * TAU;
        const reach = shape.r + wave(angle);
        return {
          x: shape.x + Math.cos(angle) * reach,
          y: shape.y + Math.sin(angle) * reach,
        };
      });
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    ctx.beginPath();
    smoothClosed(points);
    ctx.fillStyle = withAlpha(color, fill);
    ctx.fill();
    const edge = ctx.createLinearGradient(minX, minY, maxX, maxY);
    edge.addColorStop(0, theme.rimLight);
    edge.addColorStop(0.45, withAlpha(color, 0.9));
    edge.addColorStop(1, withAlpha(color, 0.25));
    ctx.globalAlpha = rim;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.3 / camera.k;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Each node breathes; hubs slower and stronger, and recent activity sparks brighter and more often. */
  function glowOf(node) {
    const activity = node.activity ?? 0;
    const base = theme.halo * (node.hub ? 1 : 0.5) * (0.75 + activity * 0.6);
    if (!living()) return base;
    const breath =
      0.5 +
      0.5 *
        Math.sin(
          clock * (node.hub ? 0.0011 : 0.0017) +
            hashUnit(`breath:${node.id}`) * TAU,
        );
    const period =
      7000 + (1 - activity) * 9000 + hashUnit(`fire:${node.id}`) * 5000;
    const since = (clock + hashUnit(`spark:${node.id}`) * period) % period;
    const spark = since < 650 ? (1 - since / 650) * (0.3 + activity * 0.6) : 0;
    return base * (0.7 + 0.5 * breath) + spark;
  }

  /** The sign inside a node says what it is: a pull request, a decision, a repository. */
  function drawGlyph(node, x, y, r, color, hollow) {
    const paths = glyphPaths(node.glyph);
    if (!paths) return;
    ctx.save();
    ctx.translate(x, y);
    const g = (r / 11) * (hollow ? 0.6 : 0.82);
    ctx.scale(g, g);
    const ink = hollow
      ? color
      : luminance(color) > 0.6
        ? theme.glyphDark
        : theme.glyphLight;
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.8;
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

  /** Signals travel along a sample of connections, and continuously along the selection's. */
  function drawSignals(s, isShown, inView, highlighting) {
    const k = camera.k;
    const flow = s.flow instanceof Set ? s.flow : null;
    const ambient = !highlighting && Array.isArray(s.ambient) ? s.ambient : [];
    let budget = MAX_SIGNALS;
    const fire = (link, active) => {
      if (
        budget <= 0 ||
        link.hidden ||
        !isShown(link.source) ||
        !isShown(link.target)
      )
        return;
      const source = renderPosition(link.source);
      const target = renderPosition(link.target);
      if (!source || !target) return;
      const span = Math.hypot(target.x - source.x, target.y - source.y);
      if (
        span * k < 8 ||
        !inView(
          (source.x + target.x) / 2,
          (source.y + target.y) / 2,
          span / 2 + 6,
        )
      )
        return;
      // Evidence flows into the memory that cites it; every other connection runs source to target.
      const reverse = link.relation === "cites";
      const a = reverse ? target : source;
      const b = reverse ? source : target;
      const travel = Math.max(520, Math.min(2600, (span * k) / 0.2));
      const activity = Math.max(
        byId.get(link.source)?.activity ?? 0,
        byId.get(link.target)?.activity ?? 0,
      );
      const period = active
        ? travel + 160
        : travel +
          1600 +
          hashUnit(`rest:${link.id}`) * 5200 * (1 - 0.6 * activity);
      const t = signalProgress(
        link.id ?? `${link.source}>${link.target}`,
        clock,
        period,
        travel,
      );
      if (t === null) return;
      budget -= 1;
      const c = link.structure
        ? null
        : curveControl(source.x, source.y, target.x, target.y, bendOf(link));
      const color =
        link.color ??
        byId.get(link.structure ? link.target : link.source)?.color ??
        "#ffffff";
      const fade = Math.min(1, t / 0.12, (1 - t) / 0.12);
      const head = along(a, c, b, t);
      const glow = (active ? 9 : 6) / k;
      ctx.globalAlpha = (active ? 0.95 : 0.7) * fade;
      ctx.drawImage(
        haloSprite(color),
        head.x - glow,
        head.y - glow,
        glow * 2,
        glow * 2,
      );
      ctx.fillStyle = themeName === "dark" ? "#ffffff" : color;
      for (let step = 0; step < 4; step += 1) {
        const at = t - step * 0.03;
        if (at < 0) break;
        const point = step === 0 ? head : along(a, c, b, at);
        ctx.globalAlpha = (active ? 1 : 0.85) * fade * (1 - step * 0.26);
        ctx.beginPath();
        ctx.arc(
          point.x,
          point.y,
          ((active ? 2.1 : 1.5) * (1 - step * 0.18)) / k,
          0,
          TAU,
        );
        ctx.fill();
      }
    };
    if (flow)
      for (const id of flow) {
        const link = linkById.get(id);
        if (link) fire(link, true);
      }
    for (const link of ambient) fire(link, false);
    ctx.globalAlpha = 1;
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
      if (center)
        center.spread += Math.hypot(
          renderPosition(node.id).x - center.x,
          renderPosition(node.id).y - center.y,
        );
    }
    for (const [id, c] of centers) {
      groupShapes.set(id, {
        x: c.x,
        y: c.y,
        r: (c.spread / c.n) * 1.6 + 30,
        n: c.n,
        points: [],
        reach: 0,
      });
    }
    // Territory outlines: a rounded hull around the hub and its own members, the same disc the
    // cells keep apart, so a cell of two records is a small capsule rather than a wide circle.
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!sim.active[i]) continue;
      if (style?.visible && !style.visible.has(node.id)) continue;
      const groupId = node.hub ? node.id : node.group;
      const shape = groupShapes.get(groupId);
      if (!shape) continue;
      const point = renderPosition(node.id);
      if (!point) continue;
      shape.points.push({ x: point.x, y: point.y });
      shape.reach = Math.max(shape.reach, point.r);
    }
    for (const shape of groupShapes.values()) {
      if (shape.points.length === 0) {
        shape.hull = null;
        continue;
      }
      const pad = 18 + shape.reach;
      const ring = [];
      for (const point of convexHull(shape.points)) {
        for (let step = 0; step < 10; step += 1) {
          const angle = (step / 10) * TAU;
          ring.push({
            x: point.x + Math.cos(angle) * pad,
            y: point.y + Math.sin(angle) * pad,
          });
        }
      }
      shape.hull = convexHull(ring);
      let sx = 0;
      let sy = 0;
      for (const point of shape.points) {
        sx += point.x;
        sy += point.y;
      }
      shape.x = sx / shape.points.length;
      shape.y = sy / shape.points.length;
      let far = 0;
      for (const point of shape.hull)
        far = Math.max(far, Math.hypot(point.x - shape.x, point.y - shape.y));
      shape.r = far;
    }
  }

  function draw() {
    projected.clear();
    const now = typeof performance === "object" ? performance.now() : 0;
    if (sim && depthEnabled) {
      const moving = motionEnabled && !reduceMotion && !dragging;
      if (moving) {
        pointer.x += (targetPointer.x - pointer.x) * 0.07;
        pointer.y += (targetPointer.y - pointer.y) * 0.07;
        pose = {
          ...pose,
          yaw: 0.16 + Math.sin(clock / 15000) * 0.15 + pointer.x * 0.2,
          pitch: -0.1 + Math.cos(clock / 19000) * 0.07 + pointer.y * 0.13,
        };
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
    const live = living();
    ctx.setTransform(
      ratio * k,
      0,
      0,
      ratio * k,
      ratio * camera.x,
      ratio * camera.y,
    );
    const view = {
      x0: -camera.x / k,
      y0: -camera.y / k,
      x1: (width - camera.x) / k,
      y1: (height - camera.y) / k,
    };
    const inView = (x, y, r) =>
      x + r >= view.x0 &&
      x - r <= view.x1 &&
      y + r >= view.y0 &&
      y - r <= view.y1;
    const isShown = (id) => !visible || visible.has(id);
    // Things further back fade a little, the way depth reads in air.
    const fogOf = (scale) =>
      depthEnabled ? Math.max(0.5, Math.min(1, 0.5 + (scale - 0.88) * 2)) : 1;

    computeGroups();
    for (const [id, shape] of groupShapes) {
      const hub = byId.get(id);
      if (!hub || !isShown(id) || !inView(shape.x, shape.y, shape.r + 40))
        continue;
      const heat = s.heat?.get(id) ?? 0;
      const focused = s.focusGroups?.has(id) ?? false;
      let fill = theme.membrane + heat * 0.08;
      let rim = theme.rim;
      if (focused) {
        fill = theme.membrane * 1.6;
        rim = Math.min(1, theme.rim * 1.4);
      }
      if (highlighting && !focused && !near.has(id)) {
        fill *= 0.35;
        rim *= 0.35;
      }
      drawMembrane(id, shape, hub.color, fill, rim, live);
    }

    // Connections: spokes inside each cell, quiet lines between hubs, typed and gently bowed relations.
    const lineWidth =
      (Math.max(0.5, 0.9 / Math.sqrt(k)) / k) *
      Math.min(1.6, Math.sqrt(k) + 0.3);
    const batches = new Map();
    const bright = [];
    for (const link of links) {
      if (link.hidden) continue;
      if (!isShown(link.source) || !isShown(link.target)) continue;
      if (s.drawEdges && !s.drawEdges.has(link.id) && !link.structure) continue;
      const a = renderPosition(link.source);
      const b = renderPosition(link.target);
      if (!a || !b) continue;
      if (
        !inView(
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
          Math.hypot(a.x - b.x, a.y - b.y) / 2 + 4,
        )
      )
        continue;
      if (activeEdges.has(link.id)) {
        bright.push({ link, a, b });
        continue;
      }
      const from = byId.get(link.source);
      const to = byId.get(link.target);
      const between = Boolean(from?.hub && to?.hub);
      let color;
      let alpha;
      let dash = null;
      let curve = null;
      let width = lineWidth;
      if (link.structure) {
        color =
          link.color ?? (between ? theme.labelMuted : (to?.color ?? "#888888"));
        alpha = theme.edge * (between ? 0.9 : 0.6);
        width = lineWidth * (between ? 1.3 : 0.8);
      } else {
        const stroke = relationStroke(link.relation, theme);
        color = link.color ?? stroke.color ?? from?.color ?? "#888888";
        alpha = stroke.alpha;
        dash = stroke.dash;
        curve = curveControl(a.x, a.y, b.x, b.y, bendOf(link));
      }
      if (highlighting) alpha = theme.edgeDim;
      alpha *= Math.round(fogOf((a.scale + b.scale) / 2) * 4) / 4;
      const key = `${color}|${alpha.toFixed(3)}|${dash ? dash.join(",") : ""}|${width.toFixed(4)}`;
      let batch = batches.get(key);
      if (!batch) {
        batch = { color, alpha, dash, width, items: [] };
        batches.set(key, batch);
      }
      batch.items.push(a, b, curve);
    }
    ctx.lineCap = "round";
    for (const batch of batches.values()) {
      ctx.strokeStyle = withAlpha(batch.color, batch.alpha);
      ctx.lineWidth = batch.width;
      ctx.setLineDash(batch.dash ? batch.dash.map((part) => part / k) : []);
      ctx.beginPath();
      for (let i = 0; i < batch.items.length; i += 3) {
        const a = batch.items[i];
        const b = batch.items[i + 1];
        const c = batch.items[i + 2];
        ctx.moveTo(a.x, a.y);
        if (c) ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
        else ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const { link, a, b } of bright) {
      const source = byId.get(link.structure ? link.target : link.source);
      const color = link.color ?? source?.color ?? "#ffffff";
      const c = link.structure
        ? null
        : curveControl(a.x, a.y, b.x, b.y, bendOf(link));
      const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      gradient.addColorStop(0, withAlpha(color, theme.edgeActive));
      gradient.addColorStop(
        1,
        withAlpha(
          byId.get(link.target)?.color ?? color,
          theme.edgeActive * 0.75,
        ),
      );
      ctx.strokeStyle = gradient;
      ctx.lineWidth = Math.max(1.6 / k, lineWidth * 2.2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      if (c) ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
      else ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (!link.structure) {
        // An arrowhead on the target's rim shows which way the connection reads.
        const angle = Math.atan2(b.y - (c?.y ?? a.y), b.x - (c?.x ?? a.x));
        const size = 7 / k;
        const tx = b.x - Math.cos(angle) * (b.r + 1.5 / k);
        const ty = b.y - Math.sin(angle) * (b.r + 1.5 / k);
        ctx.fillStyle = withAlpha(color, 0.95);
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(
          tx - Math.cos(angle - 0.42) * size,
          ty - Math.sin(angle - 0.42) * size,
        );
        ctx.lineTo(
          tx - Math.cos(angle + 0.42) * size,
          ty - Math.sin(angle + 0.42) * size,
        );
        ctx.closePath();
        ctx.fill();
      }
    }
    if (live) drawSignals(s, isShown, inView, highlighting);

    // Nodes: lit spheres with a sign inside, drawn far to near; dots when far away.
    const drawOrder = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!sim.active[i] || !isShown(node.id)) continue;
      const point = renderPosition(node.id);
      const { x, y, r } = point;
      if (!inView(x, y, r * 4)) continue;
      const dim = highlighting && !near.has(node.id);
      drawOrder.push({ node, x, y, r, dim, i, z: point.z, scale: point.scale });
    }
    drawOrder.sort(
      (a, b) => Number(!a.dim) - Number(!b.dim) || b.z - a.z || a.r - b.r,
    );
    const tierOf = assignTiers(
      drawOrder.map((item) => ({
        id: item.node.id,
        hub: item.node.hub,
        inViewport: true,
        priority: item.node.hub
          ? 6000 + (item.node.weight ?? 0)
          : 1000 + (item.node.weight ?? 0) + item.r,
        selected: s.selected === item.node.id,
        hovered: s.hovered === item.node.id,
        pinned: s.pins?.has(item.node.id) ?? false,
      })),
      k,
    );
    for (const item of drawOrder) item.tier = tierOf.get(item.node.id) ?? "far";
    for (const item of drawOrder) {
      const { node, x, y, dim } = item;
      const r = Math.max(item.r, 2.2 / k);
      const sr = r * k;
      const fog = fogOf(item.scale);
      const ring = kindShape(node.kind);
      const hollow = HOLLOW.has(ring);
      const color = node.retired ? "#8a8f99" : node.color;
      if (!dim && (sr >= 1.6 || node.hub)) {
        const glow = glowOf(node);
        if (glow > 0.02) {
          const reach = r * (node.hub ? 3.4 : 2.9);
          ctx.globalAlpha = Math.min(1, glow * fog);
          ctx.drawImage(
            haloSprite(color),
            x - reach,
            y - reach,
            reach * 2,
            reach * 2,
          );
        }
      }
      const body = (dim ? theme.dimAlpha : node.retired ? 0.55 : 1) * fog;
      ctx.globalAlpha = body;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      if (hollow) {
        ctx.fillStyle = theme.bg0;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(r * 0.26, 1.2 / k);
        ctx.stroke();
        if (ring === "double-ring") {
          ctx.beginPath();
          ctx.arc(x, y, r * 0.58, 0, TAU);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = color;
        ctx.fill();
        if (!dim && sr >= 4) {
          ctx.globalAlpha = body * theme.shine;
          ctx.drawImage(
            shineSprite(),
            x - r * 0.78,
            y - r * 0.85,
            r * 1.05,
            r * 1.05,
          );
          ctx.globalAlpha = body;
        }
      }
      if (!dim && sr >= (node.hub ? 6 : 7))
        drawGlyph(node, x, y, r, color, hollow);
      // A slow heartbeat ring from hubs and the selection.
      if (live && !dim && (node.hub || s.selected === node.id)) {
        const period =
          s.selected === node.id ? 2200 : 5200 - (node.activity ?? 0) * 2200;
        const beat =
          ((clock + hashUnit(`beat:${node.id}`) * period) % period) / 1700;
        if (beat <= 1) {
          ctx.globalAlpha = (1 - beat) * 0.4 * fog;
          ctx.strokeStyle = s.selected === node.id ? theme.ring : color;
          ctx.lineWidth = 1.2 / k;
          ctx.beginPath();
          ctx.arc(x, y, r * (1.15 + beat * 1.5), 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = body;
        }
      }
      // State marks: a dot for work waiting, a ring for the selection, pins, and impact depth.
      if (!dim && node.badge && sr >= 4) {
        ctx.fillStyle = node.badge;
        ctx.beginPath();
        ctx.arc(
          x + r * 0.72,
          y - r * 0.72,
          Math.max(r * 0.32, 2.4 / k),
          0,
          TAU,
        );
        ctx.fill();
        ctx.strokeStyle = theme.bg0;
        ctx.lineWidth = 1.2 / k;
        ctx.stroke();
      }
      const impact = s.impact?.get(node.id) ?? 0;
      const ringed =
        s.selected === node.id ||
        s.pins?.has(node.id) ||
        impact > 0 ||
        s.hovered === node.id;
      if (ringed && !dim) {
        ctx.strokeStyle =
          s.selected === node.id
            ? theme.ring
            : impact > 0
              ? ["", "#f66d67", "#f39762", "#f7b83d"][Math.min(impact, 3)]
              : withAlpha(node.color, 0.9);
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
      const pulse = pulses.get(node.id);
      if (pulse) {
        const age = now - pulse.at;
        if (age >= PULSE_MS) pulses.delete(node.id);
        else if (!dim) {
          ctx.strokeStyle = theme.cite;
          ctx.lineWidth = (pulse.strong ? 2 : 1.5) / k;
          if (live) {
            for (let ring = 0; ring < (pulse.strong ? 2 : 1); ring += 1) {
              const t = ((age + ring * 700) % 1400) / 1400;
              ctx.globalAlpha = (1 - t) * 0.9 * fog;
              ctx.beginPath();
              ctx.arc(x, y, r + (4 + t * 24) / k, 0, TAU);
              ctx.stroke();
            }
          } else {
            ctx.globalAlpha = 0.9 * fog;
            ctx.beginPath();
            ctx.arc(x, y, r + 5 / k, 0, TAU);
            ctx.stroke();
          }
          ctx.globalAlpha = body;
        }
      }
    }
    ctx.globalAlpha = 1;

    // Names and cards in screen space, rationed so none overlap.
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const candidates = [];
    // Screen areas the page covers with its own panels: no name is placed under them.
    const obstacles = [...(s.avoid ?? [])];
    const showNames = s.labels !== false;
    for (const item of drawOrder) {
      const { node, x, y, dim } = item;
      const sx = x * k + camera.x;
      const sy = y * k + camera.y;
      const sr = Math.max(item.r, 2.2 / k) * k;
      // A name never covers another node; tiny far dots do not count.
      if (!dim && sr >= 3)
        obstacles.push({
          id: node.id,
          x: sx - sr,
          y: sy - sr,
          w: sr * 2,
          h: sr * 2,
        });
      const selectedNode = s.selected === node.id;
      const hoveredNode = s.hovered === node.id;
      const tier = item.tier ?? "far";
      // Cards only for what you are looking at; everything else keeps a plain name.
      const carded =
        !node.hub &&
        (selectedNode || hoveredNode || (s.pins?.has(node.id) ?? false));
      if (tier === "near" && node.card && !dim && carded) {
        const w = width < 480 ? 224 : 248;
        const h = node.card.attention ? 94 : 78;
        candidates.push({
          id: node.id,
          hub: node.hub,
          card: node.card,
          color: node.color,
          selected: selectedNode,
          hovered: hoveredNode,
          priority: selectedNode
            ? 30000
            : s.pins?.has(node.id)
              ? 25000
              : 15000 + (node.weight ?? 0),
          force: selectedNode || hoveredNode,
          x: sx - w / 2,
          y: sy - Math.max(sr, 3) - h - 10,
          w,
          h,
        });
        continue;
      }
      let priority = -1;
      if (selectedNode) priority = 10000;
      else if (hoveredNode) priority = 9000;
      else if (!showNames) continue;
      else if (dim) continue;
      else if (tier === "far" && !node.hub && !s.pins?.has(node.id)) continue;
      else if (s.pins?.has(node.id)) priority = 8000;
      else if (node.hub)
        priority = 6000 - node.depth * 500 + Math.min(node.weight ?? 0, 400);
      else if (highlighting && near.has(node.id)) priority = 4000 + sr;
      else if (tier === "mid" || sr >= (node.labelAt ?? 7))
        priority = 1000 + sr * 10 + (node.weight ?? 0);
      if (priority < 0) continue;
      const hub = node.hub;
      const font = hub
        ? `600 ${node.depth === 0 ? 13 : 12}px ${FONT}`
        : `500 11px ${FONT}`;
      // Inside its own cell a member drops the cell's name: "#101008" beside the next.js hub.
      const parent = hub ? null : byId.get(node.group);
      const name =
        !selectedNode &&
        !hoveredNode &&
        parent?.label &&
        node.label.startsWith(`${parent.label} `)
          ? node.label.slice(parent.label.length + 1)
          : node.label;
      const text = clip(name, hub ? 30 : selectedNode || hoveredNode ? 60 : 30);
      // A cell's name sits under its hub with what it holds, so the outline needs no second tag.
      const shape = hub ? groupShapes.get(node.id) : null;
      const pending = node.pending ?? 0;
      const sub = shape
        ? `${shape.n} ${shape.n === 1 ? "item" : "items"}${pending > 0 ? ` · ${pending} waiting` : ""}`
        : null;
      const subFont = `500 10.5px ${FONT}`;
      const w =
        Math.max(measure(text, font), sub ? measure(sub, subFont) : 0) + 8;
      const h = hub ? (sub ? 31 : 17) : 15;
      const below = sy + sr + (hub ? 6 : 3);
      candidates.push({
        id: node.id,
        hub,
        text,
        font,
        sub,
        subFont,
        color: node.color,
        selected: selectedNode,
        hovered: hoveredNode,
        priority,
        force: selectedNode || hoveredNode,
        x: sx - w / 2,
        y: below,
        w,
        h,
        // Below first, then above, right and left of the node.
        alts: [
          { x: sx - w / 2, y: sy - sr - h - 3 },
          { x: sx + sr + 4, y: sy - h / 2 },
          { x: sx - sr - 4 - w, y: sy - h / 2 },
        ],
      });
    }
    labelBoxes = pickLabels(candidates, {
      width,
      height,
      limit: s.labelLimit ?? 260,
      obstacles,
    });
    for (const box of labelBoxes) {
      if (box.card) {
        const { card } = box;
        ctx.beginPath();
        ctx.roundRect(box.x, box.y, box.w, box.h, 8);
        ctx.fillStyle = theme.labelBg;
        ctx.fill();
        ctx.strokeStyle = box.selected ? theme.ring : theme.labelBorder;
        ctx.lineWidth = box.selected ? 1.5 : 1;
        ctx.stroke();
        ctx.fillStyle = box.color;
        ctx.fillRect(box.x, box.y + 8, 3, box.h - 16);
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        ctx.font = `600 10px ${FONT}`;
        ctx.fillStyle = theme.labelMuted;
        ctx.fillText(
          `${card.kindLabel} · ${card.statusLabel}`,
          box.x + 12,
          box.y + 17,
        );
        ctx.font = `500 12.5px ${FONT}`;
        ctx.fillStyle = theme.labelText;
        card.lines.forEach((line, index) => {
          ctx.fillText(line, box.x + 12, box.y + 35 + index * 15);
        });
        ctx.font = `11px ${FONT}`;
        ctx.fillStyle = theme.labelMuted;
        ctx.fillText(
          card.meta ?? "",
          box.x + 12,
          box.y + 35 + card.lines.length * 15 + 4,
        );
        if (card.attention) {
          ctx.fillStyle = themeName === "dark" ? "#ffb547" : "#9a5700";
          ctx.fillText(card.attention, box.x + 12, box.y + box.h - 8);
        }
        continue;
      }
      // Plain names with a soft outline of the field behind them, readable over any cell.
      const cx = box.x + box.w / 2;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = theme.labelHalo;
      ctx.font = box.font;
      ctx.strokeText(box.text, cx, box.y);
      ctx.globalAlpha = box.hub || box.selected || box.hovered ? 1 : 0.86;
      ctx.fillStyle = box.selected ? theme.ring : theme.labelText;
      ctx.fillText(box.text, cx, box.y);
      ctx.globalAlpha = 1;
      if (box.sub) {
        ctx.font = box.subFont;
        ctx.strokeText(box.sub, cx, box.y + 16);
        ctx.fillStyle = theme.labelMuted;
        ctx.fillText(box.sub, cx, box.y + 16);
      }
    }
  }

  const FONT =
    options.font ??
    (typeof getComputedStyle === "function"
      ? getComputedStyle(canvas).getPropertyValue("--font").trim() ||
        "system-ui"
      : "system-ui");

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
    /** Pauses the map's own motion, for example while a sheet covers it. */
    setMotion(on) {
      motionEnabled = Boolean(on) && !reduceMotion;
      dirty = true;
      schedule();
    },
    /** Marks records that just changed; `strong` for ones that are new. */
    pulse(ids, strong = false) {
      const at = typeof performance === "object" ? performance.now() : 0;
      for (const id of ids) pulses.set(id, { at, strong });
      dirty = true;
      schedule();
      // Without motion the mark is a still ring, cleared by one later redraw.
      if (!motionEnabled && typeof setTimeout === "function")
        setTimeout(() => {
          dirty = true;
          schedule();
        }, PULSE_MS + 60);
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
      const raw = depthEnabled
        ? unprojectDepth(x, y, depthOf(id), pose)
        : { x, y };
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
