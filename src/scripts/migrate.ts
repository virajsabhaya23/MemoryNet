// Creates or updates the local embedded database, backing up an existing one first. Synthetic data only.
import { openMigratedDatabase } from "../database-upgrade.ts";

const dataDir = process.env.MEMORYNET_DATA_DIR ?? ".data/memorynet";
const { db, applied } = await openMigratedDatabase(dataDir);
try {
  console.log(
    applied.length > 0
      ? `Applied migrations: ${applied.join(", ")}`
      : "Database is already up to date",
  );
  console.log(`Database directory: ${dataDir}`);
} finally {
  await db.close();
}
