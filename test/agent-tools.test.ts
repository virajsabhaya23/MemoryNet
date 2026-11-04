import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  parseAgentBinding,
  readAgentBindingFile,
  rotateAgentBindingFile,
  writeAgentBindingFile,
  type AgentBinding,
} from "../src/agent-context/binding.ts";
import {
  AGENT_CONTENT_FLAGS,
  AGENT_MEMORY_TYPES,
  AGENT_PROPOSALS_PATH,
  AGENT_RELATIONS,
  AGENT_REPORTS_PATH,
  AGENT_TASK_CONTEXT_PATH,
  AgentTaskContextSchema,
} from "../src/agent-context/contract.ts";
import { CONTENT_FLAGS } from "../src/content-checks.ts";
import { approveProposal, getProposal, listRetrievals, MEMORY_TYPES, proposeMemory, setProjectPolicy, ValidationError } from "../src/index.ts";
import { MEMORY_RELATIONS } from "../src/relations.ts";
import { createApp, type App } from "../src/web/app.ts";
import { buildWorld, START, useTestDatabase, type World } from "./helpers.ts";

const env = useTestDatabase();
const TOKEN = "c".repeat(64);

function binding(w: World, capabilities: Array<"context" | "propose" | "report"> = ["context", "propose", "report"]): AgentBinding {
  return parseAgentBinding({ schemaVersion: 2, token: TOKEN, principalId: w.people.agent.id, projectId: w.alpha.id, repositoryId: "1001",
    branch: "main", expiresAt: new Date(START.getTime() + 86_400_000).toISOString(), capabilities, ownerId: w.people.contributor.id });
}

function post(app: App, path: string, body: unknown, token = TOKEN) {
  return app({ method: "POST", path, query: new URLSearchParams(), body: JSON.stringify(body),
    headers: { host: "127.0.0.1:3050", authorization: ["Bear", "er "].join("") + token, "content-type": "application/json" } });
}

async function scopedDecision(w: World, title: string, content: string) {
  const p = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, type: "decision", title, content,
    evidenceSourceIds: [w.sources.alpha.id], applicability: { repositoryId: "1001", branch: "main", validFrom: START.toISOString() },
    relations: { paths: ["src/queue/**"], links: [] } });
  return approveProposal(env.ctx, w.people.reviewer.id, { proposalId: p.id, expectedRevision: 1 });
}

test("agent contract enums stay equal to the core definitions", () => {
  assert.deepEqual([...AGENT_MEMORY_TYPES], [...MEMORY_TYPES]);
  assert.deepEqual([...AGENT_RELATIONS], [...MEMORY_RELATIONS]);
  assert.deepEqual([...AGENT_CONTENT_FLAGS], [...CONTENT_FLAGS]);
});

test("task context over HTTP is scoped by the binding and records a receipt", async () => {
  const w = await buildWorld(env.ctx);
  const decision = await scopedDecision(w, "Queue consumers acknowledge after commit", "Synthetic: acknowledge messages after the database commit.");
  const app = createApp(env.ctx, { port: 3050, agentBinding: async () => binding(w, ["context"]) });
  const reply = await post(app, AGENT_TASK_CONTEXT_PATH, { task: "change the queue consumer", paths: ["src/queue/consumer.ts"] });
  assert.equal(reply.status, 200);
  const body = AgentTaskContextSchema.parse(JSON.parse(reply.body));
  assert.equal(body.items[0]?.memoryId, decision.id);
  assert.deepEqual(body.items[0]?.reasons.map((r) => r.kind).sort(), ["governs_path", "matched_task"]);
  assert.ok((await listRetrievals(env.ctx, w.people.adminA.id, { projectId: w.alpha.id })).some((r) => r.id === body.retrievalId));
  for (const [input, status] of [[{ task: "x", projectId: w.beta.id }, 400], [{ task: "x", branch: "release" }, 400], [{ task: "" }, 400], [{ task: "the" }, 400]] as const) {
    assert.equal((await post(app, AGENT_TASK_CONTEXT_PATH, input)).status, status, JSON.stringify(input));
  }
  assert.equal((await post(app, AGENT_PROPOSALS_PATH, { type: "lesson", title: "x", content: "y", evidence: { sourceIds: [w.sources.alpha.id] } })).status, 403,
    "a context-only binding cannot propose");
  assert.equal((await post(app, AGENT_TASK_CONTEXT_PATH, { task: "queue" }, "d".repeat(64))).status, 403);
});

test("agents propose for human review with pull request evidence; policy and quota refusals explain themselves", async () => {
  const w = await buildWorld(env.ctx);
  const app = createApp(env.ctx, { port: 3050, agentBinding: async () => binding(w) });
  const reply = await post(app, AGENT_PROPOSALS_PATH, {
    type: "constraint", title: "Queue consumers must be idempotent", content: "Synthetic: handlers tolerate redelivery.",
    evidence: { pullRequests: [{ number: 64, excerpt: "Synthetic PR: made the consumer idempotent after duplicate deliveries.", commit: "a".repeat(40) }] },
    paths: ["src/queue/**"],
  });
  assert.equal(reply.status, 201, reply.body);
  const receipt = JSON.parse(reply.body);
  assert.equal(receipt.status, "pending");
  const proposal = await getProposal(env.ctx, w.people.reviewer.id, receipt.proposalId);
  assert.equal(proposal.proposedBy, w.people.agent.id);
  assert.equal(proposal.ownerId, w.people.contributor.id, "the binding's accountable person owns it");
  assert.deepEqual(proposal.applicability && { repositoryId: proposal.applicability.repositoryId, branch: proposal.applicability.branch }, { repositoryId: "1001", branch: "main" });
  assert.deepEqual(proposal.relations.paths, ["src/queue/**"]);
  assert.equal(proposal.evidence[0]?.reference, "pull/64");
  assert.equal(proposal.evidence[0]?.url, "https://github.com/synthetic-org-a/alpha-service/pull/64");
  const before = await post(app, AGENT_TASK_CONTEXT_PATH, { task: "queue consumers idempotent" });
  assert.equal(JSON.parse(before.body).outcome, "no_results", "a pending proposal is never guidance");
  await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: receipt.proposalId, expectedRevision: 1 });
  assert.equal(JSON.parse((await post(app, AGENT_TASK_CONTEXT_PATH, { task: "queue consumers idempotent" })).body).outcome, "results");

  await setProjectPolicy(env.ctx, w.people.adminA.id, { projectId: w.alpha.id, expectedRevision: 0, requiredApprovals: 1, agentProposals: false, agentPendingLimit: 25, reason: "Pause agent proposals" });
  const refused = await post(app, AGENT_PROPOSALS_PATH, { type: "lesson", title: "Another", content: "Synthetic.", evidence: { sourceIds: [w.sources.alpha.id] } });
  assert.equal(refused.status, 400);
  assert.match(JSON.parse(refused.body).message, /does not accept proposals from agents/);
  assert.equal((await post(app, AGENT_PROPOSALS_PATH, { type: "lesson", title: "No evidence", content: "Synthetic.", evidence: {} })).status, 400);
  assert.equal((await post(app, AGENT_PROPOSALS_PATH, { type: "lesson", title: "Bad", content: "Synthetic.", evidence: { sourceIds: [w.sources.beta.id] } })).status, 400);
});

test("agent change proposals keep omitted paths or links from the current decision", async () => {
  const w = await buildWorld(env.ctx);
  const target = await scopedDecision(w, "Queue storage is append only", "Synthetic: queue storage only appends.");
  const linked = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, type: "decision",
    title: "Consumers write to queue storage", content: "Synthetic: consumers append to queue storage.",
    evidenceSourceIds: [w.sources.alpha.id], applicability: { repositoryId: "1001", branch: "main", validFrom: START.toISOString() },
    relations: { paths: ["src/queue/**"], links: [{ relation: "depends_on", memoryId: target.id }] } });
  const decision = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: linked.id, expectedRevision: 1 });
  const app = createApp(env.ctx, { port: 3050, agentBinding: async () => binding(w) });

  const pathsOnly = await post(app, AGENT_PROPOSALS_PATH, { type: "decision", title: "Consumers write to queue storage",
    content: "Synthetic: consumers append via the storage adapter.", evidence: { sourceIds: [w.sources.alpha.id] },
    paths: ["src/storage/**"], change: { memoryId: decision.id, revision: decision.revision, kind: "revise" } });
  assert.equal(pathsOnly.status, 201, pathsOnly.body);
  const pathsProposal = await getProposal(env.ctx, w.people.reviewer.id, JSON.parse(pathsOnly.body).proposalId);
  assert.deepEqual(pathsProposal.relations.paths, ["src/storage/**"], "given paths replace");
  assert.deepEqual(pathsProposal.relations.links, [{ relation: "depends_on", memoryId: target.id }], "omitted links are kept, not dropped");

  const linksOnly = await post(app, AGENT_PROPOSALS_PATH, { type: "decision", title: "Consumers write to queue storage",
    content: "Synthetic: consumers append to queue storage in arrival order.", evidence: { sourceIds: [w.sources.alpha.id] },
    links: [{ relation: "related", memoryId: target.id }], change: { memoryId: decision.id, revision: decision.revision, kind: "revise" } });
  assert.equal(linksOnly.status, 201, linksOnly.body);
  const linksProposal = await getProposal(env.ctx, w.people.reviewer.id, JSON.parse(linksOnly.body).proposalId);
  assert.deepEqual(linksProposal.relations.paths, ["src/queue/**"], "omitted paths are kept, not dropped");
  assert.deepEqual(linksProposal.relations.links, [{ relation: "related", memoryId: target.id }], "given links replace");
});

test("agents report scoped guidance as outdated; out-of-scope memories read as missing", async () => {
  const w = await buildWorld(env.ctx);
  const decision = await scopedDecision(w, "Queue retries back off exponentially", "Synthetic backoff.");
  const app = createApp(env.ctx, { port: 3050, agentBinding: async () => binding(w, ["context", "report"]) });
  const reply = await post(app, AGENT_REPORTS_PATH, { memoryId: decision.id, reason: "The consumer now uses fixed delays." });
  assert.equal(reply.status, 201);
  assert.equal(JSON.parse(reply.body).status, "open");
  assert.equal((await post(app, AGENT_REPORTS_PATH, { memoryId: w.memories.alphaApproved.id, reason: "unscoped" })).status, 404);
  assert.equal((await post(app, AGENT_REPORTS_PATH, { memoryId: w.memories.betaApproved.id, reason: "other project" })).status, 404);
});

test("v2 bindings declare capabilities and an accountable owner; rotation keeps the same scope", async () => {
  const w = await buildWorld(env.ctx);
  const folder = await mkdtemp(join(tmpdir(), "memorynet-binding-v2-"));
  const file = join(folder, "binding.json");
  try {
    const input = { principalId: w.people.agent.id, projectId: w.alpha.id, repositoryId: "1001", branch: "main" };
    await assert.rejects(writeAgentBindingFile(file, { ...input, capabilities: ["context", "propose"] }, START), ValidationError);
    await assert.rejects(writeAgentBindingFile(file, { ...input, ttlHours: 169 }, START), ValidationError);
    await writeAgentBindingFile(file, { ...input, capabilities: ["context", "propose", "report"], ownerId: w.people.contributor.id, ttlHours: 72 }, START);
    const first = await readAgentBindingFile(file);
    assert.equal(first.schemaVersion, 2);
    assert.equal(Date.parse(first.expiresAt) - START.getTime(), 72 * 3_600_000);
    await rotateAgentBindingFile(file, { ...input, capabilities: ["context", "propose", "report"], ownerId: w.people.contributor.id }, START);
    const second = await readAgentBindingFile(file);
    assert.notEqual(second.token, first.token);
    await assert.rejects(rotateAgentBindingFile(file, { ...input, branch: "release" }, START), /different agent or scope/);
    assert.equal((await readFile(file, "utf8")).includes(second.token), true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a fresh MCP SDK client gets only the tools its binding allows and can propose and read through stdio", { timeout: 60_000 }, async () => {
  const w = await buildWorld(env.ctx);
  await scopedDecision(w, "Queue consumers acknowledge after commit", "Synthetic: acknowledge after commit.");
  const folder = await mkdtemp(join(tmpdir(), "memorynet-mcp-tools-"));
  const file = join(folder, "binding.json");
  let app: App | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const url = new URL(request.url ?? "/", "http://localhost");
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(request.headers)) headers[key] = Array.isArray(value) ? value.join(", ") : value;
    const result = await app!({ method: request.method ?? "GET", path: url.pathname, query: url.searchParams, headers, body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(result.status, result.headers).end(result.body);
  });
  const client = new Client({ name: "memorynet-tools-test", version: "1.0.0" });
  try {
    await writeAgentBindingFile(file, { principalId: w.people.agent.id, projectId: w.alpha.id, repositoryId: "1001", branch: "main",
      capabilities: ["context", "propose", "report"], ownerId: w.people.contributor.id }, env.ctx.now());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    app = createApp(env.ctx, { port: address.port, agentBinding: () => readAgentBindingFile(file) });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/scripts/mcp.ts", import.meta.url))],
      env: { MEMORYNET_AGENT_BINDING_FILE: file, MEMORYNET_APP_URL: `http://127.0.0.1:${address.port}` }, stderr: "pipe" }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["get_context", "get_task_context", "propose_memory", "report_outdated", "revalidate_context"]);
    assert.match(client.getInstructions() ?? "", /get_task_context/);
    const context = await client.callTool({ name: "get_task_context", arguments: { task: "queue consumer acknowledgement", paths: ["src/queue/a.ts"] } });
    assert.notEqual(context.isError, true);
    assert.equal(AgentTaskContextSchema.parse(context.structuredContent).outcome, "results");
    const proposed = await client.callTool({ name: "propose_memory", arguments: { type: "lesson", title: "Duplicate deliveries happen in staging",
      content: "Synthetic lesson from the agent.", evidence: { sourceIds: [w.sources.alpha.id] } } });
    assert.notEqual(proposed.isError, true);
    await setProjectPolicy(env.ctx, w.people.adminA.id, { projectId: w.alpha.id, expectedRevision: 0, requiredApprovals: 1, agentProposals: true, agentPendingLimit: 1, reason: "One at a time" });
    const limited = await client.callTool({ name: "propose_memory", arguments: { type: "lesson", title: "Second lesson", content: "Synthetic.", evidence: { sourceIds: [w.sources.alpha.id] } } });
    assert.equal(limited.isError, true);
    assert.match(JSON.stringify(limited.content), /refused the request \(conflict\).*limit is 1/);
    assert.equal(JSON.stringify(limited.content).includes(TOKEN), false);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  }
});

test("a refused agent proposal leaves no evidence records behind", async () => {
  const w = await buildWorld(env.ctx);
  const app = createApp(env.ctx, { port: 3050, agentBinding: async () => binding(w) });
  const sources = async () => (await env.db.query<{ count: number }>("SELECT count(*)::int AS count FROM sources")).rows[0]!.count;
  const before = await sources();
  const withPull = (extra: Record<string, unknown> = {}) => ({ type: "lesson", title: "Retry storms come from shared clocks", content: "Synthetic lesson.",
    evidence: { pullRequests: [{ number: 501, excerpt: "Synthetic PR text about retry storms." }] }, ...extra });
  const invalidLink = await post(app, AGENT_PROPOSALS_PATH, withPull({ links: [{ relation: "depends_on", memoryId: w.memories.betaApproved.id }] }));
  assert.equal(invalidLink.status, 400);
  assert.equal(await sources(), before, "a refused proposal rolls back its pull request evidence");
  await setProjectPolicy(env.ctx, w.people.adminA.id, { projectId: w.alpha.id, expectedRevision: 0, requiredApprovals: 1, agentProposals: false, agentPendingLimit: 25, reason: "Pause agents" });
  for (let i = 0; i < 3; i++) assert.equal((await post(app, AGENT_PROPOSALS_PATH, withPull())).status, 400);
  assert.equal(await sources(), before, "policy refusals record nothing");
});
