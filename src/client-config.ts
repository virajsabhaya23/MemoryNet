import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError } from "./errors.ts";

/** Coding clients whose project-level MCP configuration MemoryNet can write. */
export const MCP_CLIENTS = ["vscode", "claude", "cursor", "codex"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export const CLIENT_LABELS: Readonly<Record<McpClient, string>> = {
  vscode: "VS Code",
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "OpenAI Codex (trusted projects)",
};

/** Relative to the coding project. Formats per each client's documentation, verified November 3, 2026. */
export const CLIENT_FILES: Readonly<Record<McpClient, string>> = {
  vscode: ".vscode/mcp.json",
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
  codex: ".codex/config.toml",
};

export const SERVER_NAME = "memorynet";

export interface McpServerEntry {
  command: string;
  args: string[];
  env: { MEMORYNET_AGENT_BINDING_FILE: string; MEMORYNET_APP_URL: string };
}

/**
 * A `node` on PATH that is this same binary, such as /opt/homebrew/bin/node, so the configuration survives
 * upgrades that move the versioned executable. Falls back to the exact executable.
 */
export function stableNodePath(): string {
  let current: string;
  try { current = realpathSync(process.execPath); } catch { return process.execPath; }
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, process.platform === "win32" ? "node.exe" : "node");
    try { if (realpathSync(candidate) === current) return candidate; } catch { /* not on this PATH entry */ }
  }
  return process.execPath;
}

/** The stdio server launch. It holds paths only; the credential stays in the owner-only binding file. */
export function mcpServerEntry(input: { bindingFile: string; appUrl: string; node?: string }): McpServerEntry {
  return {
    command: input.node ?? stableNodePath(),
    args: [fileURLToPath(new URL("./scripts/mcp.ts", import.meta.url))],
    env: { MEMORYNET_AGENT_BINDING_FILE: resolve(input.bindingFile), MEMORYNET_APP_URL: input.appUrl },
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** A single process-scoped Codex -c value for clients that do not load the project's TOML layer. */
export function codexSessionOption(entry: McpServerEntry): string {
  const args = entry.args.map(tomlString).join(", ");
  const env = Object.entries(entry.env).map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ");
  return `mcp_servers.memorynet={ command = ${tomlString(entry.command)}, args = [${args}], env = { ${env} } }`;
}

/** What would be written for one client, as file text, given the file's current text (or null). */
export function renderClientConfig(client: McpClient, entry: McpServerEntry, current: string | null): string {
  if (client === "codex") {
    if (current !== null && /^\s*\[mcp_servers\.memorynet(?:\.|\])/m.test(current)) {
      throw new ValidationError(`${CLIENT_FILES.codex} already configures ${SERVER_NAME}; edit that table by hand`);
    }
    const table = [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${tomlString(entry.command)}`,
      `args = [${entry.args.map(tomlString).join(", ")}]`,
      "",
      `[mcp_servers.${SERVER_NAME}.env]`,
      `MEMORYNET_AGENT_BINDING_FILE = ${tomlString(entry.env.MEMORYNET_AGENT_BINDING_FILE)}`,
      `MEMORYNET_APP_URL = ${tomlString(entry.env.MEMORYNET_APP_URL)}`,
      "",
    ].join("\n");
    if (current === null || current.trim() === "") return table;
    return `${current.replace(/\s*$/, "")}\n\n${table}`;
  }
  let config: Record<string, unknown> = {};
  if (current !== null && current.trim() !== "") {
    try {
      const parsed = JSON.parse(current) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      config = parsed as Record<string, unknown>;
    } catch {
      throw new ValidationError(`${CLIENT_FILES[client]} is not plain JSON (it may contain comments); add the printed entry by hand`);
    }
  }
  const key = client === "vscode" ? "servers" : "mcpServers";
  const existing = config[key];
  if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
    throw new ValidationError(`${CLIENT_FILES[client]} has an unexpected "${key}" value; add the printed entry by hand`);
  }
  const server = client === "vscode" ? { type: "stdio", ...entry } : entry;
  return `${JSON.stringify({ ...config, [key]: { ...(existing as Record<string, unknown> | undefined), [SERVER_NAME]: server } }, null, 2)}\n`;
}

/** Adds or updates only the memorynet entry in the client's project file, leaving every other server as it was. */
export async function writeClientConfig(client: McpClient, projectDir: string, entry: McpServerEntry): Promise<string> {
  const path = join(resolve(projectDir), CLIENT_FILES[client]);
  let current: string | null = null;
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = renderClientConfig(client, entry, current);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
  return path;
}
