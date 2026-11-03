import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backupDatabase, restoreDatabase } from "../src/database-backup.ts";
import { resetDatabase } from "../src/database-reset.ts";
import { migrate, openDatabase } from "../src/db.ts";
import { createContext, getMemory, getProposal } from "../src/index.ts";
import { buildWorld } from "./helpers.ts";

test("database ownership excludes other processes and symlink aliases, and releases after close", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorynet-lock-"));
  const directory = join(root, "data");
  const db = await openDatabase(directory);
  try {
    await symlink(directory, join(root, "alias"), "dir");
    await assert.rejects(openDatabase(join(root, "alias")), /Database is locked/);
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `import { openDatabase } from ${JSON.stringify(new URL("../src/db.ts", import.meta.url).href)};
       try { const db = await openDatabase(process.argv[1]); await db.close(); process.exitCode = 1; }
       catch (error) { process.exitCode = error.message.includes('Database is locked') ? 0 : 2; }`, directory], { stdio: "ignore" });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0);
    await assert.rejects(backupDatabase(directory, join(root, "backup")), /Database is locked/);
    await assert.rejects(resetDatabase(directory, root), /Database is locked/);
    // A lock on an arbitrary parent must not authorize recursively deleting an active child.
    await assert.rejects(resetDatabase(root, tmpdir()), /database directory/);
  } finally { await db.close(); }
  try {
    const reopened = await openDatabase(directory);
    await reopened.close();
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("offline backup restores reviews, evidence and identities; rejects overwrite and corrupt archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorynet-backup-"));
  const directory = join(root, "data");
  try {
    const db = await openDatabase(directory);
    let world;
    try { await migrate(db); world = await buildWorld(createContext(db)); }
    finally { await db.close(); }
    const snapshot = await backupDatabase(directory, join(root, "backup"));
    if (process.platform !== "win32") assert.equal((await stat(join(snapshot, "manifest.json"))).mode & 0o077, 0);
    await assert.rejects(backupDatabase(directory, snapshot), /EEXIST/);
    await assert.rejects(backupDatabase(directory, join(directory, "new", "backup")), /separate directories/);
    await assert.rejects(stat(join(directory, "new")), { code: "ENOENT" });
    const restoredPath = await restoreDatabase(snapshot, join(root, "restored"));
    const restored = await openDatabase(restoredPath);
    try {
      assert.deepEqual(await migrate(restored), []);
      const ctx = createContext(restored);
      assert.deepEqual(await getMemory(ctx, world.people.reader.id, world.memories.alphaApproved.id), world.memories.alphaApproved);
      assert.equal((await getProposal(ctx, world.people.contributor.id, world.proposals.alphaPending.id)).status, "pending");
    } finally { await restored.close(); }
    await assert.rejects(restoreDatabase(snapshot, restoredPath), /EEXIST/);
    await writeFile(join(snapshot, "database", "PG_VERSION"), "corrupted\n");
    await assert.rejects(restoreDatabase(snapshot, join(root, "corrupt")), /integrity/);
    await assert.rejects(stat(join(root, "corrupt")), { code: "ENOENT" });
    const manifestPath = join(snapshot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.entries[0].path = "../escape";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(restoreDatabase(snapshot, join(root, "escape-target")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reset refuses a symlink escaping the data root and preserves the external database", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorynet-reset-"));
  const inside = join(root, ".data");
  const outside = join(root, "outside");
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(inside);
    const db = await openDatabase(outside);
    await db.close();
    await symlink(outside, join(inside, "escape"), "dir");
    await assert.rejects(resetDatabase(join(inside, "escape"), inside), /symlinks cannot escape/);
    assert.ok((await stat(join(outside, "PG_VERSION"))).isFile());
    const disposable = join(inside, "disposable");
    const local = await openDatabase(disposable);
    await local.close();
    await resetDatabase(disposable, inside);
    await assert.rejects(stat(disposable), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
