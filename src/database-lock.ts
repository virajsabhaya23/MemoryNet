import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

interface LockOwner { pid: number; hostname: string; createdAt: string }

async function readOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const info = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    if (Number.isSafeInteger(info.pid) && info.pid > 0 && typeof info.hostname === "string" && typeof info.createdAt === "string") return info;
  } catch { /* A process may still be writing the owner record. Fail closed. */ }
  return null;
}

// macOS appends the current network's DNS domain to the host name, so compare only the machine label.
const machine = (name: string) => name.split(".")[0]!.toLowerCase();

/** True only when the owner provably stopped: recorded on this computer, and no process with its ID is running. */
function ownerStopped(owner: LockOwner): boolean {
  if (machine(owner.hostname) !== machine(hostname())) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

const sameOwner = (a: LockOwner, b: LockOwner) => a.pid === b.pid && a.hostname === b.hostname && a.createdAt === b.createdAt;

/**
 * Replaces a lock left by a stopped process with a new, empty lock directory for this process. A guard directory
 * serializes reclaimers and the owner is re-checked under it. Only an owner's own release or a guarded reclaim removes
 * a lock, so the directory deleted here is exactly the one verified as abandoned.
 */
async function reclaim(lockPath: string, stale: LockOwner): Promise<"reclaimed" | "busy" | "changed"> {
  const guard = `${lockPath}.reclaim`;
  try {
    await mkdir(guard, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "busy";
    throw error;
  }
  try {
    const current = await readOwner(lockPath);
    if (!current || !sameOwner(current, stale) || !ownerStopped(current)) return "changed";
    await rm(lockPath, { recursive: true, force: true });
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return "reclaimed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "changed"; // A new owner started in between.
      throw error;
    }
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

/**
 * One local process owns a database. A lock whose owner is running, ran on another computer, or left no readable
 * owner record is never removed; only a lock left by a process proven stopped on this computer is reclaimed.
 */
export async function lockDatabase(dataDir: string): Promise<() => Promise<void>> {
  const directory = await realpath(dataDir);
  const lockPath = `${directory}.memorynet-lock`;
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stale = await readOwner(lockPath);
    const outcome = stale && ownerStopped(stale) ? await reclaim(lockPath, stale) : "held";
    if (outcome !== "reclaimed") {
      const owner = outcome === "held" ? stale : await readOwner(lockPath);
      const hint = outcome === "busy"
        ? `Another process is recovering this lock; if none is running, remove ${lockPath}.reclaim.`
        : `Stop the owning process first. If it ran on another computer or left no owner record, verify every process using this database has stopped before removing ${lockPath}.`;
      throw new Error(`Database is locked (${owner ? `PID ${owner.pid} on ${owner.hostname}` : "unknown owner"}). ${hint}`);
    }
    console.warn(`Removed a database lock left by PID ${stale!.pid}, which is no longer running on this computer (locked since ${stale!.createdAt}).`);
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
