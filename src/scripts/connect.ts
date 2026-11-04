// Adds MemoryNet to a coding client's project MCP configuration, or prints the entry.
import { realpathSync } from "node:fs";
import { parseFlags } from "../cli-args.ts";
import { CLIENT_FILES, CLIENT_LABELS, MCP_CLIENTS, mcpServerEntry, renderClientConfig, writeClientConfig, type McpClient } from "../client-config.ts";
import { readWorkspaceProfile } from "../workspace.ts";

const USAGE = `Usage: npm run connect -- --client ${MCP_CLIENTS.join("|")} [--project-dir <your checkout>] [--print]`;
try {
  const flags = parseFlags(process.argv.slice(2), { values: ["client", "project-dir"], switches: ["print"] });
  const client = flags.value("client") as McpClient | undefined;
  if (client === undefined || !MCP_CLIENTS.includes(client)) throw new Error(`Choose --client: ${MCP_CLIENTS.join(", ")}`);
  const profile = await readWorkspaceProfile();
  if (!profile) throw new Error("No workspace yet. Run npm run setup first.");
  const entry = mcpServerEntry({ bindingFile: profile.bindingFile, appUrl: profile.appUrl });
  if (flags.has("print")) {
    console.log(`# ${CLIENT_LABELS[client]}: add to ${CLIENT_FILES[client]} in your project\n${renderClientConfig(client, entry, null)}`);
  } else {
    const projectDir = realpathSync(flags.value("project-dir") ?? process.env.INIT_CWD ?? process.cwd());
    const path = await writeClientConfig(client, projectDir, entry);
    console.log(`Configured ${CLIENT_LABELS[client]} in ${path}.`);
    console.log("It holds local paths only; the credential stays in the owner-only binding file. Keep this file out of commits.");
    console.log("Keep npm start running, then reload the client and ask it to call get_task_context before editing.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not configure the client");
  console.error(USAGE);
  process.exitCode = 1;
}
