import assert from "node:assert/strict";
import { test } from "node:test";
import { assignTiers, MAX_CARDS, wrapTitle } from "../src/web/assets/graph-tiers.js";

/** 1,200 items shaped like an organization map: hubs with members around them. */
function fixture(count = 1200) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      id: `n${i}`,
      hub: i % 100 === 0,
      inViewport: i % 10 !== 0, // a tenth sit outside the viewport
      priority: (i * 7919) % 5000,
      selected: i === 555,
    });
  }
  return items;
}

test("at far zoom a 1200-node map is dots, with only the selection promoted to a chip", () => {
  const tiers = assignTiers(fixture(), 0.2);
  assert.equal([...tiers.values()].filter((tier) => tier === "near").length, 0);
  assert.equal(tiers.get("n555"), "mid");
  assert.equal([...tiers.values()].filter((tier) => tier === "far").length, 1199);
});

test("at mid zoom only the selection is promoted to a card", () => {
  const tiers = assignTiers(fixture(), 0.8);
  assert.equal([...tiers.values()].filter((tier) => tier === "near").length, 1);
  assert.equal(tiers.get("n555"), "near");
});

test("at near zoom cards stay within budget and the selection keeps its card", () => {
  const tiers = assignTiers(fixture(), 1.5);
  const near = [...tiers.values()].filter((tier) => tier === "near").length;
  assert.ok(near <= MAX_CARDS, `${near} cards exceeds the budget`);
  assert.equal(near, MAX_CARDS);
  assert.equal(tiers.get("n555"), "near");
  // n0 is out of the viewport (0 % 10 === 0): never promoted.
  assert.equal(tiers.get("n0"), "far");
});

test("long unicode titles wrap inside the card budget", () => {
  const lines = wrapTitle(`Ünïcödé — ${"lång ".repeat(80)}slut`);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => [...line].length <= 26));
});
