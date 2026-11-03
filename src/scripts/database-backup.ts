import { backupDatabase, restoreDatabase } from "../database-backup.ts";

try {
  const [command, input, output, ...extra] = process.argv.slice(2);
  if (extra.length || !input || (command === "backup" && output) || (command === "restore" && !output) || !["backup", "restore"].includes(command ?? "")) {
    throw new Error("Usage: npm run db:backup -- <new-backup-directory> | npm run db:restore -- <backup-directory> <new-data-directory>");
  }
  const path = command === "backup"
    ? await backupDatabase(process.env.MEMORYNET_DATA_DIR ?? ".data/memorynet", input)
    : await restoreDatabase(input, output!);
  console.log(`${command === "backup" ? "Verified backup" : "Verified restored database"}: ${path}`);
  if (command === "restore") console.log("Start the app with MEMORYNET_DATA_DIR set to this directory. Keep the original database until the restored data is checked.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Database operation failed");
  process.exitCode = 1;
}
