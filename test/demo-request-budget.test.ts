import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBudgetedDemoFetcher, estimateDemoRequest } from "../src/evaluation/request-budget.ts";
import { GuardProviderError } from "../src/decision-guard/errors.ts";

const requestBody = (cap = 4096, text = "Public engineering evidence") => JSON.stringify({
  model: "muse-spark-1.3", messages: [{ role: "user", content: text }], max_completion_tokens: cap,
});
const budgetFailure = (error: unknown) => error instanceof GuardProviderError && error.reason === "budget";

test("demo budget records actual JSON bytes and selected output cap without claiming actual billing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "memorynet-demo-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = join(directory, "dispatch.json");
  let calls = 0;
  const guarded = createBudgetedDemoFetcher(ledger, async () => { calls++; return new Response("{}"); });
  const body = requestBody(2048, "Public evidence: café ✓");
  await guarded("https://example.invalid/no-network", { method: "POST", body });
  const recorded = JSON.parse(await readFile(ledger, "utf8"));
  assert.equal(calls, 1);
  assert.equal(recorded.maxOutputTokens, 2048);
  assert.equal(recorded.outgoingJsonBytes, Buffer.byteLength(body));
  assert.equal(recorded.inputTokenUpperBound, Buffer.byteLength(body));
  assert.equal(recorded.requestCostCeilingUsd, 0.10);
  assert(recorded.conservativeEstimatedMaxCostUsd < 0.10);
  assert.match(recorded.costClassification, /not actual usage or billing/);
  if (process.platform !== "win32") assert.equal((await stat(ledger)).mode & 0o077, 0);
});

test("demo budget admits the exact conservative ceiling boundary and rejects the next byte", () => {
  const maximumBytes = 66073; // 4,096 capped output tokens plus this input bound stays under $0.10.
  const empty = requestBody(4096, "");
  const exact = requestBody(4096, "x".repeat(maximumBytes - Buffer.byteLength(empty)));
  assert.equal(Buffer.byteLength(exact), maximumBytes);
  assert(estimateDemoRequest(exact).conservativeEstimatedMaxCostUsd <= 0.10);
  assert.throws(() => estimateDemoRequest(exact.replace('"content":"', '"content":"x')), budgetFailure);
});

test("rejected demo requests create neither a ledger nor a network dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "memorynet-demo-budget-deny-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = join(directory, "dispatch.json");
  let calls = 0;
  const guarded = createBudgetedDemoFetcher(ledger, async () => { calls++; return new Response("{}"); });
  for (const body of [undefined, "not JSON", "[]", requestBody(4097), requestBody(4096, "x".repeat(70_000))]) {
    await assert.rejects(guarded("https://example.invalid/no-network", { body }), budgetFailure);
  }
  assert.equal(calls, 0);
  await assert.rejects(stat(ledger), { code: "ENOENT" });
});

test("a failed demo dispatch remains consumed in a fresh wrapper", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "memorynet-demo-budget-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = join(directory, "dispatch.json");
  let calls = 0;
  const failed = createBudgetedDemoFetcher(ledger, async () => { calls++; throw new Error("Simulated network failure"); });
  await assert.rejects(failed("https://example.invalid/no-network", { body: requestBody() }), /Simulated network failure/);
  const restarted = createBudgetedDemoFetcher(ledger, async () => { calls++; return new Response("{}"); });
  await assert.rejects(restarted("https://example.invalid/no-network", { body: requestBody() }), budgetFailure);
  assert.equal(calls, 1);
});

test("concurrent demo wrappers cannot dispatch twice against the same ledger", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "memorynet-demo-budget-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = join(directory, "dispatch.json");
  let calls = 0;
  const fake: typeof fetch = async () => { calls++; return new Response("{}"); };
  const results = await Promise.allSettled([createBudgetedDemoFetcher(ledger, fake), createBudgetedDemoFetcher(ledger, fake)]
    .map((guarded) => guarded("https://example.invalid/no-network", { body: requestBody() })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && budgetFailure(result.reason)).length, 1);
  assert.equal(calls, 1);
});

test("aggregate demo budget refuses an otherwise valid next attempt without a ledger or dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "memorynet-demo-aggregate-deny-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const priorPath = join(directory, "dispatch-1.json");
  const nextPath = join(directory, "dispatch-2.json");
  const first = createBudgetedDemoFetcher(priorPath, async () => { throw new Error("Simulated charged failed attempt"); });
  await assert.rejects(first("https://example.invalid/no-network", { body: requestBody(4096, "x".repeat(55_000)) }), /Simulated charged failed attempt/);
  const retained = await readFile(priorPath, "utf8");
  let calls = 0;
  const next = createBudgetedDemoFetcher(nextPath, async () => { calls++; return new Response("{}"); }, [priorPath]);
  const body = requestBody();
  assert(estimateDemoRequest(body).conservativeEstimatedMaxCostUsd < 0.10);
  await assert.rejects(next("https://example.invalid/no-network", { body }), budgetFailure);
  assert.equal(calls, 0);
  await assert.rejects(stat(nextPath), { code: "ENOENT" });
  assert.equal(await readFile(priorPath, "utf8"), retained, "A failed prior attempt remains recorded unchanged");
});

test("aggregate demo budget records the sum of retained slots and the actual admitted attempt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "memorynet-demo-aggregate-pass-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = [1, 2, 3].map((slot) => join(directory, `dispatch-${slot}.json`));
  let calls = 0;
  const fake: typeof fetch = async () => { calls++; return new Response("{}"); };
  await createBudgetedDemoFetcher(paths[0]!, fake, paths.slice(1))("https://example.invalid/no-network", { body: requestBody(2048) });
  await createBudgetedDemoFetcher(paths[1]!, fake, [paths[0]!, paths[2]!])("https://example.invalid/no-network", { body: requestBody(2048) });
  // Duplicate path arguments are not charged twice; the current path is handled by exclusive creation.
  await createBudgetedDemoFetcher(paths[2]!, fake, [...paths, paths[0]!])("https://example.invalid/no-network", { body: requestBody(4096) });
  const records = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const sumNanoUsd = records.reduce((sum, record) => sum + Math.round(record.conservativeEstimatedMaxCostUsd * 1_000_000_000), 0);
  assert.equal(calls, 3);
  assert.equal(records[2].priorDispatchAttempts, 2);
  assert.equal(records[2].aggregateConservativeEstimatedMaxCostUsd, sumNanoUsd / 1_000_000_000);
  assert(records[2].aggregateConservativeEstimatedMaxCostUsd <= 0.10);
  assert.equal(records[2].aggregateCostCeilingUsd, 0.10);
  assert.equal(records[2].maxOutputTokens, 4096);
});

test("malformed or inconsistent retained demo ledgers fail closed before recording or dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "memorynet-demo-aggregate-malformed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const priorPath = join(directory, "dispatch-1.json");
  const nextPath = join(directory, "dispatch-2.json");
  await createBudgetedDemoFetcher(priorPath, async () => new Response("{}"))("https://example.invalid/no-network", { body: requestBody() });
  const valid = JSON.parse(await readFile(priorPath, "utf8"));
  const corruptions = ["not JSON", "[]", "{}", JSON.stringify({ ...valid, maxOutputTokens: 4097 }),
    JSON.stringify({ ...valid, conservativeEstimatedMaxCostUsd: 0 }),
    JSON.stringify({ ...valid, ratesUsdPerMillionTokens: { input: 0, output: 0 } }), "x".repeat(16_385)];
  let calls = 0;
  const guarded = createBudgetedDemoFetcher(nextPath, async () => { calls++; return new Response("{}"); }, [priorPath]);
  for (const contents of corruptions) {
    await writeFile(priorPath, contents);
    await assert.rejects(guarded("https://example.invalid/no-network", { body: requestBody() }), budgetFailure);
    await assert.rejects(stat(nextPath), { code: "ENOENT" });
  }
  assert.equal(calls, 0);
});
