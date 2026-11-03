import { AgentContextSchema, AGENT_CONTEXT_PATH, AgentQuerySchema, type AgentQuery, type AgentContextResponse } from "../agent-context/contract.ts";
import { UnavailableError, ValidationError } from "../errors.ts";

/** Loopback only, fixed path, no redirects; stdio process never opens the web process's PGlite file. */
export function createContextBridge(baseUrl: string, token: string): (input: AgentQuery) => Promise<AgentContextResponse> {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.port || !/^[a-f0-9]{64}$/.test(token)) throw new ValidationError("MCP bridge requires a loopback app URL and local credential");
  const endpoint = new URL(AGENT_CONTEXT_PATH, url);
  return async (input) => {
    const parsed = AgentQuerySchema.safeParse(input);
    if (!parsed.success) throw new ValidationError("Invalid context query");
    try {
      const result = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(parsed.data), redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!result.ok || !result.headers.get("content-type")?.startsWith("application/json")) { await result.body?.cancel(); throw new Error("Context request failed"); }
      const reader = result.body?.getReader();
      if (!reader) throw new Error("Missing response");
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength; if (length > 256_000) throw new Error("Context response too large"); chunks.push(part.value); }
      } finally { await reader.cancel().catch(() => undefined); }
      return AgentContextSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch { throw new UnavailableError("MemoryNet context request failed; no guidance was delivered"); }
  };
}
