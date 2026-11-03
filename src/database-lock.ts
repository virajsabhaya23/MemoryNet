import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

/** One local process owns a database. Never guess that an existing lock is stale. */
export async function lockDatabase(dataDir: string): Promise<() => Promise<void>> {
  const directory = await realpath(dataDir);
  const lockPath = `${directory}.memorynet-lock`;
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner = "unknown owner";
    try {
      const info = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
      if (Number.isSafeInteger(info.pid) && typeof info.hostname === "string") owner = `PID ${info.pid} on ${info.hostname}`;
    } catch { /* A process may still be writing the owner record. Fail closed. */ }
    throw new Error(`Database is locked (${owner}). Stop the owning process first. If it crashed, verify it has stopped before removing ${lockPath}.`);
  }
  try {
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    await rm(lockPath, { recursive: true });
    released = true;
  };
}
