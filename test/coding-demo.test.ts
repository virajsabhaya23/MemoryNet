import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectCodingContext, startCodingDemo, verifyCodingArtifact } from "../src/evaluation/coding-demo.ts";

test("coding collector preserves source parity, actual MCP receipts, oracle failures and frozen inputs", { timeout: 60_000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "memorynet-coding-test-"));
  const folder = join(parent, "run");
  const demo = await startCodingDemo(folder);
  try {
    const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
    assert.equal(manifest.evidenceKind, "synthetic_coding_agent_engineering_demo");
    assert.equal(manifest.metaCalls, 0);
    assert.notEqual(manifest.before.current[0].memoryId, manifest.after.current[0].memoryId);
    assert.equal(await readFile(join(folder, "baseline/decisions.json"), "utf8"), await readFile(join(folder, "memorynet/decisions.json"), "utf8"));
    const response = await collectCodingContext(demo.connectionFile, join(folder, "memorynet/context.json"));
    assert.equal(response.current[0]?.memoryId, manifest.after.current[0].memoryId);
    await demo.saveReceipts();
    const receipts = JSON.parse(await readFile(join(folder, "retrievals.json"), "utf8"));
    assert.ok(receipts.some((receipt: { id: string }) => receipt.id === response.retrievalId));
    await assert.rejects(() => collectCodingContext(demo.connectionFile, join(folder, "memorynet/context.json")), /EEXIST/);
    // Independent candidate artifacts validate the oracle's decision boundary; these are test doubles, not LLM outputs.
    const valid = "Number.isInteger(status) && status >= 100 && status <= 599 && Number.isInteger(retriesSoFar) && retriesSoFar >= 0";
    await writeFile(join(folder, "baseline/retry-policy.mjs"), `export function shouldRetry(status, retriesSoFar) { return ${valid} && (status === 429 || status === 503) && retriesSoFar < 3; }`);
    const failed = await verifyCodingArtifact(folder, "baseline");
    assert.equal(failed.passed, false);
    assert.notEqual(failed.exitCode, 0);
    assert.match(failed.stderr, /AssertionError/);
    await writeFile(join(folder, "memorynet/retry-policy.mjs"), `export function shouldRetry(status, retriesSoFar) { return ${valid} && status === 503 && retriesSoFar < 2; }`);
    const taskPath = join(folder, "memorynet/TASK.md");
    const task = await readFile(taskPath, "utf8");
    await writeFile(taskPath, `${task}\nchanged`);
    await assert.rejects(() => verifyCodingArtifact(folder, "memorynet"), /Task changed/);
    await writeFile(taskPath, task);
    const passed = await verifyCodingArtifact(folder, "memorynet");
    assert.equal(passed.passed, true);
    assert.equal(JSON.parse(passed.stdout).cases, 3020);
    assert.equal(passed.costUsd, null);
    await assert.rejects(() => verifyCodingArtifact(folder, "memorynet"), /EEXIST/);
    await assert.rejects(() => verifyCodingArtifact(folder, "other"), /Choose one of/);

    // Stale-instructions scenario: identical ordinary guidance; only the dated-sources arm gets dated records.
    const contributing = await readFile(join(folder, "repo-instructions/CONTRIBUTING.md"), "utf8");
    assert.match(contributing, /429 and 503 while retriesSoFar is less than 3/);
    for (const arm of ["dated-sources", "repo-memorynet"]) {
      assert.equal(await readFile(join(folder, arm, "CONTRIBUTING.md"), "utf8"), contributing);
    }
    const revision = await readFile(join(folder, "dated-sources/docs/decisions/2026-09-18-retry-policy-revision.md"), "utf8");
    assert.match(revision, /Replaces the 2026-03-12/);
    assert.doesNotMatch(revision, /approved|superseded|memoryId/);
    for (const arm of ["repo-instructions", "repo-memorynet"]) {
      await assert.rejects(() => stat(join(folder, arm, "docs")), /ENOENT/);
      await assert.rejects(() => stat(join(folder, arm, "decisions.json")), /ENOENT/);
    }
    assert.deepEqual(Object.keys(manifest.armSetup["dated-sources"].frozenFiles).sort(),
      ["CONTRIBUTING.md", "docs/decisions/2026-03-12-retry-policy.md", "docs/decisions/2026-09-18-retry-policy-revision.md"]);
    assert.equal(manifest.armSetup["repo-memorynet"].mcp, true);
    const repoContext = await collectCodingContext(demo.connectionFile, join(folder, "repo-memorynet/context.json"));
    assert.equal(repoContext.current[0]?.memoryId, manifest.after.current[0].memoryId);
    const recordPath = join(folder, "dated-sources/docs/decisions/2026-03-12-retry-policy.md");
    const record = await readFile(recordPath, "utf8");
    await writeFile(recordPath, `${record}\nedited`);
    await assert.rejects(() => verifyCodingArtifact(folder, "dated-sources"), /Evidence changed since preparation: docs\/decisions/);
    await writeFile(recordPath, record);
    // Artifacts following the stale instructions fail; artifacts following the dated revision pass.
    await writeFile(join(folder, "repo-instructions/retry-policy.mjs"), `export function shouldRetry(status, retriesSoFar) { return ${valid} && (status === 429 || status === 503) && retriesSoFar < 3; }`);
    assert.equal((await verifyCodingArtifact(folder, "repo-instructions")).passed, false);
    await writeFile(join(folder, "dated-sources/retry-policy.mjs"), `export function shouldRetry(status, retriesSoFar) { return ${valid} && status === 503 && retriesSoFar < 2; }`);
    assert.equal((await verifyCodingArtifact(folder, "dated-sources")).passed, true);
    // Positive control: the same ordinary file brought up to date differs only in its edit date and retry line.
    const maintained = await readFile(join(folder, "maintained-instructions/CONTRIBUTING.md"), "utf8");
    const changed = maintained.split("\n").filter((line, index) => line !== contributing.split("\n")[index]);
    assert.equal(maintained.split("\n").length, contributing.split("\n").length);
    assert.deepEqual(changed, [
      "Last edited 2026-09-18. This is an artificial evaluation repository, not a real team's guidance.",
      "- HTTP client retries: Retry HTTP 503 only while retriesSoFar is less than 2. Never retry HTTP 429 or any other status.",
    ]);
    await assert.rejects(() => stat(join(folder, "maintained-instructions/docs")), /ENOENT/);
    assert.equal(manifest.armSetup["maintained-instructions"].mcp, false);
    await writeFile(join(folder, "maintained-instructions/retry-policy.mjs"), `export function shouldRetry(status, retriesSoFar) { return ${valid} && status === 503 && retriesSoFar < 2; }`);
    assert.equal((await verifyCodingArtifact(folder, "maintained-instructions")).passed, true);
    await assert.rejects(() => startCodingDemo(folder), /EEXIST/);
  } finally {
    await demo.close();
    await assert.rejects(() => stat(join(folder, "binding.json")), /ENOENT/);
    await rm(parent, { recursive: true, force: true });
  }
});
