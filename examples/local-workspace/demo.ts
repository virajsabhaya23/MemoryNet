// Run the actual selection CLI, app process and MCP stdio transport on disposable Git checkouts.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AgentContextSchema, ReceiptCheckV2Schema } from "../../src/agent-context/contract.ts";
import { approveProposal, createContext, openDatabase, proposeChange, proposeMemory, revokeMemory } from "../../src/index.ts";
import { localProfilePath } from "../../src/local-project.ts";
import { readWorkspaceProfile, type WorkspaceProfile } from "../../src/workspace.ts";
import type { LocalRepository } from "../../src/local-discovery.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../src/scripts/workspace.ts", import.meta.url));
const mcp = fileURLToPath(new URL("../../src/scripts/mcp.ts", import.meta.url));
const folder = await mkdtemp(join(tmpdir(), "memorynet-workspace-demo-"));
const root = join(folder, "projects");
const started = performance.now();
const run = async (...args: string[]) => (await exec(process.execPath, [cli, ...args, "--root", root], { cwd: folder })).stdout;
const git = async (dir: string, ...args: string[]) => (await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
  "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: dir })).stdout.trim();
const doc = "docs/adr/retries.md";
const oldPolicy = "For HTTP 503, return 4 as the retry limit. For HTTP 429, return 2. For all other status codes, return 0.";
const newPolicy = "For HTTP 503, return 2 as the retry limit. For HTTP 429, return 0. For all other status codes, return 0.";
async function commitDoc(project: string, policy: string) {
  const dir = join(root, project);
  await mkdir(join(dir, "docs/adr"), { recursive: true });
  await writeFile(join(dir, doc), policy + "\n");
  await git(dir, "add", doc);
  await git(dir, "commit", "-qm", "Record retry policy");
  return git(dir, "rev-parse", "HEAD");
}
async function reservePort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const addr = s.address();
  assert.ok(addr && typeof addr !== "string");
  await new Promise<void>(r => s.close(() => r()));
  return addr.port;
}
async function onApp<T>(project: string, profile: WorkspaceProfile, fn: (c: Client) => Promise<T>, binding = profile.bindingFile) {
  const child = spawn(process.execPath, [cli, "start", "--root", root, "--project", project], { cwd: folder, stdio: ["ignore", "pipe", "pipe"] });
  const stopped = once(child, "exit");
  const client = new Client({ name: "local-workspace-demo", version: "1" });
  try {
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("Workspace startup timed out")), 30_000);
      const finish = () => { clearTimeout(timer); ok(); };
      child.stdout.on("data", chunk => { if (chunk.toString().includes("http://localhost:")) finish(); });
      child.once("error", e => { clearTimeout(timer); fail(e); });
      child.once("exit", () => { clearTimeout(timer); fail(new Error("Workspace exited")); });
    });
    assert.equal((await fetch(profile.appUrl, { redirect: "manual" })).status < 400, true);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcp],
      env: { MEMORYNET_APP_URL: profile.appUrl, MEMORYNET_AGENT_BINDING_FILE: binding }, stderr: "pipe" }));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ["get_context", "get_task_context", "revalidate_context"]);
    return await fn(client);
  } finally { await client.close(); child.kill("SIGTERM"); await stopped; }
}
async function fetchContext(c: Client, query: string) {
  const r = await c.callTool({ name: "get_context", arguments: { query } });
  assert.ok(!r.isError, "context retrieval failed");
  return AgentContextSchema.parse(r.structuredContent);
}
async function check(c: Client, retrievalId: string) {
  const r = await c.callTool({ name: "revalidate_context", arguments: { retrievalId } });
  assert.ok(!r.isError, "receipt check failed");
  return ReceiptCheckV2Schema.parse(r.structuredContent);
}
async function publish(profile: WorkspaceProfile, sourceId: string, content: string, previous?: string) {
  const db = await openDatabase(profile.dataDir);
  try {
    const ctx = createContext(db);
    const proposal = previous
      ? await proposeChange(ctx, profile.operatorId, { memoryId: previous, expectedRevision: 1, kind: "revise", type: "decision",
        title: "Retry limits", content, evidenceSourceIds: [sourceId] })
      : await proposeMemory(ctx, profile.operatorId, { projectId: profile.projectId, type: "decision", title: "Retry limits",
        content, evidenceSourceIds: [sourceId], applicability: { repositoryId: profile.repository.id, branch: "main", validFrom: ctx.now() } });
    const args = { proposalId: proposal.id, expectedRevision: proposal.revision };
    await assert.rejects(approveProposal(ctx, profile.operatorId, args));
    const attempts = await Promise.allSettled([approveProposal(ctx, profile.reviewerIds[0]!, args), approveProposal(ctx, profile.reviewerIds[0]!, args)]);
    const wins = attempts.filter(a => a.status === "fulfilled");
    assert.equal(wins.length, 1);
    return wins[0]!.value;
  } finally { await db.close(); }
}
try {
  for (const name of ["consumer", "unrelated"]) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await git(dir, "init", "--template=", "-q", "-b", "main");
    await commitDoc(name, name === "consumer" ? oldPolicy : "Isolated project uses 9 retries for HTTP 503.");
  }
  const preview = JSON.parse(await run("preview")) as { repositories: LocalRepository[] };
  assert.deepEqual(preview.repositories.map(r => r.project), ["consumer", "unrelated"]);
  const [a, b] = preview.repositories as [LocalRepository, LocalRepository];
  const profiles: WorkspaceProfile[] = [];
  const sources: string[] = [];
  async function importDoc(repo: LocalRepository, at: string) {
    const out = await run("import", "--fixture", "--at", at, "--project", repo.project, "--document", doc);
    const id = /^Evidence ([a-f0-9-]{36})/m.exec(out)?.[1]; assert.ok(id); return id;
  }
  for (const repo of [a, b]) {
    await run("register", "--fixture", "--project", repo.project, "--at", repo.commit, "--port", String(await reservePort()));
    const p = await readWorkspaceProfile(localProfilePath(repo, join(folder, ".local/memorynet/local-projects"))); assert.ok(p);
    profiles.push(p); sources.push(await importDoc(repo, repo.commit));
  }
  const [alpha, beta] = profiles as [WorkspaceProfile, WorkspaceProfile];
  const first = await publish(alpha, sources[0]!, oldPolicy);
  const setupMs = performance.now() - started;
  const initial = await onApp("consumer", alpha, async c => {
    const result = await fetchContext(c, "retry limits");
    assert.equal(result.current[0]?.memoryId, first.id); assert.equal(result.current[0]?.citations[0]?.revision, a.commit);
    const unchanged = await check(c, result.retrievalId);
    assert.equal(unchanged.status, "CURRENT");
    const empty = await fetchContext(c, "unrelatedquasar");
    assert.equal(empty.outcome, "no_results"); assert.equal((await check(c, empty.retrievalId)).status, "UNKNOWN");
    return { result, unchanged };
  });
  await publish(beta, sources[1]!, "Isolated project uses 9 retries for HTTP 503.");
  const irrelevant = await onApp("consumer", alpha, async c => {
    const status = await check(c, initial.result.retrievalId); assert.equal(status.status, "CURRENT");
    assert.equal((await fetchContext(c, "isolated")).current.length, 0); return status;
  });
  const denied = await onApp("unrelated", beta, c => c.callTool({ name: "get_context", arguments: { query: "isolated" } }), alpha.bindingFile);
  assert.equal(denied.isError, true); assert.ok(!JSON.stringify(denied).includes("9 retries"));
  const upstreamDir = join(root, "upstream");
  await mkdir(upstreamDir); await git(upstreamDir, "init", "--template=", "-q", "-b", "main");
  const nextHead = await commitDoc("upstream", newPolicy);
  const origin = (JSON.parse(await run("preview")).repositories as LocalRepository[]).find(r => r.project === "upstream")!;
  const args = ["import", "--fixture", "--at", nextHead, "--project", a.project, "--document", doc, "--from", "upstream"];
  await assert.rejects(run(...args));
  const imported = await run(...args, "--share-public-source");
  const upstreamSource = /^Evidence ([a-f0-9-]{36})/m.exec(imported)?.[1]; assert.ok(upstreamSource);
  await publish(alpha, upstreamSource, newPolicy, first.id);
  const changed = await onApp("consumer", alpha, async c => {
    const stale = await check(c, initial.result.retrievalId); assert.equal(stale.status, "STALE");
    assert.equal(stale.items[0]?.pinnedRevision, 1); assert.equal(stale.items[0]?.observedRevision, 2);
    const fresh = await fetchContext(c, "retry limits");
    assert.deepEqual(fresh.current.map(i => i.content), [newPolicy]); assert.equal(fresh.current[0]?.citations[0]?.revision, nextHead);
    assert.equal(fresh.scope.repositoryId, a.id); assert.ok(fresh.current[0]?.citations[0]?.url.startsWith(`memorynet-local://${origin.id}/`));
    return { stale, fresh };
  });
  const db = await openDatabase(alpha.dataDir);
  try { await revokeMemory(createContext(db), alpha.reviewerIds[0]!, { memoryId: first.id, expectedRevision: 2, reason: "Fixture withdrawn" }); }
  finally { await db.close(); }
  const revoked = await onApp("consumer", alpha, async c => {
    assert.equal((await fetchContext(c, "retry limits")).outcome, "no_results");
    const result = await check(c, changed.fresh.retrievalId); assert.equal(result.status, "STALE"); return result;
  });
  console.log(JSON.stringify({ kind: "synthetic-local-workspace", approvals: "simulated distinct principals", setupMs,
    elapsedMs: performance.now() - started, initial, irrelevant, changed, revoked, crossProjectCredentialRejected: true }, null, 2));
} finally { await rm(folder, { recursive: true, force: true }); }
