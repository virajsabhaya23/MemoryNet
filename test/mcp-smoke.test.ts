import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { AgentTaskContextResponse, ReceiptCheck } from "../src/agent-context/contract.ts";
import { runScopedContextSmoke } from "../src/evaluation/scoped-smoke.ts";
import { createMemoryNetMcpServer } from "../src/mcp/server.ts";

test("fresh official SDK stdio clients traverse authenticated app, scoped approval/replacement/revocation and receipts", { timeout: 30_000 }, async () => {
  const result = await runScopedContextSmoke();
  assert.equal(result.metaCalls, 0);
  assert.equal(result.freshProtocolClients, 2);
  assert.deepEqual(result.events.map((event) => event.response.outcome), ["no_results", "results", "results", "results", "no_results"]);
  assert.equal(result.invariantChecksPassed, true);
});

test("the MCP server advertises task context v3 and receipt check v2, and never forwards an older or inconsistent response", async () => {
  const at = new Date("2026-11-05T12:00:00.000Z").toISOString();
  const memoryId = randomUUID();
  const definition = {
    definitionId: randomUUID(), revision: 2, kind: "rule" as const, name: "No secrets in chat", purpose: "Synthetic purpose.",
    responsibilities: ["Synthetic requirement"], instructions: "Synthetic rule text.", shortened: false, boundaries: [], appliesTo: null,
    scope: { level: "organization" as const, id: randomUUID() }, approvedBy: randomUUID(), approvedAt: at, compact: false,
    reasons: [{ kind: "applies_to_scope" as const }], basedOn: [{ memoryId, change: "superseded" as const, replacedBy: null }], reviewNeeded: true,
  };
  const current: AgentTaskContextResponse = {
    schemaVersion: 3, scope: { projectId: randomUUID(), repositoryId: "1001", branch: "main" }, retrievalId: randomUUID(), retrievedAt: at,
    outcome: "no_results", items: [], conflicts: [], moreConflicts: 0, changedDependencies: [], moreChangedDependencies: 0, omitted: 0,
    budget: { maxTokens: 2000, usedTokens: 160 }, definitions: [definition], moreDefinitions: 0,
  };
  let next: unknown = current;
  const check: ReceiptCheck = { status: "STALE", items: [], definitions: [{ definitionId: definition.definitionId, pinnedRevision: 1, observedRevision: 2, reasons: ["revision_changed"] }] };
  const server = createMemoryNetMcpServer({
    taskContext: async () => next as AgentTaskContextResponse,
    revalidate: async () => check,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "memorynet-contract-check", version: "1.0.0" });
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    assert.match(client.getInstructions() ?? "", /reviewed organizational guidance.*unless reviewNeeded is true/);
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    const taskSchema = tools.get("get_task_context")?.outputSchema as { properties: Record<string, { const?: unknown }> } | undefined;
    assert.equal(taskSchema?.properties.schemaVersion?.const, 3);
    assert.ok(taskSchema?.properties.definitions && taskSchema.properties.moreDefinitions);
    assert.ok((tools.get("revalidate_context")?.outputSchema as { properties: Record<string, unknown> } | undefined)?.properties.definitions);

    const delivered = await client.callTool({ name: "get_task_context", arguments: { task: "rotate session keys" } });
    assert.notEqual(delivered.isError, true);
    assert.deepEqual(delivered.structuredContent, current);
    const rechecked = await client.callTool({ name: "revalidate_context", arguments: { retrievalId: current.retrievalId } });
    assert.deepEqual(rechecked.structuredContent, check);

    const { definitions: _definitions, moreDefinitions: _more, ...withoutDefinitions } = current;
    for (const refused of [{ ...withoutDefinitions, schemaVersion: 2 }, { ...current, definitions: [{ ...definition, reviewNeeded: false }] }]) {
      next = refused;
      const result = await client.callTool({ name: "get_task_context", arguments: { task: "rotate session keys" } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
