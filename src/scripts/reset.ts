// Deletes the local app database so the next `npm run app` starts empty. Synthetic data only.
import { connect } from "node:net";
import { resolve, sep } from "node:path";
import { APP_PORT } from "../web/kit.ts";
import { resetDatabase } from "../database-reset.ts";

const dataDir = resolve(process.env.MEMORYNET_DATA_DIR ?? ".data/memorynet");
const allowedRoot = resolve(".data");
if (!dataDir.startsWith(allowedRoot + sep)) {
  console.error(`Refusing to delete ${dataDir}: only folders inside ${allowedRoot} can be reset.`);
  process.exit(1);
}

const appRunning = await new Promise<boolean>((done) => {
  const socket = connect(APP_PORT, "127.0.0.1");
  socket.once("connect", () => {
    socket.destroy();
    done(true);
  });
  socket.once("error", () => done(false));
});
if (appRunning) {
  console.error(`The app is running on port ${APP_PORT}. Stop it (Ctrl+C) before resetting.`);
  process.exit(1);
}

try {
  await resetDatabase(dataDir, allowedRoot);
  console.log(`Deleted ${dataDir}. Run npm run app to start with an empty database.`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") console.log("No database to reset.");
  else {
    console.error(error instanceof Error ? error.message : "Reset failed");
    process.exitCode = 1;
  }
}
