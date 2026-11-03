import assert from "node:assert/strict";
import { test } from "node:test";
import { getNetwork } from "../src/index.ts";
import {
  attentionItems,
  brainRegistry,
  decodeViewState,
  encodeViewState,
  eventsByDay,
  groupMeasures,
  groupPath,
  inDayRange,
  MAX_PINS,
  MAX_SAVED_VIEWS,
  nearestInDirection,
  nodeStates,
  parseSavedViews,
  provenancePaths,
  reach,
  searchItems,
  sectorPath,
  shadeLevels,
  timelineEvents,
  withSavedView,
  type EdgeLike,
  type GroupLike,
  type NodeLike,
} from "../src/web/assets/network-view.js";
import { networkPayload } from "../src/web/routes/network.ts";
import { useTestDatabase } from "./helpers.ts";
import { idOf, loadExample, openApp, personId } from "./web-helpers.ts";

const env = useTestDatabase();

const groups: GroupLike[] = [
  { id: "org", parentId: null },
  { id: "bu", parentId: "org" },
  { id: "p1", parentId: "bu", pendingNewDefinitions: 2 },
  { id: "p2", parentId: "bu" },
];
const parentOf = new Map(groups.map((group) => [group.id, group.parentId]));

test("impact follows reliance, not ownership, and survives cycles", () => {
  const edges: EdgeLike[] = [
    { id: "1", relation: "follows", from: "agent", to: "rule" },
    { id: "2", relation: "uses", from: "agent", to: "skill" },
    { id: "3", relation: "follows", from: "skill", to: "rule" },
    { id: "4", relation: "based_on", from: "rule", to: "memory" },
    { id: "5", relation: "cites", from: "memory", to: "source" },
    { id: "6", relation: "owns", from: "person", to: "rule" },
    { id: "7", relation: "hands_off_to", from: "rule", to: "agent" },
  ];
  const dependents = reach(edges, "memory", "in");
  assert.deepEqual(Object.fromEntries(dependents), {
    rule: 1,
    agent: 2,
    skill: 2,
  });
  assert.ok(
    !dependents.has("person"),
    "an owner does not rely on what they own",
  );
  assert.deepEqual([...reach(edges, "agent", "out", 1).keys()].sort(), [
    "rule",
    "skill",
  ]);
  assert.deepEqual(provenancePaths(edges, "rule"), [
    ["rule", "memory", "source"],
  ]);
  assert.deepEqual(provenancePaths(edges, "source"), []);
});

test("arrow keys move to the nearest thing in that direction", () => {
  const from = { x: 0, y: 0 };
  const candidates = [
    { id: "right-far", x: 100, y: 0 },
    { id: "right-near-off", x: 40, y: 35 },
    { id: "left", x: -50, y: 0 },
    { id: "down", x: 0, y: 60 },
  ];
  assert.equal(nearestInDirection(from, candidates, "right"), "right-far");
  assert.equal(nearestInDirection(from, candidates, "left"), "left");
  assert.equal(nearestInDirection(from, candidates, "down"), "down");
  assert.equal(nearestInDirection(from, candidates, "up"), null);
});

const nodes: NodeLike[] = [
  {
    id: "m1",
    kind: "memory",
    clusterId: "p1",
    status: "current",
    details: {
      type: "incident",
      approvedAt: "2026-09-20T10:00:00.000Z",
      revision: 1,
      approvedByName: "Rhea",
    },
  },
  {
    id: "d1",
    kind: "rule",
    clusterId: "p2",
    status: "retired",
    details: {
      approvedAt: "2026-08-01T10:00:00.000Z",
      revision: 2,
      warnings: ["Retired: kept"],
    },
  },
  {
    id: "d2",
    kind: "skill",
    clusterId: "bu",
    status: "current",
    details: {
      approvedAt: "2026-09-24T09:00:00.000Z",
      revision: 3,
      pendingChanges: 2,
      warnings: ["Follows a retired rule"],
    },
  },
  {
    id: "s1",
    kind: "source",
    clusterId: "p1",
    status: null,
    details: {
      capturedAt: "2026-09-19T08:00:00.000Z",
      captureMethod: "github_app",
      flags: ["personal_data"],
    },
  },
  { id: "person", kind: "person", clusterId: "org", status: null, details: {} },
];

test("states, attention, and group measures come only from the records given", () => {
  assert.deepEqual(
    nodeStates(nodes[1]!),
    ["retired"],
    "a retired rule is not also a warning",
  );
  assert.deepEqual(nodeStates(nodes[2]!), ["current", "pending", "warning"]);
  assert.deepEqual(
    nodeStates({ id: "x", kind: "rule", clusterId: "org", status: "active" }),
    ["current"],
    "an active definition is current",
  );
  assert.deepEqual(nodeStates(nodes[3]!), ["flagged"]);

  const attention = attentionItems(nodes, groups);
  assert.equal(
    attention.pending.count,
    4,
    "two changes plus two new definitions",
  );
  assert.deepEqual(attention.warnings.ids, ["d2"]);
  assert.deepEqual(attention.flagged.ids, ["s1"]);
  assert.deepEqual(attention.retired.ids, ["d1"]);

  const registry = brainRegistry(nodes, groups);
  assert.equal(registry.tiers.procedural.count, 2);
  assert.equal(registry.tiers.semantic.count, 1);
  assert.equal(registry.tiers.episodic.count, 1);
  assert.equal(registry.tiers.people.count, 1);
  assert.deepEqual(
    registry.ready.ids.sort(),
    ["d2", "m1"],
    "only current guidance and knowledge are ready for AI tools",
  );
  assert.equal(registry.pending.count, attention.pending.count);

  const measures = groupMeasures(groups, nodes, "2026-09-25T00:00:00.000Z");
  assert.equal(measures.get("org")?.items, 5);
  assert.equal(measures.get("bu")?.items, 4);
  assert.equal(measures.get("bu")?.pending, 4);
  assert.equal(measures.get("p1")?.incidents, 1);
  assert.equal(measures.get("org")?.recent, 3, "within 30 days: m1, d2, s1");
  const levels = shadeLevels(measures, "items");
  assert.equal(levels.get("org"), 1);
  assert.equal(levels.get("p2"), 0.2);
  assert.equal(shadeLevels(measures, "none").size, 0);
});

test("the timeline lists current versions newest first, by day", () => {
  const events = timelineEvents(nodes);
  assert.deepEqual(
    events.map((event) => `${event.id}:${event.what}`),
    ["d2:approved", "m1:approved", "s1:captured", "d1:retired"],
  );
  assert.equal(events[2]?.by, "the GitHub App");
  assert.deepEqual(
    eventsByDay(events).map((day) => day.day),
    ["2026-09-24", "2026-09-20", "2026-09-19", "2026-08-01"],
  );
  assert.deepEqual(
    events
      .filter((event) => inDayRange(event, "2026-09-19", "2026-09-20"))
      .map((event) => event.id),
    ["m1", "s1"],
  );
});

test("a view survives the address, and anything not visible is dropped from it", () => {
  const known = {
    nodes: new Set(["memory:1", "rule:2"]),
    clusters: new Set(["project:9"]),
    kinds: new Set(["memory", "person"]),
    relations: new Set(["owns", "cites"]),
  };
  const query = encodeViewState({
    mode: "table",
    node: "memory:1",
    isolate: true,
    depth: 2,
    impact: true,
    hideKinds: ["person"],
    hideRelations: ["owns"],
    retired: true,
    people: true,
    pins: ["rule:2", "memory:1"],
    camera: { x: 10.4, y: -3.6, k: 0.5 },
    from: "2026-09-01",
    to: "2026-09-30",
  });
  const state = decodeViewState(query, known);
  assert.equal(state.mode, "table");
  assert.equal(state.node, "memory:1");
  assert.equal(state.depth, 2);
  assert.ok(state.isolate && state.impact && state.retired && state.people);
  assert.deepEqual(state.hideKinds, ["person"]);
  assert.deepEqual(state.hideRelations, ["owns"]);
  assert.deepEqual(state.pins, ["rule:2", "memory:1"]);
  assert.deepEqual(state.camera, { x: 10, y: -4, k: 0.5 });
  assert.equal(state.from, "2026-09-01");

  const hostile = decodeViewState(
    "mode=admin&node=memory:hidden&focus=project:hidden&isolate=7&hide=secret,memory&rel=x&pins=a,b,c,d&cam=1,2,99&from=yesterday",
    known,
  );
  assert.equal(hostile.mode, "network");
  assert.equal(hostile.node, null);
  assert.equal(hostile.focus, null);
  assert.equal(hostile.isolate, false);
  assert.equal(hostile.people, false);
  assert.deepEqual(hostile.hideKinds, ["memory"]);
  assert.deepEqual(hostile.hideRelations, []);
  assert.deepEqual(hostile.pins, []);
  assert.equal(hostile.camera, null);
  assert.equal(hostile.from, null);
  assert.ok(MAX_PINS >= 2);
});

test("saved views ignore damaged storage and stay capped", () => {
  assert.deepEqual(parseSavedViews("not json"), []);
  assert.deepEqual(parseSavedViews('{"name":"x"}'), []);
  assert.deepEqual(
    parseSavedViews('[{"name":" Q3 ","query":"mode=table"},{"name":1},null]'),
    [{ name: "Q3", query: "mode=table", savedAt: null }],
  );
  let views = parseSavedViews(null);
  for (let i = 0; i < MAX_SAVED_VIEWS + 5; i += 1) {
    views = withSavedView(views, `View ${i}`, `node=${i}`, null);
  }
  assert.equal(views.length, MAX_SAVED_VIEWS);
  views = withSavedView(views, "View 24", "mode=timeline", "2026-09-25");
  assert.equal(views[0]?.query, "mode=timeline");
  assert.equal(views.filter((view) => view.name === "View 24").length, 1);
});

test("search ranks names that start with the words first", () => {
  const items = [
    { id: "1", label: "Payment calls are bounded" },
    { id: "2", label: "Retry payment calls until they succeed" },
    { id: "3", label: "Checkout review assistant", keywords: "agent" },
  ];
  assert.deepEqual(
    searchItems("payment", items).map((item) => item.id),
    ["1", "2"],
  );
  assert.deepEqual(
    searchItems("review agent", items).map((item) => item.id),
    ["3"],
  );
  assert.deepEqual(
    searchItems("checkout", [
      ...items,
      { id: "4", label: "Checkout", rank: 1 },
    ]).map((item) => item.id),
    ["4", "3"],
    "an exact name comes first",
  );
  assert.deepEqual(searchItems("   ", items), []);
});

test("derived views use only the viewer's own network", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const olivia = networkPayload(
    await getNetwork(env.ctx, await personId(env.db, "Olivia Owner"), acme),
    null,
    null,
  );
  const labelOf = new Map(olivia.nodes.map((node) => [node.id, node.label]));
  const bounded = olivia.nodes.find(
    (node) => node.label === "Payment calls are bounded",
  );
  assert.ok(bounded);
  const dependents = [...reach(olivia.edges, bounded.id, "in").keys()].map(
    (id) => labelOf.get(id),
  );
  assert.ok(dependents.includes("Checkout review assistant"));
  assert.ok(dependents.includes("Payments SDK guard"));
  const paths = provenancePaths(olivia.edges, bounded.id);
  assert.ok(paths.length > 0);
  for (const path of paths) {
    assert.equal(
      olivia.nodes.find((node) => node.id === path.at(-1))?.kind,
      "source",
    );
  }

  const rudy = networkPayload(
    await getNetwork(env.ctx, await personId(env.db, "Rudy Reader"), acme),
    null,
    null,
  );
  const rudyBounded = rudy.nodes.find(
    (node) => node.label === "Payment calls are bounded",
  );
  assert.ok(rudyBounded);
  const rudyLabels = new Map(rudy.nodes.map((node) => [node.id, node.label]));
  const seen = [...reach(rudy.edges, rudyBounded.id, "in").keys()].map((id) =>
    rudyLabels.get(id),
  );
  assert.ok(
    !seen.includes("Payments SDK guard"),
    "a hidden agent never shows up in impact",
  );
  const attention = attentionItems(rudy.nodes, rudy.clusters);
  assert.equal(attention.pending.count, 0, "readers see no review counts");
  const registry = brainRegistry(rudy.nodes, rudy.clusters);
  assert.equal(
    Object.values(registry.tiers).reduce((sum, tier) => sum + tier.count, 0),
    rudy.nodes.length,
    "the registry counts only what the viewer can see",
  );
  assert.ok(
    registry.tiers.procedural.count <
      brainRegistry(olivia.nodes, olivia.clusters).tiers.procedural.count,
  );
});

test("a group icon's slice is a closed path, and a full ring has a hole", () => {
  const slice = sectorPath(0, 0, 5, 10, 0, 1);
  assert.match(slice, /^M5,0L10,0A10,10 0 0 1 /);
  assert.ok(slice.endsWith("Z"));
  const ring = sectorPath(0, 0, 5, 10, 0, Math.PI * 2);
  assert.equal((ring.match(/Z/g) ?? []).length, 2, "outer edge and inner hole");
  assert.equal((sectorPath(0, 0, 0, 10, 0, 1).match(/^M0,0L/) ?? []).length, 1);
});
