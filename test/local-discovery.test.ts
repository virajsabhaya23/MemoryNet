import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { previewWorkspace, selectedCheckout } from "../src/local-discovery.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memorynet-discovery-"));
  const dir = join(root, "alpha");
  await mkdir(join(dir, "docs/specs"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture",
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "--template=", "-b", "main");
  for (const [name, value] of [["README.md", "Committed markdown"], [".env", "ignored"], ["docs/specs/tokens.md", "excluded"],
    ["docs/specs/small.md", "specification"], ["docs/specs/large.md", "a".repeat(65537)], ["docs/specs/binary.md", "a\0b"],
    ["docs/specs/bad.md", "api_key=abc123456789fake"]]) await writeFile(join(dir, name!), value!);
  git("add", "-f", "."); git("commit", "-qm", "Fixture");
  return { root, dir, git };
}

test("preview selects real named checkouts, masks origin secrets and imports only an allowed committed blob", async () => {
  const { root, dir, git } = await fixture();
  try {
    git("remote", "add", "origin", "https://fixture:synthetic@invalid.example/acme/repo?token=private");
    git("gc", "--prune=now", "--quiet");
    await mkdir(join(root, "ordinary")); await mkdir(join(root, "node_modules", "fake", ".git"), { recursive: true });
    await writeFile(join(dir, "README.md"), "working tree secret");
    const { repositories, unsupported } = await previewWorkspace(root);
    assert.deepEqual(unsupported, []); assert.equal(repositories.length, 1);
    assert.equal(repositories[0]?.origin, "invalid.example");
    assert.deepEqual(repositories[0]?.documents, ["README.md", "docs/specs/bad.md", "docs/specs/binary.md", "docs/specs/large.md", "docs/specs/small.md"]);
    const { evidence, repository } = await selectedCheckout(root, "alpha", "README.md");
    assert.equal(evidence?.excerpt, "Committed markdown"); assert.deepEqual(repository, repositories[0]);
    for (const path of ["../outside", ".env", "docs/specs/tokens.md", "docs/specs/bad.md", "docs/specs/binary.md", "docs/specs/large.md"])
      await assert.rejects(selectedCheckout(root, "alpha", path));
    await assert.rejects(selectedCheckout(root, "../alpha")); await assert.rejects(selectedCheckout(root, "ordinary"));
    await writeFile(join(dir, ".git/objects/info/alternates"), "/outside\n");
    assert.equal((await previewWorkspace(root)).repositories.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discovery refuses worktree pointers, bare repositories and detached heads", async () => {
  const { root, dir, git } = await fixture();
  try {
    for (const name of ["linked", "bare/objects"]) await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, "linked/.git"), "gitdir: /outside");
    await writeFile(join(root, "bare/HEAD"), "ref: refs/heads/main");
    git("checkout", "-q", "--detach");
    const preview = await previewWorkspace(root);
    assert.equal(preview.repositories.length, 0); assert.equal(preview.unsupported.length, 3);
    assert.ok(!JSON.stringify(preview).includes(dir));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("linked checkout, ref, object store entries and committed document links cannot escape the root", { skip: process.platform === "win32" }, async () => {
  const { root, dir, git } = await fixture();
  try {
    await symlink("README.md", join(dir, "AGENTS.md")); git("add", "-f", "AGENTS.md"); git("commit", "-qm", "Link");
    await symlink(dir, join(root, "alias"));
    assert.equal((await previewWorkspace(root)).repositories.length, 1);
    await assert.rejects(selectedCheckout(root, "alias"));
    await assert.rejects(selectedCheckout(root, "alpha", "AGENTS.md"));
    await symlink(join(dir, "README.md"), join(dir, ".git/objects/pack/bad.pack"));
    await assert.rejects(selectedCheckout(root, "alpha"));
    await rm(join(dir, ".git/objects/pack/bad.pack"));
    await rm(join(dir, ".git/refs/heads/main")); await symlink(join(dir, "README.md"), join(dir, ".git/refs/heads/main"));
    await assert.rejects(selectedCheckout(root, "alpha"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
