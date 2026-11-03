import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { freezePreregistration, preregistrationSchema } from "../src/evaluation/preregistration.ts";

async function fixture(run: (dir: string, plan: any, repo: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "memorynet-prereg-"));
  const repo = join(dir, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    execFileSync("git", ["init", "-q", repo]);
    await writeFile(join(repo, "README.md"), "Public repository fixture\n");
    git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
    git("remote", "add", "origin", "https://github.com/example/test.git");
    const files: Record<string, { path: string; sha256: string }> = {};
    for (const name of ["prompt", "evidence", "before", "after", "oracle"]) {
      const text = `${name}\n`;
      await writeFile(join(dir, `${name}.txt`), text);
      files[name] = { path: `${name}.txt`, sha256: createHash("sha256").update(text).digest("hex") };
    }
    const plan = {
      schemaVersion: 1, studyId: "public-smoke", purpose: "smoke",
      repository: { url: "https://github.com/example/test", commit: git("rev-parse", "HEAD") },
      model: { provider: "test", id: "pinned-model", parameters: { temperature: 0 } },
      arms: ["maintained-agents-md", "memorynet"],
      budgetPerTaskPerArm: { maxToolCalls: 20, maxOutputTokens: 8000, maxMinutes: 10 }, repetitions: 1,
      primaryMetrics: ["stale_implementation_rate", "human_maintenance_minutes"],
      tasks: [{ id: "change-1", prompt: files.prompt, evidence: files.evidence, instructionsBefore: files.before, instructionsAfter: files.after, oracle: files.oracle, changeAtToolCall: 5, concurrentTasks: 2 }],
    };
    await run(dir, plan, repo);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("preregistration freezes verified bytes and never overwrites an existing lock", async () => {
  await fixture(async (dir, plan, repo) => {
    const manifest = join(dir, "plan.json"), lock = join(dir, "lock.json");
    await writeFile(manifest, JSON.stringify(plan));
    const result = await freezePreregistration(manifest, repo, lock);
    assert.equal(result.artifactCount, 5);
    const saved = JSON.parse(await readFile(lock, "utf8"));
    assert.equal(Buffer.from(saved.snapshots[0].contentBase64, "base64").toString(), "prompt\n");
    await assert.rejects(freezePreregistration(manifest, repo, lock), { code: "EEXIST" });
    await writeFile(join(dir, "before.txt"), "tampered");
    await assert.rejects(freezePreregistration(manifest, repo, join(dir, "other.json")), /hash mismatch/);
  });
});

test("preregistration rejects dirty/wrong repositories, unbalanced arms, missing transitions and symlink artifacts", async () => {
  await fixture(async (dir, plan, repo) => {
    const manifest = join(dir, "plan.json"), lock = join(dir, "lock.json");
    await writeFile(manifest, JSON.stringify(plan));
    await writeFile(join(repo, "unexpected.txt"), "dirty");
    await assert.rejects(freezePreregistration(manifest, repo, lock), /must be clean/);
    await rm(join(repo, "unexpected.txt"));
    const wrong = { ...plan, repository: { ...plan.repository, commit: "0".repeat(40) } };
    await writeFile(manifest, JSON.stringify(wrong));
    await assert.rejects(freezePreregistration(manifest, repo, lock), /HEAD differs/);
    assert.equal(preregistrationSchema.safeParse({ ...plan, arms: ["memorynet"] }).success, false);
    assert.equal(preregistrationSchema.safeParse({ ...plan, purpose: "study" }).success, false);
    assert.equal(preregistrationSchema.safeParse({ ...plan, tasks: [{ ...plan.tasks[0], changeAtToolCall: 20 }] }).success, false);
    await rm(join(dir, "oracle.txt"));
    await symlink("prompt.txt", join(dir, "oracle.txt"));
    await writeFile(manifest, JSON.stringify(plan));
    await assert.rejects(freezePreregistration(manifest, repo, lock), /symlinks/);
  });
});
