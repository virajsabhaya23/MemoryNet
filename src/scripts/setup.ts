// One-command local workspace: project, people, a coding agent and its MCP binding. Stop the app first.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../cli-args.ts";
import { CLIENT_LABELS, MCP_CLIENTS, mcpServerEntry, writeClientConfig, type McpClient } from "../client-config.ts";
import { detectRepository, lookupRepository, setupWorkspace } from "../setup.ts";

const USAGE = `Usage: npm run setup -- [--repo owner/name] [--reviewer "Name"]... [--client ${MCP_CLIENTS.join("|")}] [--project-dir path]
       [--name "Your name"] [--branch name] [--repo-id id] [--data-dir .data/workspace] [--binding-hours 24] [--allow-private]`;

try {
  const flags = parseFlags(process.argv.slice(2), {
    values: ["repo", "repo-id", "branch", "name", "data-dir", "client", "project-dir", "binding-hours", "agent-name", "organization"],
    lists: ["reviewer"], switches: ["allow-private", "help"],
  });
  if (flags.has("help")) { console.log(USAGE); process.exit(0); }
  const checkout = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
  const projectDir = realpathSync(flags.value("project-dir") ?? process.env.INIT_CWD ?? process.cwd());
  let fullName = flags.value("repo") ?? null;
  if (fullName === null) {
    if (projectDir === checkout) throw new Error("Name the repository to remember decisions for: --repo owner/name, or --project-dir <your checkout>.");
    fullName = detectRepository(projectDir);
    if (fullName === null) throw new Error(`No GitHub origin remote in ${projectDir}. Pass --repo owner/name.`);
  }
  const client = flags.value("client") as McpClient | undefined;
  if (client !== undefined && !MCP_CLIENTS.includes(client)) throw new Error(`--client must be one of: ${MCP_CLIENTS.join(", ")}`);
  if (client !== undefined && projectDir === checkout && flags.value("project-dir") === undefined) {
    throw new Error("Pass --project-dir <your checkout> so the client configuration is written into your repository, not MemoryNet's.");
  }
  const repoId = flags.value("repo-id");
  const repository = repoId
    ? { fullName, id: repoId, defaultBranch: flags.value("branch") ?? "main", private: false }
    : lookupRepository(fullName);
  if (repository.private && !flags.has("allow-private")) {
    throw new Error(`${repository.fullName} is private. MemoryNet keeps everything on this computer, but private work repositories are outside the supported trial boundary (see SECURITY.md). Re-run with --allow-private to accept that.`);
  }
  let operatorName = flags.value("name");
  if (!operatorName) {
    try { operatorName = execFileSync("git", ["config", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { operatorName = ""; }
  }
  const hours = flags.value("binding-hours");
  const result = await setupWorkspace({
    dataDir: flags.value("data-dir") ?? ".data/workspace",
    repository: { fullName: repository.fullName, id: repository.id, branch: flags.value("branch") ?? repository.defaultBranch },
    operatorName: operatorName || "Workspace owner",
    reviewerNames: flags.list("reviewer"),
    ...(flags.value("agent-name") ? { agentName: flags.value("agent-name")! } : {}),
    ...(flags.value("organization") ? { organizationName: flags.value("organization")! } : {}),
    bindingFile: ".local/memorynet/agent-binding.json",
    ...(hours ? { bindingTtlHours: Number(hours) } : {}),
  });
  const { profile } = result;
  console.log(`Workspace ready for ${profile.repository.fullName} (branch ${profile.repository.branch}).`);
  console.log(`  Database:  ${profile.dataDir}`);
  console.log(`  People:    ${operatorName || "Workspace owner"} (owner)${flags.list("reviewer").map((name) => `, ${name} (reviewer)`).join("")}`);
  console.log(`  Agent:     contributor; may read approved guidance, propose and report. It can never approve.`);
  console.log(`  Binding:   ${profile.bindingFile} (owner-only; renewed by npm start)`);
  if (client) {
    const path = await writeClientConfig(client, projectDir, mcpServerEntry({ bindingFile: profile.bindingFile, appUrl: profile.appUrl }));
    console.log(`  MCP:       ${CLIENT_LABELS[client]} configured in ${path} (local paths only, no credentials; keep it out of commits)`);
  }
  if (flags.list("reviewer").length === 0) {
    console.log(`\nNote: publishing a decision needs a second person. Add one now with --reviewer "Name" on a fresh setup, or later on the project page.`);
  }
  console.log(`\nNext:\n  npm start            # open http://127.0.0.1:3050 and choose who you are\n  ${client ? "" : "npm run connect -- --client vscode --project-dir <your checkout>\n  "}npm run doctor       # check the whole path from the app to your coding agent`);
  console.log("Identities here are local and unverified; repository access is your declaration, not a GitHub check. See SECURITY.md.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Setup failed");
  console.error(USAGE);
  process.exitCode = 1;
}
