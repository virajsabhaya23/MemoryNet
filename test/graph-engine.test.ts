import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  clip,
  createGraphView,
  createSimulation,
  growPositions,
  growSimulation,
  hashUnit,
  pickLabels,
  seedPositions,
  withAlpha,
  type EngineLink,
  type EngineNode,
} from "../src/web/assets/graph-engine.js";

/** An organization-shaped graph: one root, units, projects, and members with links between pairs. */
function orgGraph(units: number, projects: number, members: number) {
  const nodes: EngineNode[] = [{ id: "org", group: null, hub: true, r: 14 }];
  const links: EngineLink[] = [];
  for (let u = 0; u < units; u += 1) {
    const unit = `u${u}`;
    nodes.push({ id: unit, group: "org", hub: true, r: 11 });
    links.push({ source: unit, target: "org" });
    for (let p = 0; p < projects; p += 1) {
      const project = `${unit}p${p}`;
      nodes.push({ id: project, group: unit, hub: true, r: 9 });
      links.push({ source: project, target: unit });
      for (let m = 0; m < members; m += 1) {
        const id = `${project}m${m}`;
        nodes.push({ id, group: project, r: 5 });
        links.push({ source: id, target: project, strength: 0.4 });
        if (m % 2 === 1) links.push({ source: id, target: `${project}m${m - 1}` });
      }
    }
  }
  return { nodes, links };
}

test("hashUnit is stable and spread over [0, 1)", () => {
  assert.equal(hashUnit("memory:1"), hashUnit("memory:1"));
  const values = Array.from({ length: 200 }, (_, i) => hashUnit(`n${i}`));
  assert.ok(values.every((v) => v >= 0 && v < 1));
  assert.ok(Math.max(...values) - Math.min(...values) > 0.8);
});

test("seeds put the root in the middle, every node somewhere, and members near their hub", () => {
  const { nodes } = orgGraph(3, 4, 12);
  const seeds = seedPositions(nodes);
  assert.equal(seeds.size, nodes.length);
  assert.deepEqual(seeds.get("org"), { x: 0, y: 0 });
  for (const node of nodes) {
    const p = seeds.get(node.id);
    assert.ok(p && Number.isFinite(p.x) && Number.isFinite(p.y), node.id);
    if (!node.hub && node.group) {
      const hub = seeds.get(node.group);
      assert.ok(hub);
      assert.ok(Math.hypot(p.x - hub.x, p.y - hub.y) < 80, `${node.id} starts near its hub`);
    }
  }
});

test("the simulation settles, is deterministic, and keeps groups together and apart", () => {
  const graph = orgGraph(4, 5, 16);
  const run = () => {
    const sim = createSimulation(graph);
    const used = sim.settle(600);
    return { sim, used };
  };
  const first = run();
  const second = run();
  assert.ok(!first.sim.running(), "it cools down within the budget");
  assert.ok(first.used < 600);
  for (const node of graph.nodes) {
    assert.deepEqual(first.sim.position(node.id), second.sim.position(node.id), node.id);
  }
  const sim = first.sim;
  // Members sit closer to their own project than to any other project.
  let closer = 0;
  let total = 0;
  for (const node of graph.nodes) {
    if (node.hub || !node.group) continue;
    const p = sim.position(node.id)!;
    const own = sim.position(node.group)!;
    const ownDistance = Math.hypot(p.x - own.x, p.y - own.y);
    let nearestOther = Infinity;
    for (const hub of graph.nodes) {
      if (!hub.hub || hub.id === node.group || hub.id === "org" || /^u\d+$/.test(hub.id)) continue;
      const q = sim.position(hub.id)!;
      nearestOther = Math.min(nearestOther, Math.hypot(p.x - q.x, p.y - q.y));
    }
    total += 1;
    if (ownDistance < nearestOther) closer += 1;
  }
  assert.ok(closer / total > 0.95, `${closer} of ${total} members are closest to their own project`);
  // Hardly any two nodes overlap.
  let overlaps = 0;
  const all = graph.nodes.map((node) => sim.position(node.id)!);
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i]!;
      const b = all[j]!;
      if (Math.hypot(a.x - b.x, a.y - b.y) < (a.r + b.r) * 0.7) overlaps += 1;
    }
  }
  assert.ok(overlaps <= all.length * 0.01, `${overlaps} overlaps among ${all.length} nodes`);
});

test("an organization-sized graph settles quickly", () => {
  const graph = orgGraph(10, 6, 40);
  assert.ok(graph.nodes.length > 2400);
  const started = performance.now();
  const sim = createSimulation(graph);
  sim.settle(240);
  const elapsed = performance.now() - started;
  // About 1.3 s alone on a laptop; the bound only catches a real slowdown, not a busy machine.
  assert.ok(elapsed < 30000, `took ${Math.round(elapsed)} ms`);
  for (const node of graph.nodes) {
    const p = sim.position(node.id)!;
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test("hidden nodes stop taking part, and pinned nodes stay where they were put", () => {
  const graph = orgGraph(2, 2, 6);
  const sim = createSimulation(graph);
  sim.settle(300);
  sim.pin("u0p0m0", 500, 500);
  sim.setActive(new Set(graph.nodes.filter((n) => !n.id.startsWith("u1")).map((n) => n.id)));
  sim.reheat(0.5);
  const hidden = sim.position("u1p0m0")!;
  sim.settle(200);
  assert.deepEqual(sim.position("u0p0m0"), { x: 500, y: 500, r: 5 });
  assert.deepEqual(sim.position("u1p0m0"), hidden, "inactive nodes do not move");
  sim.release("u0p0m0");
  sim.reheat(0.5);
  sim.settle(300);
  const free = sim.position("u0p0m0")!;
  assert.ok(Math.hypot(free.x - 500, free.y - 500) > 50, "a released node returns to its group");
});

/** The graph with one more project, full of new members, and new members on an existing project. */
function grownGraph() {
  const graph = orgGraph(2, 2, 6);
  const nodes = graph.nodes.slice();
  const links = graph.links.slice();
  nodes.push({ id: "u0p9", group: "u0", hub: true, r: 9 });
  links.push({ source: "u0p9", target: "u0" });
  for (let m = 0; m < 10; m += 1) {
    nodes.push({ id: `u0p9m${m}`, group: "u0p9", r: 5 });
    links.push({ source: `u0p9m${m}`, target: "u0p9", strength: 0.4 });
  }
  for (let m = 6; m < 12; m += 1) {
    nodes.push({ id: `u1p1m${m}`, group: "u1p1", r: 5 });
    links.push({ source: `u1p1m${m}`, target: "u1p1", strength: 0.4 });
  }
  return { before: graph, after: { nodes, links } };
}

test("growing keeps every placed node where it was and seeds new ones beside their hub", () => {
  const { before, after } = grownGraph();
  const sim = createSimulation(before);
  sim.settle(400);
  const previous = new Map(
    before.nodes.map((node) => [node.id, sim.position(node.id)!] as const),
  );
  const seeds = growPositions(after.nodes, previous);
  assert.equal(seeds.size, after.nodes.length);
  for (const node of before.nodes) {
    const p = previous.get(node.id)!;
    assert.deepEqual(seeds.get(node.id), { x: p.x, y: p.y }, node.id);
  }
  const hub = seeds.get("u0p9")!;
  const unit = seeds.get("u0")!;
  assert.ok(Math.hypot(hub.x - unit.x, hub.y - unit.y) < 160, "a new hub starts near its parent");
  for (const node of after.nodes) {
    if (previous.has(node.id) || node.hub) continue;
    const p = seeds.get(node.id)!;
    const own = seeds.get(node.group!)!;
    assert.ok(Math.hypot(p.x - own.x, p.y - own.y) < 80, `${node.id} starts near its hub`);
  }
  // New members of a hub that already had some start outside of the old ones' spiral.
  const fresh = seeds.get("u1p1m6")!;
  const center = seeds.get("u1p1")!;
  assert.ok(Math.hypot(fresh.x - center.x, fresh.y - center.y) > 18 + 14 * Math.sqrt(5));
  // With nothing to keep, it is the ordinary layout.
  assert.deepEqual(growPositions(before.nodes, new Map()), seedPositions(before.nodes));
});

test("a grown simulation starts gently from the old picture, keeps pins, and stays steady", () => {
  const { before, after } = grownGraph();
  const sim = createSimulation(before);
  sim.settle(400);
  const at = sim.position("u0p0m0")!;
  sim.pin("u0p0m0", at.x, at.y);
  const old = new Map(
    before.nodes.map((node) => [node.id, sim.position(node.id)!] as const),
  );
  const grown = growSimulation(sim, after);
  assert.equal(grown.count, after.nodes.length);
  assert.ok(grown.alpha <= 0.3 + 1e-9, "only gently reheated");
  for (const node of before.nodes) {
    assert.deepEqual(grown.position(node.id), old.get(node.id), node.id);
  }
  grown.settle(600);
  assert.ok(!grown.running());
  assert.deepEqual(grown.position("u0p0m0"), at, "pins carry over");
  let moved = 0;
  for (const node of before.nodes) {
    const a = old.get(node.id)!;
    const b = grown.position(node.id)!;
    moved += Math.hypot(a.x - b.x, a.y - b.y);
  }
  const average = moved / before.nodes.length;
  const fresh = createSimulation(after);
  fresh.settle(600);
  let relaid = 0;
  for (const node of before.nodes) {
    const a = old.get(node.id)!;
    const b = fresh.position(node.id)!;
    relaid += Math.hypot(a.x - b.x, a.y - b.y);
  }
  // Laying the grown graph out afresh moves them far more than growing it does.
  assert.ok(
    average < relaid / before.nodes.length / 3,
    `existing nodes moved ${average.toFixed(1)} on average`,
  );
  // Removing nodes keeps the rest in place too.
  const shrunk = growSimulation(grown, before);
  for (const node of before.nodes) {
    assert.deepEqual(shrunk.position(node.id), grown.position(node.id), node.id);
  }
});

test("fixed nodes hold their starting spot", () => {
  const nodes: EngineNode[] = [
    { id: "you", group: null, hub: true, r: 20, fixed: true },
    { id: "org", group: "you", hub: true, r: 14 },
    { id: "a", group: "org", r: 5 },
  ];
  const sim = createSimulation({
    nodes,
    links: [
      { source: "org", target: "you", distance: 400 },
      { source: "a", target: "org" },
    ],
  });
  sim.settle(400);
  assert.deepEqual(sim.position("you"), { x: 0, y: 0, r: 20 });
});

test("the view grows its data in place when asked to keep positions", () => {
  const frame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  try {
    const canvas = { getContext: () => ({}) };
    const view = createGraphView(canvas, { reduceMotion: false });
    const { before, after } = grownGraph();
    view.setData(before);
    const old = new Map(
      before.nodes.map((node) => [node.id, view.position(node.id)!] as const),
    );
    view.setData(after, { keepPositions: true });
    for (const node of before.nodes) {
      assert.deepEqual(view.position(node.id), old.get(node.id), node.id);
    }
    assert.ok(view.position("u0p9m3"), "new nodes are placed");
    assert.equal(view.settled, false, "and settle on the following frames");
    view.setData(before);
    assert.deepEqual(
      view.position("u0p0m0"),
      old.get("u0p0m0"),
      "without the option the data is laid out afresh, as the first time",
    );
  } finally {
    globalThis.requestAnimationFrame = frame;
  }
});

test("labels: the most important names win, none overlap, and off-screen ones are dropped", () => {
  const boxes = [
    { id: "low", x: 10, y: 10, w: 80, h: 20, priority: 1 },
    { id: "high", x: 20, y: 15, w: 80, h: 20, priority: 9 },
    { id: "apart", x: 200, y: 10, w: 80, h: 20, priority: 2 },
    { id: "away", x: 2000, y: 10, w: 80, h: 20, priority: 5 },
    { id: "forced", x: 30, y: 12, w: 40, h: 20, priority: 0, force: true },
  ];
  const picked = pickLabels(boxes, { width: 800, height: 600 }).map((box) => box.id);
  assert.deepEqual(picked, ["high", "apart", "forced"]);
  assert.equal(pickLabels(boxes, { width: 800, height: 600, limit: 1 }).length, 1);
});

test("small helpers", () => {
  assert.equal(clip("short"), "short");
  assert.equal(clip("a".repeat(40), 10), `${"a".repeat(9)}…`);
  assert.equal(withAlpha("#ff8000", 0.5), "rgb(255 128 0 / 0.5)");
});

test("the draw layer is flat Cobalt: no spheres, glow sprites, or light particles", () => {
  const source = readFileSync(new URL("../src/web/assets/graph-engine.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /drawImage\(glow\(/);
  assert.doesNotMatch(source, /drawImage\(sphere\(/);
  assert.doesNotMatch(source, /function sphere\(/);
  assert.doesNotMatch(source, /function glow\(/);
  assert.match(source, /assignTiers/);
  assert.match(source, /convexHull/);
});

test("diamond and square shapes point differently (source is a diamond, instruction a square)", () => {
  const source = readFileSync(new URL("../src/web/assets/graph-engine.js", import.meta.url), "utf8");
  assert.match(source, /diamond: -Math\.PI \/ 2/);
  assert.match(source, /square: Math\.PI \/ 4/);
});
