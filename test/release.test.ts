import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportRelease } from "../src/release.ts";

test("release exports current source and features, excludes local state, and refuses overwrite or credential-shaped bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorynet-release-"));
  const repo = join(root, "repo"), output = join(root, "output");
  try {
    execFileSync("git", ["init", "-q", repo]);
    await mkdir(join(repo, "src", "web"), { recursive: true });
    for (const file of ["package.json", "package-lock.json", "README.md", "LICENSE", "src/web/server.ts"]) await writeFile(join(repo, file), "initial");
    await writeFile(join(repo, ".gitignore"), ".env.local\n.local/\n");
    await mkdir(join(repo, "docs"));
    await writeFile(join(repo, "docs/private-note.md"), "private tracked draft");
    execFileSync("git", ["-C", repo, "add", "."]);
    await writeFile(join(repo, ".gitignore"), ".env.local\n.local/\ndocs/private-note.md\n");
    await writeFile(join(repo, "src/web/server.ts"), "latest uncommitted implementation");
    await writeFile(join(repo, "src/feature.ts"), "new feature");
    await mkdir(join(repo, "website"));
    await writeFile(join(repo, "website/index.html"), "public static website");
    await writeFile(join(repo, "design.md"), "public website design system");
    await writeFile(join(repo, ".env.local"), "do not export");
    await mkdir(join(repo, "demo"));
    await writeFile(join(repo, "demo/private.txt"), "do not export");
    const result = await exportRelease(repo, output);
    assert.equal(await readFile(join(output, "src/web/server.ts"), "utf8"), "latest uncommitted implementation");
    assert.equal(await readFile(join(output, "src/feature.ts"), "utf8"), "new feature");
    assert.equal(await readFile(join(output, "website/index.html"), "utf8"), "public static website");
    assert.equal(await readFile(join(output, "design.md"), "utf8"), "public website design system");
    await assert.rejects(stat(join(output, ".env.local")), { code: "ENOENT" });
    await assert.rejects(stat(join(output, "demo")), { code: "ENOENT" });
    await assert.rejects(stat(join(output, "docs/private-note.md")), { code: "ENOENT" });
    await assert.rejects(stat(join(output, ".git")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(join(output, "RELEASE-MANIFEST.json"), "utf8")).files.length, result.files);
    await assert.rejects(exportRelease(repo, output), /EEXIST/);
    await writeFile(join(repo, "src/leak.ts"), "ghp_" + "x".repeat(40));
    await assert.rejects(exportRelease(repo, join(root, "rejected")), /Potential credential.*src\/leak/);
    await assert.rejects(stat(join(root, "rejected")), { code: "ENOENT" });
    await rm(join(repo, "src/leak.ts"));
    await symlink("../.env.local", join(repo, "src/alias.ts"));
    await assert.rejects(exportRelease(repo, join(root, "symlink")), /refuses symlinks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
