// Runs the local test app on http://localhost:3050. Public or synthetic data only; it listens on this computer alone.
import {existsSync} from "node:fs";
import {resolve} from "node:path";
import {loadPrototypeConfig} from "./prototype-config.ts";
import {loadCheckoutCatalog} from "../repository-checkouts.ts";
import { createContext } from "../context.ts";
import { migrate, openDatabase } from "../db.ts";
import { createGuardRuntime } from "../decision-guard/runtime.ts";
import { readAgentBindingFile } from "../agent-context/binding.ts";
import { createApp, type App } from "./app.ts";
import { APP_PORT } from "./kit.ts";
import { createLocalHttpServer } from "./http.ts";

const HOST = "127.0.0.1";
// No GitHub sync refreshes access reports locally, so they stay current longer than the real 15 minutes.
const LOCAL_ACCESS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const configuredPrototype = process.env.MEMORYNET_PROTOTYPE_CONFIG;
const prototypePath = configuredPrototype === "off" ? undefined : configuredPrototype ?? (existsSync(".local/prototype/config.json") ? resolve(".local/prototype/config.json") : undefined);
const prototype = prototypePath ? await loadPrototypeConfig(prototypePath) : undefined;
const checkouts = prototype ? await loadCheckoutCatalog(prototype.checkoutManifestFile) : undefined;
const dataDir = prototype?.dataDir ?? process.env.MEMORYNET_DATA_DIR ?? ".data/memorynet";

const db = await openDatabase(dataDir);
let app: App;
try {
  await migrate(db);
  // The embedded database never gathers table statistics by itself; without them large organizations get slow plans.
  await db.exec("ANALYZE");
  const ctx = createContext(db, {
    repositoryAccessMaxAgeMs: LOCAL_ACCESS_MAX_AGE_MS,
  });
  const decisionGuard = createGuardRuntime({
    apiKey: process.env.MODEL_API_KEY,
    agentId: process.env.MEMORYNET_META_AGENT_ID,
    maxRequests: process.env.MEMORYNET_META_MAX_REQUESTS ? Number(process.env.MEMORYNET_META_MAX_REQUESTS) : undefined,
    onFailure: (event) => console.warn(JSON.stringify(event)),
  });
  const bindingPath = process.env.MEMORYNET_AGENT_BINDING_FILE;
  if(prototype){
    const row=(await db.query<{github_user_id:string;kind:string}>("SELECT github_user_id,kind FROM principals WHERE id=$1",[prototype.principalId])).rows[0];
    if(!row||row.kind!=="human"||row.github_user_id!==prototype.githubUserId)throw new Error("Prototype operator does not match the configured GitHub identity");
  }
  app = createApp(ctx, { port: APP_PORT, decisionGuard, checkouts, prototype,
    agentBinding: bindingPath ? () => readAgentBindingFile(bindingPath) : undefined,
  });
} catch (error) {
  await db.close();
  throw error;
}

const { server, close } = createLocalHttpServer(app, APP_PORT);

let closing = false;
async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  await close();
  await db.close();
  process.exit(code);
}

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${APP_PORT} is already in use. Stop the other process and try again.`
      : error,
  );
  void shutdown(1);
});
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

server.listen(APP_PORT, HOST, () => {
  console.log(`MemoryNet ${prototype ? "secured local prototype" : "local test app"}: http://localhost:${APP_PORT}`);
  console.log(
    `Database: ${dataDir} (public or synthetic evidence only). Press Ctrl+C to stop.`,
  );
});
