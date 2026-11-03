import assert from "node:assert/strict";
import { test } from "node:test";
import { runScopedContextSmoke } from "../src/evaluation/scoped-smoke.ts";

test("fresh official SDK stdio clients traverse authenticated app, scoped approval/replacement/revocation and receipts", { timeout: 30_000 }, async () => {
  const result = await runScopedContextSmoke();
  assert.equal(result.metaCalls, 0);
  assert.equal(result.freshProtocolClients, 2);
  assert.deepEqual(result.events.map((event) => event.response.outcome), ["no_results", "results", "results", "results", "no_results"]);
  assert.equal(result.invariantChecksPassed, true);
});
