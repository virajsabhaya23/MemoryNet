import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { lockDatabase } from "./database-lock.ts";

/** Destructive local reset, constrained by canonical paths and the database writer lock. */
export async function resetDatabase(dataDir: string, allowedRoot = ".data"): Promise<void> {
  const [directory, root] = await Promise.all([realpath(dataDir), realpath(allowedRoot)]);
  if (!resolve(dataDir).startsWith(resolve(allowedRoot) + sep) || !directory.startsWith(root + sep)) {
    throw new Error("Reset only supports databases below .data; symlinks cannot escape that directory");
  }
  if (!await isDatabaseDirectory(directory)) {
    throw new Error("Reset requires a database directory, not a parent folder");
  }
  const release = await lockDatabase(directory);
  try {
    await refuseNestedDatabases(directory);
    await rm(directory, { recursive: true });
  }
  finally { await release(); }
}

async function refuseNestedDatabases(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.endsWith(".memorynet-lock")) throw new Error("Reset refuses a folder containing another database lock");
    if (entry.isDirectory()) {
      const path = join(directory, entry.name);
      if (await isDatabaseDirectory(path)) throw new Error("Reset refuses a folder containing another database");
      await refuseNestedDatabases(path);
    }
  }
}

async function isDatabaseDirectory(path: string): Promise<boolean> {
  // PostgreSQL also stores PG_VERSION in base/<database OID>; only a cluster has global/pg_control.
  const [version, global, control] = await Promise.all([
    lstat(join(path, "PG_VERSION")).catch(() => null),
    lstat(join(path, "global")).catch(() => null),
    lstat(join(path, "global/pg_control")).catch(() => null),
  ]);
  return Boolean(version?.isFile() && global?.isDirectory() && control?.isFile());
}
