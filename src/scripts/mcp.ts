import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { readAgentBindingFile } from "../agent-context/binding.ts";
import { createContextBridge } from "../mcp/bridge.ts";
import { createMemoryNetMcpServer } from "../mcp/server.ts";

try {
  const path = process.env.MEMORYNET_AGENT_BINDING_FILE;
  if (!path) throw new Error("Missing local binding file");
  const binding = await readAgentBindingFile(path);
  const read = createContextBridge(process.env.MEMORYNET_APP_URL ?? "http://127.0.0.1:3050", binding.token);
  serveStdio(() => createMemoryNetMcpServer(read), { onerror: () => console.error("MemoryNet MCP transport failed") });
} catch {
  console.error("MemoryNet MCP could not start. Configure an owner-only local binding file and loopback app URL.");
  process.exitCode = 1;
}
