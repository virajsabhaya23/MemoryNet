import { realpath } from "node:fs/promises";
import { backupDatabase } from "./database-backup.ts";
import { migrate, openDatabase, pendingMigrations, type Database } from "./db.ts";

export interface MigratedDatabase { db: Database; applied: string[]; backup: string | null }

/** `<database>.backups/<time>-before-<first pending migration>`: beside the database, never inside it. */
export async function upgradeBackupPath(dataDir: string, firstPending: string, now = new Date()): Promise<string> {
  return `${await realpath(dataDir)}.backups/${now.toISOString().replace(/[:.]/g, "-")}-before-${firstPending.replace(/\.sql$/, "")}`;
}

/**
 * Opens a database and applies pending migrations. A database that already holds migrated data is first copied to a
 * verified backup beside it, so an upgrade can be undone with db:restore. MEMORYNET_UPGRADE_BACKUP=off skips the copy.
 */
export async function openMigratedDatabase(dataDir: string, options: { backup?: boolean; now?: Date } = {}): Promise<MigratedDatabase> {
  let db = await openDatabase(dataDir);
  try {
    const { applied, pending } = await pendingMigrations(db);
    let backup: string | null = null;
    if (applied > 0 && pending.length > 0 && (options.backup ?? process.env.MEMORYNET_UPGRADE_BACKUP !== "off")) {
      await db.close(); // A backup copies a stopped database under its own lock.
      backup = await backupDatabase(dataDir, await upgradeBackupPath(dataDir, pending[0]!, options.now));
      console.log(`Backed up the database before applying ${pending.length} upgrade(s): ${backup}`);
      db = await openDatabase(dataDir);
    }
    return { db, applied: await migrate(db), backup };
  } catch (error) {
    await db.close();
    throw error;
  }
}
