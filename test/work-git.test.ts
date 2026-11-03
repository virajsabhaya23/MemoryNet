import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { reconcileWorkArtifacts } from "../src/work-git.ts";

test("Git reconciliation uses exact committed bytes, detects mismatches and rejects unavailable commits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memorynet-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    await writeFile(join(dir, "spec.md"), "Requirement R1\r\n");
    await symlink("spec.md", join(dir, "link"));
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
    const codeCommit = git("rev-parse", "HEAD");
    const sha256 = createHash("sha256").update("Requirement R1\r\n").digest("hex");
    const artifact = { kind: "spec" as const, requirementId: "R1", path: "spec.md", sha256 };
    await writeFile(join(dir, "spec.md"), "Uncommitted changes");
    assert.equal((await reconcileWorkArtifacts(dir, { codeCommit, artifacts: [artifact] })).outcome, "match");
    const receipt = await reconcileWorkArtifacts(dir, { codeCommit, artifacts: [
      { ...artifact, sha256: "0".repeat(64) }, { ...artifact, path: "missing" }, { ...artifact, path: "link" }] });
    assert.deepEqual(receipt.artifacts.map(a => a.status), ["changed", "missing", "unsupported"]);
    await assert.rejects(reconcileWorkArtifacts(dir, { codeCommit: "0".repeat(40), artifacts: [artifact] }));
    await assert.rejects(reconcileWorkArtifacts(dir, { codeCommit, artifacts: [{ ...artifact, path: "../secret" }] }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
