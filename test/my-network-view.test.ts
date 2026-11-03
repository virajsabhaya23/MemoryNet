import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCENT,
  buildGraph,
  chainOf,
  closeForRoom,
  colorOf,
  firstPositions,
  focusOf,
  mixHex,
  PALETTE,
  projectsOf,
  YOU,
  type PlaceContents,
  type PlaceInfo,
} from "../src/web/assets/my-network-view.js";
import { createSimulation } from "../src/web/assets/graph-engine.js";

// The canvas map ---------------------------------------------------------------------------------

function place(
  level: PlaceInfo["level"],
  title: string,
  access: PlaceInfo["access"],
  total = 4,
): PlaceInfo {
  return { level, title, name: title, suffix: "", access, total };
}

/** An organization with two units, three projects, and you holding roles on the unit and one project. */
function world(opened = new Map<string, PlaceContents>()) {
  const places = new Map<string, PlaceInfo>([
    ["org", place("organization", "Acme", "inside", 2)],
    ["u1", place("business_unit", "Platform", "direct", 6)],
    ["u2", place("business_unit", "Support", "inside", 3)],
    ["p1", place("project", "Checkout", "covered")],
    ["p2", place("project", "Payments", "covered")],
    ["p3", place("project", "Helpdesk", "direct")],
    ["p4", place("project", "Folded", "inside")],
  ]);
  return buildGraph({
    org: "org",
    tops: ["u1", "u2", "more:units"],
    kids: { u1: ["p1", "p2"], u2: ["p3"] },
    places,
    opened,
    listedCount: 7,
    theme: "dark",
  });
}

const CHECKOUT: PlaceContents = {
  items: [
    { id: "definition:r", kind: "rule", family: "work", label: "Review rule", owned: true },
    { id: "memory:m", kind: "memory", family: "know", label: "A decision", owned: false },
    { id: "source:s", kind: "source", family: "evidence", label: "repo #1", owned: false },
  ],
  links: [
    { from: "memory:m", to: "source:s", relation: "cites" },
    { from: "definition:r", to: "memory:gone", relation: "based_on" },
  ],
  more: 5,
};

test("the graph puts you in the middle with the places as hubs and bright lines to your own roles", () => {
  const graph = world();
  const you = graph.nodes.find((node) => node.id === YOU);
  assert.ok(you?.hub && you.fixed, "you are a fixed hub");
  assert.equal(you?.label, "You");
  assert.equal(you?.color, ACCENT.dark);
  const groups = Object.fromEntries(graph.nodes.map((node) => [node.id, node.group]));
  assert.deepEqual(groups, {
    you: null,
    org: YOU,
    u1: "org",
    p1: "u1",
    p2: "u1",
    u2: "org",
    p3: "u2",
    "more:units": "org",
  });
  assert.equal(
    graph.nodes.find((node) => node.id === "more:units")?.label,
    "7 more business units",
  );
  const access = graph.links.filter((link) => link.access);
  assert.deepEqual(
    access.map((link) => [link.source, link.target, link.color]),
    [
      [YOU, "u1", ACCENT.dark],
      [YOU, "p3", ACCENT.dark],
    ],
    "a bright line to every place where your role starts",
  );
  assert.ok(
    graph.links.some((link) => link.id === "hub:p1" && link.target === "u1" && link.structure),
  );
  assert.ok(graph.links.some((link) => link.source === "org" && link.target === YOU && link.hidden));
  // Places with no role of yours are dimmer than those you reach through a role.
  const color = (id: string) => graph.nodes.find((node) => node.id === id)?.color;
  assert.equal(color("u1"), PALETTE.dark.business_unit);
  assert.notEqual(color("u2"), PALETTE.dark.business_unit);
  assert.equal(color("p1"), PALETTE.dark.project);
  assert.match(color("u2") ?? "", /^#[0-9a-f]{6}$/);
});

test("opening a place adds what it holds around it, its links, and a node for the rest", () => {
  const graph = world(new Map([["p1", CHECKOUT]]));
  const inside = graph.nodes.filter((node) => node.group === "p1");
  assert.deepEqual(
    inside.map((node) => [node.id, node.hub]),
    [
      ["definition:r", false],
      ["memory:m", false],
      ["source:s", false],
      ["more:p1", false],
    ],
  );
  assert.equal(inside[0]?.badge, ACCENT.dark, "what you own is marked");
  assert.equal(inside[1]?.badge, null);
  assert.equal(inside[3]?.label, "5 more");
  const ids = new Set(graph.links.map((link) => link.id));
  assert.ok(ids.has("in:memory:m"));
  assert.ok(ids.has("rel:memory:m>source:s"));
  assert.ok(![...ids].some((id) => id.includes("memory:gone")), "links to what is not drawn are left out");
  assert.equal(new Set(graph.nodes.map((node) => node.id)).size, graph.nodes.length);
});

test("an opened business unit brings its other projects", () => {
  const unit: PlaceContents = { items: [], children: [{ id: "p4" }, { id: "p1" }], more: 0 };
  const opened = new Map([["u1", unit]]);
  assert.deepEqual(projectsOf("u1", { u1: ["p1", "p2"] }, opened), ["p1", "p2", "p4"]);
  const graph = world(opened);
  assert.equal(graph.nodes.find((node) => node.id === "p4")?.group, "u1");
});

test("focus lights the way from you and what a node touches; your own focus lights your roles", () => {
  const graph = world(new Map([["p1", CHECKOUT]]));
  assert.deepEqual(chainOf(graph.parentOf, "memory:m"), ["memory:m", "p1", "u1", "org", YOU]);
  const memory = focusOf(graph, "memory:m");
  for (const id of ["memory:m", "p1", "u1", "org", YOU, "source:s"]) {
    assert.ok(memory.near.has(id), `${id} is lit`);
  }
  assert.ok(!memory.near.has("p3"));
  for (const id of ["in:memory:m", "hub:p1", "hub:u1", "access:u1", "rel:memory:m>source:s"]) {
    assert.ok(memory.edges.has(id), `${id} is lit`);
  }
  assert.ok(!memory.edges.has("access:p3"));
  assert.ok(![...memory.edges].some((id) => id.startsWith("you:")), "unseen lines stay unseen");
  const you = focusOf(graph, YOU);
  assert.deepEqual([...you.edges].sort(), ["access:p3", "access:u1"]);
  assert.ok(you.near.has("u1") && you.near.has("p3"));
});

test("the first picture puts you at the middle with the organization beside you", () => {
  const graph = world();
  const seeds = firstPositions(graph.nodes, "org");
  assert.deepEqual(seeds.get(YOU), { x: 0, y: 0 });
  const org = seeds.get("org");
  assert.ok(org);
  const fromYou = Math.hypot(org.x, org.y);
  assert.ok(fromYou > 30 && fromYou < 120, `the organization is ${fromYou.toFixed(0)} away`);
  for (const id of ["u1", "u2"]) {
    const unit = seeds.get(id);
    assert.ok(unit && Math.hypot(unit.x - org.x, unit.y - org.y) > 30, `${id} keeps clear of it`);
  }
  // The engine keeps you there while the rest settles.
  const sim = createSimulation({ nodes: graph.nodes, links: graph.links, positions: seeds });
  sim.settle(400);
  assert.deepEqual(sim.position(YOU), { x: 0, y: 0, r: graph.nodes[0]?.r });
});

test("opening one place too many closes the oldest that is not on its way", () => {
  assert.deepEqual(closeForRoom(["a", "b", "c"], new Set(["a"]), 3), ["b"]);
  assert.deepEqual(closeForRoom(["a", "b"], new Set(), 3), []);
  assert.deepEqual(closeForRoom(["a", "b", "c"], new Set(["a", "b", "c"]), 3), []);
});

test("colours follow the theme and dim toward the background", () => {
  assert.equal(mixHex("#ff0000", "#000000", 0.5), "#800000");
  assert.equal(mixHex("#123456", "#ffffff", 0), "#123456");
  const graph = world();
  const unit = graph.nodes.find((node) => node.id === "u1");
  assert.ok(unit);
  assert.equal(colorOf(unit, "light"), PALETTE.light.business_unit);
  assert.equal(colorOf(graph.nodes[0]!, "light"), ACCENT.light);
});
