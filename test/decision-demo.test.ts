import assert from "node:assert/strict";
import { test } from "node:test";
import { runDecisionDemo } from "../src/evaluation/decision-demo.ts";
import { renderDecisionDemo } from "../src/evaluation/decision-demo-page.ts";

test("the repeatable demo proves stale-work blocking through real MCP and renders an honest escaped replay", async () => {
  const report = await runDecisionDemo(); // Asserts real transitions and refuses a stale export before returning.
  assert.equal(report.metaCalls, 0);
  assert.equal(report.codeBehaviorVerified, false);
  assert.equal(report.benchmark, false);
  assert.notEqual(report.before.current[0]!.memoryId, report.after.current[0]!.memoryId);
  assert.equal(report.whilePending.current[0]!.memoryId, report.before.current[0]!.memoryId);
  assert.ok(report.receipts.some(receipt => receipt.id === report.after.retrievalId));
  const page = renderDecisionDemo(report);
  assert.match(page, /read-only replay/);
  assert.match(page, /scripted response/);
  assert.match(page, /stale context export blocked/);
  assert.doesNotMatch(page, /<form|action=|accessToken|bindingFile/);
  report.work.title = '<script>alert("fixture")</script>';
  assert.doesNotMatch(renderDecisionDemo(report), /<script>/);
  assert.match(renderDecisionDemo(report), /&lt;script&gt;/);
});
