import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("published ESLint example verifies its source evidence without the ignored demo workspace", () => {
  const script = fileURLToPath(new URL("../examples/eslint-demo/scenario/verify-sources.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.entries(JSON.parse(result.stdout)).filter(([key]) => key !== "checkedAt"), [
    ["status", "pass"], ["repository", "eslint/eslint"], ["sources", 2], ["releases", 2],
  ]);
});

test("published ESLint oracle reports a missing consumer as a machine-readable failure", () => {
  const script = fileURLToPath(new URL("../examples/eslint-demo/scenario/oracle.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, `${tmpdir()}/memorynet-missing-${process.pid}`], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.outcome, "fail");
  assert.match(outcome.reason, /ENOENT/);
});
