import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  BRAIN_BENCHMARK_STATEMENT,
  renderBrainBenchmarkMarkdown,
  runBrainBenchmark,
  type BrainBenchmarkArm,
  type BrainBenchmarkReport,
} from "../src/evaluation/brain-benchmark.ts";

let report: BrainBenchmarkReport;
before(async () => {
  report = await runBrainBenchmark();
});

const result = (taskId: string, arm: BrainBenchmarkArm) => {
  const found = report.results.find((item) => item.taskId === taskId && item.arm === arm);
  assert.ok(found, `${arm} ran ${taskId}`);
  return found;
};

test("task context delivers only current guidance the agent may read, receipted, with the reviewed conflict", () => {
  const totals = report.totals["memorynet-task-context"];
  assert.equal(totals.currentDelivered, 8);
  assert.equal(totals.currentExpected, 8);
  assert.equal(totals.staleDelivered, 0);
  assert.equal(totals.unapprovedDelivered, 0);
  assert.equal(totals.unauthorizedDelivered, 0);
  for (const run of report.results.filter((item) => item.arm === "memorynet-task-context")) {
    assert.ok(run.delivered.every((item) => item.authority === "current" && item.agentMayRead), run.taskId);
    assert.equal(run.delivered.some((item) => item.record.startsWith("memory:jwt-login")), false, "the superseded decision is never served");
    assert.equal(run.receipted, true);
  }
  assert.deepEqual(result("remember-me", "memorynet-task-context").conflicts,
    [{ memory: "memory:mobile-remember-me", conflictsWith: "memory:session-idle-timeout", bothDelivered: true }]);
});

test("definitions in task context are scored when served, and the skill based on the old decision is flagged", () => {
  const totals = report.totals["memorynet-task-context"];
  if (!report.definitionsServed) {
    assert.equal(totals.outdatedSkillsFlagged, null);
    return;
  }
  assert.ok(totals.outdatedSkillsDelivered > 0);
  assert.equal(totals.outdatedSkillsFlagged, totals.outdatedSkillsDelivered, "every outdated skill delivered is marked for review");
  const delivered = result("mobile-login", "memorynet-task-context").delivered;
  assert.equal(delivered.find((item) => item.record === "definition:mobile-login-token-skill@1")?.reviewNeeded, true);
  assert.equal(delivered.find((item) => item.record === "definition:auth-security-instruction@1")?.reviewNeeded, false);
});

test("permission-aware RAG delivers superseded text and raw evidence, never what the agent may not read", () => {
  assert.deepEqual(report.totals["permission-aware-rag"], {
    currentDelivered: 7, currentExpected: 8, staleDelivered: 6, unapprovedDelivered: 11, unapprovedProposals: 0,
    unapprovedRawEvidence: 11, conflictsSurfaced: 0, unauthorizedDelivered: 0, outdatedSkillsDelivered: 4, outdatedSkillsFlagged: 0,
    estimatedTokens: 2618, deliveredRecords: 34,
  });
  const mobile = result("mobile-login", "permission-aware-rag").delivered;
  assert.equal(mobile.find((item) => item.record === "memory:jwt-login@1")?.authority, "stale");
  assert.equal(mobile.find((item) => item.record === "source:identity-service#356")?.authority, "unapproved");
  assert.equal(mobile.find((item) => item.record === "definition:mobile-login-token-skill@1")?.outdated, true);
  assert.deepEqual(result("remember-me", "permission-aware-rag").missing, ["memory:session-idle-timeout@1"]);
  assert.ok(result("token-storage", "permission-aware-rag").delivered.some((item) => item.record === "memory:server-sessions@1"),
    "an older version of the current decision");
});

test("the unfiltered ablation exposes the restricted forensic memory and proposals, and is labeled as no fair competitor", () => {
  assert.deepEqual(report.totals["ablation-unfiltered-rag"], {
    currentDelivered: 7, currentExpected: 8, staleDelivered: 5, unapprovedDelivered: 13, unapprovedProposals: 3,
    unapprovedRawEvidence: 10, conflictsSurfaced: 0, unauthorizedDelivered: 5, outdatedSkillsDelivered: 4, outdatedSkillsFlagged: 0,
    estimatedTokens: 2694, deliveredRecords: 34,
  });
  const exposed = result("revoke-session", "ablation-unfiltered-rag").delivered.filter((item) => !item.agentMayRead).map((item) => item.record);
  assert.deepEqual(exposed, ["memory:token-theft-forensics@1", "source:incident-response#9"]);
  assert.deepEqual(result("mobile-login", "ablation-unfiltered-rag").delivered.filter((item) => !item.agentMayRead).map((item) => item.record),
    ["proposal:agent-jwt-attempt-1"]);
  assert.equal(report.arms.find((arm) => arm.id === "ablation-unfiltered-rag")?.fairComparison, false);
});

test("the run is synthetic, model-free and repeatable, and its summary says so first", async () => {
  assert.equal(report.modelCalls, 0);
  assert.equal(report.agentEffectivenessMeasured, false);
  assert.doesNotMatch(JSON.stringify(report), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, "stable labels, not database IDs");
  assert.deepEqual(await runBrainBenchmark(), report);
  const summary = renderBrainBenchmarkMarkdown(report);
  assert.deepEqual(summary.split("\n").slice(0, 2), [...BRAIN_BENCHMARK_STATEMENT]);
  assert.match(summary, /Ablation: RAG without permission filtering \(not a fair competitor\)/);
  assert.match(summary, /## Limits/);
});
