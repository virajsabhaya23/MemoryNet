import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readAgentBindingFile, writeAgentBindingFile } from "../agent-context/binding.ts";
import { AgentContextSchema, type AgentContextResponse } from "../agent-context/contract.ts";
import { approveProposal, listRetrievals, proposeChange, recordRepositoryAccess, revokeMemory } from "../index.ts";
import { createApp, type App } from "../web/app.ts";
import { createSyntheticEvaluationFixture } from "./fixture.ts";

/** A real SDK stdio client + loopback HTTP + canonical app + isolated PGlite; no model calls. */
export async function runScopedContextSmoke() {
  const fixture = await createSyntheticEvaluationFixture();
  const folder = await mkdtemp(join(tmpdir(), "memorynet-mcp-smoke-"));
  const path = join(folder, "binding.json");
  let app: App;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 8192) { response.writeHead(413).end(); return; } chunks.push(chunk); }
      const url = new URL(request.url ?? "/", "http://localhost");
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) headers[key] = Array.isArray(value) ? value.join(", ") : value;
      const result = await app({ method: request.method ?? "GET", path: url.pathname, query: url.searchParams, headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(result.status, result.headers).end(result.body);
    } catch { response.writeHead(503).end(); }
  });
  const clients: Client[] = [];
  const events: Array<{ event: string; response: AgentContextResponse; sha256: string; latencyMs: number }> = [];
  try {
    await writeAgentBindingFile(path, { principalId: fixture.agent.id, projectId: fixture.project.id, repositoryId: fixture.repositoryId, branch: "main" }, fixture.ctx.now());
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No loopback port");
    const port = address.port;
    app = createApp(fixture.ctx, { port, agentBinding: () => readAgentBindingFile(path) });
    async function freshClient() {
      const client = new Client({ name: "memorynet-engineering-smoke", version: "1.0.0" });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL("../scripts/mcp.ts", import.meta.url))],
        env: { MEMORYNET_AGENT_BINDING_FILE: path, MEMORYNET_APP_URL: `http://127.0.0.1:${port}` },
        stderr: "pipe", maxBufferSize: 512_000,
      }));
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), ["get_context", "get_task_context"]);
      return client;
    }
    async function retrieve(client: Client, event: string) {
      const started = performance.now();
      const result = await client.callTool({ name: "get_context", arguments: { query: "transport", limit: 1 } });
      const latencyMs = performance.now() - started;
      assert.notEqual(result.isError, true);
      const response = AgentContextSchema.parse(result.structuredContent);
      events.push({ event, response, sha256: createHash("sha256").update(JSON.stringify(response)).digest("hex"), latencyMs });
      return response;
    }
    const client = await freshClient();
    for (const [label, scope] of [["Unscoped transport transport", null], ["Wrong branch transport transport", { ...fixture.applicability, branch: "release" }]] as const) {
      const excluded = await fixture.propose(label, "Synthetic excluded transport guidance.", scope);
      await approveProposal(fixture.ctx, fixture.reviewer.id, { proposalId: excluded.id, expectedRevision: excluded.revision });
    }
    const pending = await fixture.propose("Transport initial decision", "Use the synthetic legacy transport.");
    assert.equal((await retrieve(client, "pending_withheld")).outcome, "no_results");
    const original = await approveProposal(fixture.ctx, fixture.reviewer.id, { proposalId: pending.id, expectedRevision: pending.revision });
    assert.equal((await retrieve(client, "approved_delivered")).current[0]?.memoryId, original.id);
    const replacement = await proposeChange(fixture.ctx, fixture.owner.id, { memoryId: original.id, expectedRevision: original.revision, kind: "replace", type: "decision",
      title: "Transport replacement decision", content: "Use the synthetic current transport.", evidenceSourceIds: [fixture.source.id] });
    assert.equal((await retrieve(client, "pending_replacement_keeps_authority")).current[0]?.memoryId, original.id);
    const current = await approveProposal(fixture.ctx, fixture.reviewer.id, { proposalId: replacement.id, expectedRevision: replacement.revision });
    assert.equal((await retrieve(await freshClient(), "fresh_client_sees_replacement")).current[0]?.memoryId, current.id);
    await revokeMemory(fixture.ctx, fixture.reviewer.id, { memoryId: current.id, expectedRevision: current.revision, reason: "Synthetic revoked authority scenario" });
    const revoked = await retrieve(client, "revoked_withheld");
    assert.equal(revoked.outcome, "no_results");
    assert.equal(JSON.stringify(revoked).includes("legacy transport"), false);
    assert.equal(JSON.stringify(revoked).includes("replacement decision"), false);
    const spoof = await client.callTool({ name: "get_context", arguments: { query: "transport", principalId: fixture.owner.id, branch: "release" } });
    assert.equal(spoof.isError, true);
    fixture.advance(1);
    await recordRepositoryAccess(fixture.ctx, { principalId: fixture.agent.id, provider: "github", externalRepositoryId: fixture.repositoryId, canRead: false });
    const denied = await client.callTool({ name: "get_context", arguments: { query: "transport" } });
    assert.equal(denied.isError, true);
    const receipts = await listRetrievals(fixture.ctx, fixture.owner.id, { projectId: fixture.project.id });
    assert.equal(events.every((event) => receipts.some((receipt) => receipt.id === event.response.retrievalId)), true);
    return { schemaVersion: 1 as const, fixture: "scoped-context-smoke-v1", evidenceKind: "synthetic_engineering_integration" as const,
      metaCalls: 0, freshProtocolClients: clients.length, nodeVersion: process.version, sdkVersion: "2.4.0",
      invariantChecksPassed: true, spoofRejected: true, permissionLossRejected: true,
      events, receiptCount: receipts.length };
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
    await rm(folder, { recursive: true, force: true });
  }
}
