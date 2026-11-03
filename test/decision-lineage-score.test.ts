// Controlled scorer fixtures. These are not agent/model performance measurements.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreRecordedRuns, type RecordedRun, type RunPlan } from "../src/benchmark/score.ts";
import { ValidationError } from "../src/errors.ts";

const plan: RunPlan = { protocolSha256: "a".repeat(64), datasetSha256: "b".repeat(64), tasks: [{ id: "task1", familyId: "family1" }], methods: ["files", "candidate"], seeds: [11] };
function run(method: string, changes: Partial<RecordedRun> = {}): RecordedRun {
  return { taskId: "task1", method, seed: 11, protocolSha256: plan.protocolSha256, datasetSha256: plan.datasetSha256, artifactSha256: "c".repeat(64), status: "completed", oraclePassed: true, staleAuthorityUsed: false, unauthorizedAuthorityDelivered: false, latencyMs: 100, inputTokens: 20, outputTokens: 10, costUsd: null, ...changes };
}

test("empty or partial records do not fabricate results or paired comparisons", () => {
  const empty = scoreRecordedRuns(plan, []);
  assert.equal(empty.complete, false);
  assert.equal(empty.methods[0]?.successPerAttempt, null);
  assert.equal(empty.methods[0]?.costUsd.total, null);
  assert.equal(empty.comparisons[0]?.status, "incomplete");
  const partial = scoreRecordedRuns(plan, [run("files")]);
  assert.equal(partial.methods[1]?.missing, 1);
  assert.equal(partial.comparisons[0]?.difference, null);
});

test("attempted failures stay in denominator and cannot claim oracle success", () => {
  const result = scoreRecordedRuns(plan, [run("files"), run("candidate", { status: "timeout", oraclePassed: null, staleAuthorityUsed: null, unauthorizedAuthorityDelivered: null })]);
  assert.equal(result.complete, true);
  assert.equal(result.methods[1]?.attempted, 1);
  assert.equal(result.methods[1]?.successPerAttempt, 0);
  assert.equal(result.methods[1]?.unauthorizedAuthorityDelivered.unknown, 1);
  assert.equal(result.comparisons[0]?.difference, -1);
  assert.throws(() => scoreRecordedRuns(plan, [run("candidate", { status: "timeout", oraclePassed: true })]), ValidationError);
});

test("frozen hash mismatches, duplicate runs and out-of-plan observations are refused", () => {
  for (const records of [[run("files", { datasetSha256: "d".repeat(64) })], [run("files"), run("files")], [run("unknown")], [run("files", { seed: 47 })]]) {
    assert.throws(() => scoreRecordedRuns(plan, records), ValidationError);
  }
  assert.throws(() => scoreRecordedRuns({ ...plan, seeds: [11, 11] }, []), ValidationError);
  assert.throws(() => scoreRecordedRuns(plan, [{ ...run("files"), unexpected: true }]), ValidationError);
});

test("unknown cost/tokens/leakage remain unknown, invalid metrics are refused", () => {
  const result = scoreRecordedRuns(plan, [run("files", { inputTokens: null, unauthorizedAuthorityDelivered: null })]);
  assert.equal(result.methods[0]?.inputTokens.total, null);
  assert.deepEqual(result.methods[0]?.unauthorizedAuthorityDelivered, { positive: 0, observed: 0, unknown: 1 });
  for (const value of [-1, NaN, Infinity]) assert.throws(() => scoreRecordedRuns(plan, [run("files", { costUsd: value })]), ValidationError);
  assert.throws(() => scoreRecordedRuns(plan, [run("files", { inputTokens: 1.5 })]), ValidationError);
});

test("bootstrap preserves whole families and paired seeds and is repeatable", () => {
  const expanded = { ...plan, tasks: [{ id: "a", familyId: "one" }, { id: "b", familyId: "two" }], seeds: [11, 29] };
  const records = expanded.tasks.flatMap((task) => expanded.seeds.flatMap((seed) => [run("files", { taskId: task.id, seed, oraclePassed: task.id === "a" }), run("candidate", { taskId: task.id, seed })]));
  const first = scoreRecordedRuns(expanded, records);
  assert.deepEqual(first, scoreRecordedRuns(expanded, [...records].reverse()));
  assert.equal(first.comparisons[0]?.difference, 0.5);
  assert.deepEqual(first.comparisons[0]?.interval95, [0, 1]);
  assert.equal("descriptiveOnly" in first.comparisons[0]! && first.comparisons[0].descriptiveOnly, true);
});

test("aggregate cost overflow and unsafe token totals fail visibly", () => {
  const twoSeeds = { ...plan, seeds: [11, 29] };
  for (const metric of [{ costUsd: 1e308 }, { inputTokens: Number.MAX_SAFE_INTEGER }, { outputTokens: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => scoreRecordedRuns(twoSeeds, [run("files", metric), run("files", { ...metric, seed: 29 })]), /aggregate metric exceeds numeric precision/);
  }
});
