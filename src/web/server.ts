// Runs the local test app on http://localhost:3050. Public or synthetic data only; it listens on this computer alone.
import {existsSync} from "node:fs";
import {resolve} from "node:path";
import {loadPrototypeConfig} from "./prototype-config.ts";
import {loadCheckoutCatalog} from "../repository-checkouts.ts";
import { createContext, DEFAULT_REPOSITORY_ACCESS_MAX_AGE_MS } from "../context.ts";
import { openMigratedDatabase } from "../database-upgrade.ts";
import { createGuardRuntime } from "../decision-guard/runtime.ts";
import { readAgentBindingFile } from "../agent-context/binding.ts";
import { createGitHubClient } from "../github.ts";
import { createApp, type App } from "./app.ts";
import { APP_PORT } from "./kit.ts";
import { createLocalHttpServer } from "./http.ts";
import { readWorkspaceProfile } from "../workspace.ts";
import { resolveAccessMode } from "./access-mode.ts";

const HOST = "127.0.0.1";
// Without GitHub sign-in nothing refreshes access reports locally, so they stay current longer than the real 15 minutes.
const LOCAL_ACCESS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const configuredPrototype = process.env.MEMORYNET_PROTOTYPE_CONFIG;
const prototypePath = configuredPrototype === "off" ? undefined : configuredPrototype ?? (existsSync(".local/prototype/config.json") ? resolve(".local/prototype/config.json") : undefined);
let prototype = prototypePath ? await loadPrototypeConfig(prototypePath, false) : undefined;
const checkouts = prototype ? await loadCheckoutCatalog(prototype.checkoutManifestFile) : undefined;
const profile = prototype ? null : await readWorkspaceProfile();
const dataDir = prototype?.dataDir ?? process.env.MEMORYNET_DATA_DIR ?? profile?.dataDir ?? ".data/memorynet";
// A data-dir override must never silently pick an operator from a different workspace.
const operatorId = prototype?.principalId ?? (profile && resolve(profile.dataDir) === resolve(dataDir) ? profile.operatorId : undefined);
const githubClientId = process.env.MEMORYNET_GITHUB_CLIENT_ID?.trim();
const accessMode = resolveAccessMode(process.env.MEMORYNET_AUTH_MODE, !!operatorId, {
  github: !!githubClientId, accessKey: !!prototype?.accessKeyFile,
});
if (accessMode === "access-key" && prototypePath) prototype = await loadPrototypeConfig(prototypePath);
if (accessMode === "access-key" && !prototype?.accessKeyHash) throw new Error("Access-key mode requires a prototype configuration and key");
if (accessMode === "github" && !githubClientId) throw new Error("GitHub sign-in requires MEMORYNET_GITHUB_CLIENT_ID");
const github = githubClientId && (accessMode === "local" || accessMode === "github")
  ? { client: createGitHubClient({ clientId: githubClientId, scope: process.env.MEMORYNET_GITHUB_SCOPE?.trim() ?? "" }) }
  : undefined;

const { db } = await openMigratedDatabase(dataDir);
let app: App;
try {
  // The embedded database never gathers table statistics by itself; without them large organizations get slow plans.
  await db.exec("ANALYZE");
  const ctx = createContext(db, accessMode === "github"
    // Only access GitHub confirms during this run counts; reports declared before it started are ignored.
    ? { repositoryAccessMaxAgeMs: DEFAULT_REPOSITORY_ACCESS_MAX_AGE_MS, repositoryAccessNotBefore: new Date() }
    : { repositoryAccessMaxAgeMs: LOCAL_ACCESS_MAX_AGE_MS });
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
  if (accessMode === "local") {
    const row = (await db.query<{kind:string}>("SELECT kind FROM principals WHERE id=$1", [operatorId])).rows[0];
    if (row?.kind !== "human") throw new Error("Local workspace operator must be an existing human principal");
  }
  app = createApp(ctx, { port: APP_PORT, decisionGuard, checkouts, github,
    localPrincipalId: accessMode === "local" ? operatorId : undefined,
    prototype: accessMode === "access-key" ? { ...prototype!, accessKeyHash: prototype!.accessKeyHash! } : undefined,
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
  console.log(`MemoryNet ${accessMode === "local" ? "local workspace (no sign-in required)" : accessMode === "github" ? "with GitHub sign-in" : accessMode === "access-key" ? "with local access-key sign-in" : "development sandbox"}: http://localhost:${APP_PORT}`);
  console.log(
    `Database: ${dataDir} (public or synthetic evidence only). Press Ctrl+C to stop.`,
  );
});
