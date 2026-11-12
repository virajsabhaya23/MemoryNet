// Checks the local path from workspace to coding agent. Read-only: it records no retrieval and changes nothing.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bindingCapabilities, readAgentBindingFile } from "../agent-context/binding.ts";
import { AGENT_CONTEXT_PATH } from "../agent-context/contract.ts";
import { parseFlags } from "../cli-args.ts";
import { CLIENT_FILES, MCP_CLIENTS, SERVER_NAME } from "../client-config.ts";
import { openDatabase } from "../db.ts";
import { verifyLedger } from "../ledger.ts";
import { readWorkspaceProfile } from "../workspace.ts";

type Level = "OK" | "WARN" | "FAIL" | "INFO";
let failed = false;
const report = (level: Level, message: string) => {
  if (level === "FAIL") failed = true;
  console.log(`${level.padEnd(4)} ${message}`);
};

const flags = parseFlags(process.argv.slice(2), { values: ["project-dir"] });
const major = Number(process.versions.node.split(".")[0]);
report(major >= 24 ? "OK" : "FAIL", `Node.js ${process.versions.node}${major >= 24 ? "" : " (24 or newer is required)"}`);
for (const tool of ["git", "gh"] as const) {
  try { execFileSync(tool, ["--version"], { stdio: "ignore" }); report("OK", `${tool} is installed`); }
  catch { report(tool === "git" ? "WARN" : "INFO", `${tool} not found${tool === "gh" ? " (only needed to look up repositories and import public evidence)" : ""}`); }
}
const profile = await readWorkspaceProfile().catch((error: unknown) => { report("FAIL", error instanceof Error ? error.message : "Unreadable workspace profile"); return null; });
if (!profile) {
  report("FAIL", "No workspace. Run: npm run setup -- --repo owner/name --reviewer \"Teammate\"");
} else {
  report("OK", `Workspace for ${profile.repository.fullName} on branch ${profile.repository.branch} (database ${profile.dataDir})`);
  const binding = await readAgentBindingFile(profile.bindingFile).catch((error: unknown) => {
    report("FAIL", `Agent binding ${profile.bindingFile}: ${error instanceof Error ? error.message : "unreadable"}`);
    return null;
  });
  if (binding) {
    const left = Date.parse(binding.expiresAt) - Date.now();
    report(left > 2 * 3_600_000 ? "OK" : left > 0 ? "WARN" : "FAIL",
      `Agent binding ${left > 0 ? `expires in ${Math.round(left / 3_600_000)}h` : "expired"} (capabilities: ${bindingCapabilities(binding).join(", ")}); npm start renews it`);
  }
  let running = false;
  try {
    const home = await fetch(new URL("/", profile.appUrl), { redirect: "manual", signal: AbortSignal.timeout(2000) });
    running = home.status < 500;
    await home.body?.cancel();
  } catch { running = false; }
  if (!running) {
    report("WARN", `App not reachable at ${profile.appUrl}. Start it with npm start (agents need it running).`);
    const db = await openDatabase(profile.dataDir).catch(() => null);
    if (db) {
      try {
        const ledger = await verifyLedger(db);
        report(ledger.ok ? "OK" : "FAIL", `Audit ledger: ${ledger.chains.reduce((sum, chain) => sum + chain.entries, 0)} chained records ${ledger.ok ? "verified" : "FAILED verification; run npm run ledger:verify"}`);
        const access = await db.query<{ observed_at: Date }>(
          "SELECT observed_at FROM repository_access WHERE principal_id = $1 AND external_repository_id = $2 AND can_read",
          [profile.agentId, profile.repository.id]);
        const age = access.rows[0] ? Date.now() - access.rows[0].observed_at.getTime() : null;
        report(age === null ? "FAIL" : age < 25 * 86_400_000 ? "OK" : "WARN",
          age === null ? "The agent has no repository access declaration; it will receive nothing" : `Agent access declared ${Math.round(age / 86_400_000)} days ago (renewed by npm start; expires after 30)`);
      } finally { await db.close(); }
    } else report("INFO", "Database is in use by another process; skipped the ledger check");
  } else {
    report("OK", `App answering at ${profile.appUrl}`);
    if (binding) {
      const probe = await fetch(new URL(AGENT_CONTEXT_PATH, profile.appUrl), { method: "POST", body: "{}", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${binding.token}` } }).catch(() => null);
      const status = probe?.status;
      await probe?.body?.cancel();
      report(status === 400 ? "OK" : "FAIL", status === 400 ? "Agent credential accepted by the running app"
        : status === 404 ? "The running app has no agent binding; stop it and use npm start"
        : status === 403 ? "The running app rejected this binding; restart it with npm start"
        : "Agent endpoint did not answer as expected");
    }
    report("INFO", "Stop the app to include the audit ledger check, or open Audit integrity on the organization page");
  }
  // npm sets INIT_CWD to where it was invoked; MemoryNet's own checkout is not a coding project to check.
  const invokedFrom = process.env.INIT_CWD && resolve(process.env.INIT_CWD) !== resolve(fileURLToPath(new URL("../..", import.meta.url))) ? process.env.INIT_CWD : undefined;
  const projectDir = flags.value("project-dir") ?? invokedFrom;
  if (projectDir) {
    let found = 0;
    for (const client of MCP_CLIENTS) {
      const text = await readFile(join(resolve(projectDir), CLIENT_FILES[client]), "utf8").catch(() => null);
      if (text === null || !text.includes(SERVER_NAME)) continue;
      found++;
      report(text.includes(resolve(profile.bindingFile)) ? "OK" : "WARN",
        `${CLIENT_FILES[client]} configures ${SERVER_NAME}${text.includes(resolve(profile.bindingFile)) ? "" : " but points at a different binding; run npm run connect again"}`);
    }
    if (found === 0) report("INFO", `No MCP client configured in ${projectDir}. Run: npm run connect -- --client vscode --project-dir ${projectDir}`);
  }
}
process.exitCode = failed ? 1 : 0;
