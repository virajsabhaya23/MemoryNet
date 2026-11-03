// Creates or updates the local embedded database. Synthetic data only.
import { migrate, openDatabase } from "../db.ts";

const dataDir = process.env.MEMORYNET_DATA_DIR ?? ".data/memorynet";
const db = await openDatabase(dataDir);
try {
  const applied = await migrate(db);
  console.log(
    applied.length > 0
      ? `Applied migrations: ${applied.join(", ")}`
      : "Database is already up to date",
  );
  console.log(`Database directory: ${dataDir}`);
} finally {
  await db.close();
}
