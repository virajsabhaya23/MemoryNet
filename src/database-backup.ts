import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { lockDatabase } from "./database-lock.ts";

const safePath = z.string().min(1).max(1024).refine((p) =>
  !p.includes("\\") && !p.includes("\0") && !p.includes(":") && p.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
const EntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: safePath }).strict(),
  z.object({ kind: z.literal("file"), path: safePath, bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const ManifestSchema = z.object({
  format: z.literal("memorynet-offline-backup-v1"), createdAt: z.iso.datetime(),
  pgliteVersion: z.string().min(1), entries: z.array(EntrySchema).min(1).max(100_000),
}).strict();
type Entry = z.infer<typeof EntrySchema>;

async function version(): Promise<string> {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  return lock.packages["node_modules/@electric-sql/pglite"].version;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inventory(root: string, prefix = ""): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    safePath.parse(path);
    const file = join(root, path);
    const info = await lstat(file);
    if (info.isDirectory()) {
      entries.push({ kind: "directory", path }, ...await inventory(root, path));
    } else if (info.isFile()) {
      entries.push({ kind: "file", path, bytes: info.size, sha256: await hashFile(file) });
    } else {
      throw new Error(`Backup refuses symlinks and special files: ${path}`);
    }
  }
  return entries;
}

async function newDestination(path: string, source: string): Promise<string> {
  const absolute = resolve(path);
  // Resolve existing ancestors before creating anything (including through symlink aliases).
  let ancestor = dirname(absolute);
  let suffix = absolute.slice(ancestor.length + 1);
  let canonical: string;
  for (;;) {
    try { canonical = join(await realpath(ancestor), suffix); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      suffix = join(ancestor.slice(parent.length + 1), suffix);
      ancestor = parent;
    }
  }
  if (canonical === source || canonical.startsWith(source + sep) || source.startsWith(canonical + sep)) {
    throw new Error("Source and destination must be separate directories");
  }
  await mkdir(dirname(canonical), { recursive: true, mode: 0o700 });
  await mkdir(canonical, { mode: 0o700 }); // Refuse overwrite, including empty directories.
  return canonical;
}

async function copyEntries(source: string, destination: string, entries: Entry[]): Promise<void> {
  for (const entry of entries) {
    const target = join(destination, entry.path);
    if (entry.kind === "directory") await mkdir(target, { mode: 0o700 });
    else {
      await copyFile(join(source, entry.path), target, constants.COPYFILE_EXCL);
      await chmod(target, 0o600);
    }
  }
}

/** Stop all MemoryNet processes first. Whole-directory copy, including reviews and receipts. */
export async function backupDatabase(dataDir: string, output: string): Promise<string> {
  const source = await realpath(dataDir);
  const release = await lockDatabase(source);
  let destination: string | undefined;
  try {
    const entries = await inventory(source);
    if (!entries.some((e) => e.kind === "file" && e.path === "PG_VERSION")) throw new Error("Source is not a PostgreSQL data directory");
    destination = await newDestination(output, source);
    const snapshot = join(destination, "database");
    await mkdir(snapshot, { mode: 0o700 });
    await copyEntries(source, snapshot, entries);
    if (JSON.stringify(await inventory(snapshot)) !== JSON.stringify(entries)) throw new Error("Backup copy failed integrity verification");
    const manifest = ManifestSchema.parse({ format: "memorynet-offline-backup-v1", createdAt: new Date().toISOString(), pgliteVersion: await version(), entries });
    await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return destination;
  } catch (error) {
    if (destination) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally { await release(); }
}

/** Restore only to a new directory; never overwrite the currently configured database. */
export async function restoreDatabase(backup: string, target: string): Promise<string> {
  const source = await realpath(backup);
  const manifestFile = join(source, "manifest.json");
  const info = await lstat(manifestFile);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("Invalid backup manifest");
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")));
  if (manifest.pgliteVersion !== await version()) throw new Error("Restore using the same PGlite version that created this backup, then migrate with the newer application");
  const snapshot = join(source, "database");
  if (!(await lstat(snapshot)).isDirectory()) throw new Error("Backup database must be a directory, not a symlink");
  const entries = await inventory(snapshot);
  if (JSON.stringify(entries) !== JSON.stringify(manifest.entries) || !entries.some((e) => e.kind === "file" && e.path === "PG_VERSION")) {
    throw new Error("Backup integrity check failed; no database restored");
  }
  const destination = await newDestination(target, source);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockDatabase(destination);
    await copyEntries(snapshot, destination, entries);
    if (JSON.stringify(await inventory(destination)) !== JSON.stringify(entries)) throw new Error("Restored files failed integrity verification");
    return destination;
  } catch (error) {
    // Do not remove a destination acquired by another process in the creation/lock interval.
    if (release) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally { await release?.(); }
}
