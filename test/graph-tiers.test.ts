import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignTiers,
  cardMeta,
  convexHull,
  kindShape,
  MAX_CARDS,
  tierForZoom,
  wrapTitle,
} from "../src/web/assets/graph-tiers.js";

test("tierForZoom splits at the Cobalt thresholds", () => {
  assert.equal(tierForZoom(0.2), "far");
  assert.equal(tierForZoom(0.44), "far");
  assert.equal(tierForZoom(0.45), "mid");
  assert.equal(tierForZoom(1.09), "mid");
  assert.equal(tierForZoom(1.1), "near");
  assert.equal(tierForZoom(4), "near");
});

test("kindShape maps every node kind to its far-tier shape", () => {
  assert.equal(kindShape("memory"), "circle");
  assert.equal(kindShape("source"), "diamond");
  assert.equal(kindShape("rule"), "triangle");
  assert.equal(kindShape("instruction"), "square");
  assert.equal(kindShape("skill"), "hexagon");
  assert.equal(kindShape("agent"), "pentagon");
  assert.equal(kindShape("person"), "ring");
  assert.equal(kindShape("agent_account"), "double-ring");
  assert.equal(kindShape("project"), "circle");
  assert.equal(kindShape("something-else"), "circle");
});

test("assignTiers caps cards at MAX_CARDS and keeps the selection near", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    id: `n${i}`,
    inViewport: true,
    priority: i,
    selected: i === 3,
  }));
  const tiers = assignTiers(items, 1.5);
  assert.equal([...tiers.values()].filter((tier) => tier === "near").length, MAX_CARDS);
  assert.equal(tiers.get("n3"), "near");
  assert.equal(tiers.get("n0"), "mid");
});

test("assignTiers never promotes out-of-viewport nodes and promotes selection at mid zoom", () => {
  const tiers = assignTiers([
    { id: "a", inViewport: false, selected: true, priority: 99 },
    { id: "b", inViewport: true, selected: true, priority: 1 },
    { id: "c", inViewport: true, priority: 1 },
  ], 0.8);
  assert.equal(tiers.get("a"), "far");
  assert.equal(tiers.get("b"), "near");
  assert.equal(tiers.get("c"), "mid");
  const far = assignTiers([{ id: "x", inViewport: true }], 0.2);
  assert.equal(far.get("x"), "far");
});

test("wrapTitle wraps to two lines with an ellipsis when truncated", () => {
  const lines = wrapTitle("API retries use exponential backoff with jitter");
  assert.equal(lines.length, 2);
  assert.ok(lines[1]?.endsWith("…"));
  assert.deepEqual(wrapTitle("Short"), ["Short"]);
  const unicode = wrapTitle("Ünïcödé " + "x".repeat(300));
  assert.equal(unicode.length, 2);
});

test("cardMeta summarizes each kind and tolerates sparse details", () => {
  const now = "2026-11-03T12:00:00.000Z";
  assert.match(
    cardMeta({ kind: "memory", details: { ownerName: "Ada Lovelace", approvedAt: "2026-11-01T12:00:00.000Z", evidenceCount: 3 } }, 0, now),
    /Ada Lovelace · 3 sources · 2d ago/,
  );
  assert.match(
    cardMeta({ kind: "definition", details: { ownerName: "Ada", scopeName: "Payments", approvedAt: "2026-11-03T11:00:00.000Z" } }, 0, now),
    /Ada · Payments · 1h ago/,
  );
  assert.match(
    cardMeta({ kind: "source", details: { repository: "acme/payments", capturedAt: "2026-11-03T12:00:00.000Z" } }, 0, now),
    /acme\/payments · just now/,
  );
  assert.equal(cardMeta({ kind: "person", details: { displayName: "Ada Lovelace" } }, 5, now), "Ada Lovelace");
  assert.equal(cardMeta({ kind: "memory", details: {} }, 0, now), "");
  assert.doesNotMatch(cardMeta({ kind: "memory", details: undefined }, 0, now), /undefined/);
});

test("convexHull returns the outer points only", () => {
  const hull = convexHull([
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 },
  ]);
  assert.equal(hull.length, 4);
  assert.deepEqual(convexHull([{ x: 1, y: 1 }]), [{ x: 1, y: 1 }]);
});
