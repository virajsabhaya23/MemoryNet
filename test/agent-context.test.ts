import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { parseAgentBinding, readAgentBindingFile, writeAgentBindingFile, type AgentBinding } from "../src/agent-context/binding.ts";
import { AgentContextSchema, AgentQuerySchema, AGENT_CONTEXT_PATH } from "../src/agent-context/contract.ts";
import { getAgentContext } from "../src/agent-context/service.ts";
import { createContext, ForbiddenError, ValidationError } from "../src/index.ts";
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
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const original = await readFile(file, "utf8");
    await assert.rejects(writeAgentBindingFile(file, input, START));
    assert.equal(await readFile(file, "utf8"), original);
    await chmod(file, 0o644);
    await assert.rejects(readAgentBindingFile(file), ValidationError);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("bridge refuses non-loopback and ambiguous destinations without making requests", () => {
  for (const url of ["https://127.0.0.1:3050", "http://example.com:3050", "http://user:password@localhost:3050", "http://localhost:3050/other", "http://localhost:3050?override=x", "http://localhost", "http://localhost:3050/#fragment"]) {
    assert.throws(() => createContextBridge(url, "a".repeat(64)), ValidationError);
  }
});

test("checked-in JSON schemas match the executable v1 contract", async () => {
  for (const [name, schema] of [["agent-query-v1", AgentQuerySchema], ["agent-context-v1", AgentContextSchema]] as const) {
    assert.deepEqual(JSON.parse(await readFile(new URL(`../docs/contracts/${name}.schema.json`, import.meta.url), "utf8")), z.toJSONSchema(schema));
  }
});
