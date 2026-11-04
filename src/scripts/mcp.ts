import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { bindingCapabilities, readAgentBindingFile } from "../agent-context/binding.ts";
import { createAgentBridge, createContextBridge } from "../mcp/bridge.ts";
import { createMemoryNetMcpServer, type MemoryNetTools } from "../mcp/server.ts";

try {
  const path = process.env.MEMORYNET_AGENT_BINDING_FILE;
  if (!path) throw new Error("Missing local binding file");
  const binding = await readAgentBindingFile(path);
  const appUrl = process.env.MEMORYNET_APP_URL ?? "http://127.0.0.1:3050";
  const bridge = createAgentBridge(appUrl, binding.token);
  const allowed = bindingCapabilities(binding);
  // The app enforces the binding on every request; this only avoids advertising tools that would be refused.
  const tools: MemoryNetTools = {
    ...(allowed.includes("context") ? { context: createContextBridge(appUrl, binding.token), taskContext: bridge.taskContext, revalidate: bridge.revalidate } : {}),
    ...(allowed.includes("propose") ? { propose: bridge.propose } : {}),
    ...(allowed.includes("report") ? { report: bridge.report } : {}),
  };
  serveStdio(() => createMemoryNetMcpServer(tools), { onerror: () => console.error("MemoryNet MCP transport failed") });
} catch {
  console.error("MemoryNet MCP could not start. Configure an owner-only local binding file and loopback app URL.");
  process.exitCode = 1;
}
