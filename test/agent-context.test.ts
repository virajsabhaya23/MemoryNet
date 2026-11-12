import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { parseAgentBinding, readAgentBindingFile, writeAgentBindingFile, type AgentBinding } from "../src/agent-context/binding.ts";
import { AGENT_CONTRACT_SCHEMAS, AgentContextSchema, AgentQuerySchema, AGENT_CONTEXT_PATH } from "../src/agent-context/contract.ts";
import { getAgentContext, getAgentTaskContext, revalidateAgentReceipt } from "../src/agent-context/service.ts";
import {
  approveDefinitionProposal, approveProposal, createContext, ForbiddenError, proposeChange, proposeDefinition, proposeDefinitionChange,
  proposeDefinitionRetirement, proposeMemory, ValidationError,
} from "../src/index.ts";
import { createContextBridge } from "../src/mcp/bridge.ts";
import { createApp } from "../src/web/app.ts";
import { buildWorld, START, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();
type World = Awaited<ReturnType<typeof buildWorld>>;
function binding(w: World): AgentBinding {
  return parseAgentBinding({ schemaVersion: 1, token: "a".repeat(64), principalId: w.people.agent.id,
    projectId: w.alpha.id, repositoryId: "1001", branch: "main", expiresAt: new Date(START.getTime() + 86_400_000).toISOString() });
}
function request(token: string, body = '{"query":"controlled"}') {
  return { method: "POST", path: AGENT_CONTEXT_PATH, query: new URLSearchParams(), body,
    headers: { host: "127.0.0.1:3050", authorization: `Bearer ${token}`, "content-type": "application/json" } as Record<string, string> };
}

test("context endpoint uses only bound bearer authority and refuses browser, scope spoof and malformed input before retrieval", async () => {
  const w = await buildWorld(env.ctx); const b = binding(w);
  const app = createApp(env.ctx, { port: 3050, agentBinding: async () => b });
  const r = request(b.token);
  for (const [mutated, status] of [
    [{ ...r, headers: { ...r.headers, authorization: "" } }, 403],
    [{ ...r, headers: { ...r.headers, authorization: `Bearer ${"b".repeat(64)}` } }, 403],
    [{ ...r, headers: { ...r.headers, host: "example.com:3050" } }, 421],
    [{ ...r, headers: { ...r.headers, origin: "http://127.0.0.1:3050" } }, 403],
    [{ ...r, headers: { ...r.headers, "sec-fetch-site": "same-origin" } }, 403],
    [{ ...r, headers: { ...r.headers, "content-type": "application/x-www-form-urlencoded" } }, 400],
    [{ ...r, query: new URLSearchParams("principalId=x") }, 400],
    [{ ...r, body: "{" }, 400],
    [{ ...r, body: JSON.stringify({ query: "controlled", principalId: w.people.ownerA.id }) }, 400],
    [{ ...r, body: JSON.stringify({ query: "controlled", repositoryId: "1002", branch: "release", at: START.toISOString() }) }, 400],
    [{ ...r, body: JSON.stringify({ query: b.token }) }, 400],
    [{ ...r, body: JSON.stringify({ query: "controlled", limit: 21 }) }, 400],
    [{ ...r, body: " ".repeat(8193) }, 400],
    [{ ...r, method: "GET" }, 405],
  ] as const) assert.equal((await app(mutated)).status, status);
  assert.equal((await env.db.query<{ count: number }>("SELECT count(*)::int count FROM retrievals")).rows[0]?.count, 0);
  const success = await app(r);
  assert.equal(success.status, 200);
  const response = AgentContextSchema.parse(JSON.parse(success.body));
  assert.equal(response.outcome, "no_results"); // baseline fixtures are deliberately legacy unscoped
  assert.deepEqual(response.scope, { projectId: w.alpha.id, repositoryId: "1001", branch: "main" });
  assert.equal(success.body.includes(b.token), false);
  assert.equal(success.headers["Cache-Control"], "no-store");
});

test("expired or human bindings and deleted binding file cannot acquire agent context", async () => {
  const w = await buildWorld(env.ctx); const b = binding(w);
  await assert.rejects(getAgentContext(env.ctx, { ...b, expiresAt: START.toISOString() }, { query: "controlled" }), ForbiddenError);
  await assert.rejects(getAgentContext(env.ctx, { ...b, principalId: w.people.ownerA.id }, { query: "controlled" }), ForbiddenError);
  const app = createApp(env.ctx, { port: 3050, agentBinding: async () => { throw new Error("private file detail must not escape"); } });
  const result = await app(request(b.token));
  assert.equal(result.status, 403);
  assert.equal(result.body.includes("private file"), false);
  const disabled = createApp(env.ctx, { port: 3050 });
  assert.equal((await disabled(request(b.token))).status, 404);
});

test("context database outage is unavailable and cannot become a successful empty result", async () => {
  const w = await buildWorld(env.ctx); const b = binding(w);
  const broken = createContext({ async query() { throw new Error("sensitive underlying database details"); },
    async exec() { throw new Error("database offline"); }, async transaction() { throw new Error("database offline"); },
    close: async () => {} }, { now: () => START });
  const result = await createApp(broken, { port: 3050, agentBinding: async () => b })(request(b.token));
  assert.equal(result.status, 503);
  assert.deepEqual(JSON.parse(result.body), { error: "unavailable" });
  assert.equal(result.body.includes("sensitive"), false);
});

test("local binding generator uses exclusive owner-only files, short expiry and no implicit database grants", async () => {
  const w = await buildWorld(env.ctx); const folder = await mkdtemp(join(tmpdir(), "memorynet-binding-test-"));
  const file = join(folder, "binding.json");
  try {
    const input = { principalId: w.people.agent.id, projectId: w.alpha.id, repositoryId: "1001", branch: "main" };
    await writeAgentBindingFile(file, input, START);
    const b = await readAgentBindingFile(file);
    assert.equal(Date.parse(b.expiresAt) - START.getTime(), 86_400_000);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    const original = await readFile(file, "utf8");
    await assert.rejects(writeAgentBindingFile(file, input, START));
    assert.equal(await readFile(file, "utf8"), original);
    // Windows has no POSIX mode bits; bindings there rely on the user profile's owner-only ACLs.
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      await assert.rejects(readAgentBindingFile(file), ValidationError);
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("bridge refuses non-loopback and ambiguous destinations without making requests", () => {
  for (const url of ["https://127.0.0.1:3050", "http://example.com:3050", "http://user:password@localhost:3050", "http://localhost:3050/other", "http://localhost:3050?override=x", "http://localhost", "http://localhost:3050/#fragment"]) {
    assert.throws(() => createContextBridge(url, "a".repeat(64)), ValidationError);
  }
});

test("checked-in JSON schemas match the executable contracts", async () => {
  for (const [name, schema] of AGENT_CONTRACT_SCHEMAS) {
    assert.deepEqual(JSON.parse(await readFile(new URL(`../docs/contracts/${name}.schema.json`, import.meta.url), "utf8")), z.toJSONSchema(schema), name);
  }
});

test("revalidation hides foreign receipts, refuses expired authority and keeps empty or legacy receipts unknown", async () => {
  const w = await buildWorld(env.ctx), b = binding(w);
  const { revalidateAgentReceipt } = await import("../src/agent-context/service.ts");
  const received = await getAgentContext(env.ctx, b, { query: "controlled" });
  const query = { retrievalId: received.retrievalId };
  assert.deepEqual(await revalidateAgentReceipt(env.ctx, b, query), { status: "UNKNOWN", items: [], definitions: [] });
  const denied = await revalidateAgentReceipt(env.ctx, { ...b, branch: "unrelated" }, query).catch(e => e);
  assert.ok(denied instanceof ForbiddenError);
  await assert.rejects(revalidateAgentReceipt(env.ctx, { ...b, expiresAt: START.toISOString() }, query), ForbiddenError);
  const { approveProposal, proposeMemory, suspendMemory, reinstateMemory } = await import("../src/index.ts");
  const p = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: b.projectId, type: "decision", title: "Hedge policy",
    content: "No hedged requests.", evidenceSourceIds: [w.sources.alpha.id], applicability: { repositoryId: "1001", branch: "main", validFrom: START } });
  const m = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: p.id, expectedRevision: 1 });
  const r = await getAgentContext(env.ctx, b, { query: "hedge" }); assert.equal(r.current.length, 1);
  const check = () => revalidateAgentReceipt(env.ctx, b, { retrievalId: r.retrievalId });
  assert.equal((await check()).status, "CURRENT");
  const legacyId = await env.db.transaction(async tx => {
    const { rows: [legacy] } = await tx.query<{ id: string }>(`INSERT INTO retrievals (project_id,caller_id,search_terms,outcome,retrieved_at,applicability)
      SELECT project_id,caller_id,search_terms,outcome,retrieved_at,applicability FROM retrievals WHERE id=$1 RETURNING id`, [r.retrievalId]);
    await tx.query("INSERT INTO retrieval_items (retrieval_id,position,memory_id,revision,status) VALUES ($1,1,$2,1,'approved')", [legacy!.id, m.id]);
    return legacy!.id;
  });
  assert.equal((await revalidateAgentReceipt(env.ctx, b, { retrievalId: legacyId })).status, "UNKNOWN");
  await suspendMemory(env.ctx, w.people.reviewer.id, { memoryId: m.id, expectedRevision: 1, reason: "Fixture review" });
  await reinstateMemory(env.ctx, w.people.reviewer.id, { memoryId: m.id, expectedRevision: 1, reason: "Fixture rechecked" });
  assert.deepEqual((await check()).items[0]?.reasons, ["lifecycle_changed"]);
});

test("revalidation reports a delivered definition that changed, was retired or whose basis changed after delivery", async () => {
  const w = await buildWorld(env.ctx), b = binding(w);
  const proposed = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: b.projectId, type: "decision", title: "Sessions use signed cookies",
    content: "Synthetic: sessions live in HttpOnly cookies.", evidenceSourceIds: [w.sources.alpha.id], applicability: { repositoryId: "1001", branch: "main", validFrom: START } });
  const basis = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposed.id, expectedRevision: 1 });
  const content = { name: "Session handling rule", purpose: "Synthetic purpose.", responsibilities: ["Synthetic duty"], links: [{ relation: "based_on" as const, targetId: basis.id }] };
  const approve = (proposal: { id: string; revision: number }) => approveDefinitionProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
  const rule = await approve(await proposeDefinition(env.ctx, w.people.contributor.id, { scope: { level: "project", id: b.projectId }, kind: "rule", ...content }));
  const check = (retrievalId: string) => revalidateAgentReceipt(env.ctx, b, { retrievalId });
  const pin = (pinnedRevision: number, observedRevision: number, reasons: string[]) => [{ definitionId: rule.id, pinnedRevision, observedRevision, reasons }];

  const withDecision = await getAgentTaskContext(env.ctx, b, { task: "session cookies" });
  assert.deepEqual(withDecision.items.map((item) => item.memoryId), [basis.id]);
  assert.deepEqual(await check(withDecision.retrievalId), { status: "CURRENT", items: [{ memoryId: basis.id, pinnedRevision: 1, observedRevision: 1, reasons: [], replacement: null }], definitions: pin(1, 1, []) });
  env.advance(1000);
  await approve(await proposeDefinitionChange(env.ctx, w.people.contributor.id, { definitionId: rule.id, baseRevision: 1, ...content, instructions: "Synthetic: rotate keys." }));
  const changed = await check(withDecision.retrievalId);
  assert.equal(changed.status, "STALE", "a changed definition makes the receipt stale even when its decisions are current");
  assert.deepEqual([changed.items[0]?.reasons, changed.definitions], [[], pin(1, 2, ["revision_changed"])]);

  const definitionsOnly = await getAgentTaskContext(env.ctx, b, { task: "logging format" });
  assert.deepEqual([definitionsOnly.outcome, definitionsOnly.definitions.map((d) => [d.revision, d.reviewNeeded])], ["no_results", [[2, false]]]);
  assert.deepEqual(await check(definitionsOnly.retrievalId), { status: "UNKNOWN", items: [], definitions: pin(2, 2, []) }, "no decisions delivered stays unknown");
  env.advance(1000);
  const replace = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: basis.id, expectedRevision: 1, kind: "replace", type: "decision",
    title: "Sessions use server storage", content: "Synthetic: sessions live on the server.", evidenceSourceIds: [w.sources.alpha.id] });
  const replacement = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: replace.id, expectedRevision: 1 });
  assert.deepEqual(await check(definitionsOnly.retrievalId), { status: "STALE", items: [], definitions: pin(2, 2, ["basis_changed"]) });

  env.advance(1000);
  const flagged = await getAgentTaskContext(env.ctx, b, { task: "logging format" });
  assert.deepEqual(flagged.definitions.map((d) => [d.reviewNeeded, d.basedOn]), [[true, [{ memoryId: basis.id, change: "superseded", replacedBy: replacement.id }]]]);
  assert.deepEqual((await check(flagged.retrievalId)).definitions, pin(2, 2, []), "a basis that changed before delivery was already flagged");
  await approve(await proposeDefinitionRetirement(env.ctx, w.people.contributor.id, { definitionId: rule.id, baseRevision: 2, reason: "Synthetic: replaced by server sessions" }));
  assert.deepEqual(await check(flagged.retrievalId), { status: "STALE", items: [], definitions: pin(2, 3, ["revision_changed", "retired"]) });
  assert.deepEqual((await getAgentTaskContext(env.ctx, b, { task: "logging format" })).definitions, [], "retired definitions are never delivered");
});
