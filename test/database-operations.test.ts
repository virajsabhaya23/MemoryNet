import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backupDatabase, restoreDatabase } from "../src/database-backup.ts";
import { lockDatabase } from "../src/database-lock.ts";
import { resetDatabase } from "../src/database-reset.ts";
import { openMigratedDatabase } from "../src/database-upgrade.ts";
import { migrate, migrationFiles, openDatabase } from "../src/db.ts";
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

async function stoppedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return child.pid!;
}

test("a lock left by a stopped process on this computer is reclaimed; live, foreign and unreadable locks are not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorynet-stale-lock-"));
  const directory = join(root, "data");
  await mkdir(directory);
  const lock = `${await realpath(directory)}.memorynet-lock`;
  const plant = async (owner: object | null) => {
    await rm(lock, { recursive: true, force: true });
    await mkdir(lock);
    if (owner) await writeFile(join(lock, "owner.json"), JSON.stringify({ createdAt: "2026-11-02T22:47:22.584Z", ...owner }));
  };
  const owner = async () => JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
  const warn = t.mock.method(console, "warn", () => {});
  try {
    const dead = await stoppedPid();
    for (const host of [hostname(), `${hostname().split(".")[0]}.another-network.example`]) {
      await plant({ pid: dead, hostname: host });
      const release = await lockDatabase(directory);
      assert.equal((await owner()).pid, process.pid);
      await release();
      await assert.rejects(stat(lock), { code: "ENOENT" });
    }
    assert.match(String(warn.mock.calls[0]?.arguments[0]), new RegExp(`left by PID ${dead}, which is no longer running`));

    // The real app path recovers too, so a crash no longer keeps MemoryNet from starting.
    await plant({ pid: dead, hostname: hostname() });
    await (await openDatabase(directory)).close();

    await plant({ pid: process.pid, hostname: hostname() });
    await assert.rejects(lockDatabase(directory), new RegExp(`Database is locked \\(PID ${process.pid} on `));
    await plant({ pid: dead, hostname: "another-computer" });
    await assert.rejects(lockDatabase(directory), /Database is locked \(PID \d+ on another-computer\)/);
    await plant(null);
    await assert.rejects(lockDatabase(directory), /Database is locked \(unknown owner\)/);
    await plant({ pid: dead, hostname: hostname() });
    await mkdir(`${lock}.reclaim`);
    await assert.rejects(lockDatabase(directory), /Another process is recovering this lock/);
    assert.equal((await owner()).pid, dead, "a refused lock is left exactly as found");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an existing database is backed up before an upgrade; new and current databases are not", async (t) => {
  t.mock.method(console, "log", () => {});
  const root = await mkdtemp(join(tmpdir(), "memorynet-upgrade-"));
  const directory = join(root, "data");
  try {
    // An older version applied one migration this checkout no longer lists; every current file is pending.
    const old = await openDatabase(directory);
    await old.exec("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    await old.query("INSERT INTO schema_migrations (name) VALUES ('000_previous.sql')");
    await old.close();

    const now = new Date("2026-11-03T18:57:47.000Z");
    const upgraded = await openMigratedDatabase(directory, { backup: true, now });
    try {
      assert.deepEqual(upgraded.applied, await migrationFiles());
      assert.equal(upgraded.backup, `${await realpath(directory)}.backups/2026-11-03T18-57-47-000Z-before-${upgraded.applied[0]!.replace(".sql", "")}`);
    } finally { await upgraded.db.close(); }

    // The snapshot is the database as it was before the upgrade, and restores with the normal command.
    const restored = await restoreDatabase(upgraded.backup!, join(root, "restored"));
    const before = await openDatabase(restored);
    try {
      assert.deepEqual((await before.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name), ["000_previous.sql"]);
    } finally { await before.close(); }

    const current = await openMigratedDatabase(directory, { backup: true });
    await current.db.close();
    assert.deepEqual([current.applied, current.backup], [[], null]);
    const fresh = await openMigratedDatabase(join(root, "fresh"), { backup: true });
    await fresh.db.close();
    assert.equal(fresh.backup, null);
    assert.ok(fresh.applied.length > 0);

    const skipped = join(root, "skipped");
    const legacy = await openDatabase(skipped);
    await legacy.exec("CREATE TABLE schema_migrations (name text PRIMARY KEY)");
    await legacy.query("INSERT INTO schema_migrations (name) VALUES ('000_previous.sql')");
    await legacy.close();
    const optedOut = await openMigratedDatabase(skipped, { backup: false });
    await optedOut.db.close();
    assert.equal(optedOut.backup, null);
    await assert.rejects(stat(`${await realpath(skipped)}.backups`), { code: "ENOENT" });
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
