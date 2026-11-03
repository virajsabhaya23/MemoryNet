// Dedicated public-source demo. Never opens the ordinary application database.
// Bootstrap creates pending proposals only. The owner performs every real approval in the UI.
import { createLocalHttpServer } from "../../src/web/http.ts";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createApp } from "../../src/web/app.ts";
import { createGuardRuntime } from "../../src/decision-guard/runtime.ts";
import { createBudgetedDemoFetcher } from "../../src/evaluation/request-budget.ts";
import { readAgentBindingFile, writeAgentBindingFile } from "../../src/agent-context/binding.ts";
import { assignRole, connectRepository, createBusinessUnit, createContext, createOrganization,
  createPrincipal, createProject, migrate, openDatabase, proposeMemory, recordRepositoryAccess,
  recordSource, listRetrievals, type Database } from "../../src/index.ts";

interface DemoSetup {
  schemaVersion: 1;
  ownerId: string;
  agentId: string;
  projectId: string;
  sources: { id: string; sourceKey: string }[];
  repositoryId: string;
  applicability: { repositoryId: string; branch: string; validFrom: string; validUntil: null };
  historicalProposalId: string;
  historicalProposalRevision: number;
  sourceManifestSha256: string;
  classification: string;
  createdAt: string;
}

const root = resolve(import.meta.dirname, "../..");
const local = join(root, ".local/eslint-demo");
const evidenceDir = join(local, "evidence");
await mkdir(local, { recursive: true, mode: 0o700 });
await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const port = 3062;
const appUrl = `http://127.0.0.1:${port}`;
const manifest = JSON.parse(await readFile(join(root, "examples/eslint-demo/sources/manifest.json"), "utf8"));
const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
const db = await openDatabase(join(local, "database"));
await migrate(db);
// Same local prototype freshness assumption as src/web/server.ts, not a GitHub permission sync.
const ctx = createContext(db, { repositoryAccessMaxAgeMs: 30 * 24 * 60 * 60 * 1000 });
const stateFile = join(local, "setup.json");
let setup: DemoSetup;
try { setup = JSON.parse(await readFile(stateFile, "utf8")); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  if ((await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM principals")).rows[0]?.count !== 0) {
    throw new Error("Existing demo database has no setup manifest; refusing to modify it");
  }
  const owner = await createPrincipal(ctx, { kind: "human", displayName: "Project owner — personal review required" });
  const agent = await createPrincipal(ctx, { kind: "agent", displayName: "Meta extraction and coding context agent" });
  const org = await createOrganization(ctx, owner.id, { slug: "eslint-demo", name: "MemoryNet demonstration — local identities" });
  const unit = await createBusinessUnit(ctx, owner.id, { organizationId: org.id, slug: "public-evidence", name: "Public engineering evidence" });
  const project = await createProject(ctx, owner.id, { businessUnitId: unit.id, slug: "eslint-consumer", name: "ESLint consumer migration — controlled task" });
  await assignRole(ctx, owner.id, { principalId: agent.id, scope: { level: "project", id: project.id }, role: "contributor" });
  const repositoryId = manifest.repository.externalRepositoryId;
  await connectRepository(ctx, owner.id, { projectId: project.id, provider: "github", externalRepositoryId: repositoryId, fullName: "eslint/eslint" });
  for (const principal of [owner, agent]) await recordRepositoryAccess(ctx, { principalId: principal.id, provider: "github", externalRepositoryId: repositoryId, canRead: true });
  const sources = [];
  for (const item of manifest.sources) {
    const raw = await readFile(join(root, "examples/eslint-demo/sources", item.rawFile), "utf8");
    if (!raw.includes(item.excerpt)) throw new Error("Source excerpt is not in pinned public document");
    const source = await recordSource(ctx, owner.id, { projectId: project.id, provider: "github", externalRepositoryId: repositoryId,
      reference: item.reference, url: item.url, revision: item.revision, excerpt: item.excerpt });
    sources.push({ id: source.id, sourceKey: item.id });
  }
  const applicability = { repositoryId, branch: "main", validFrom: "2026-10-31T00:00:00.000Z", validUntil: null };
  const historical = await proposeMemory(ctx, agent.id, { projectId: project.id, ownerId: owner.id, type: "decision",
    title: "Controlled consumer: historical ESLint v9 compatibility",
    content: "Historical stage for this controlled demonstration only: while the consumer uses ESLint v9, retain its .eslintrc configuration with ESLINT_USE_FLAT_CONFIG=false. This is a deprecated v9 compatibility option and must be replaced when this demo consumer upgrades to v10. Approving this record today authorizes local demo guidance; it does not claim an upstream ESLint team policy or a historical human approval.",
    evidenceSourceIds: [sources[0]!.id], applicability });
  setup = { schemaVersion: 1, ownerId: owner.id, agentId: agent.id, projectId: project.id, sources, repositoryId, applicability,
    historicalProposalId: historical.id, historicalProposalRevision: historical.revision, sourceManifestSha256: manifestSha256,
    classification: "genuine upstream evidence; controlled derived consumer; local personal approval only", createdAt: new Date().toISOString() };
  await writeFile(stateFile, JSON.stringify(setup, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
if (setup.sourceManifestSha256 !== manifestSha256) throw new Error("Source manifest changed after demo bootstrap");
const bindingPath = join(local, "binding.json");
try { await readAgentBindingFile(bindingPath); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  await writeAgentBindingFile(bindingPath, { principalId: setup.agentId, projectId: setup.projectId, repositoryId: setup.repositoryId, branch: "main" });
}
await writeFile(join(local, "connection.json"), JSON.stringify({ schemaVersion: 1, appUrl, bindingPath, query: "ESLint" }, null, 2) + "\n", { mode: 0o600 });

// One durable dispatch allowance, including failures. Startup never spends it.
// Do not remove this ledger to silently retry a paid request.
const fetcher = createBudgetedDemoFetcher(join(local, "meta-dispatch.json"));
// Native `node --env-file=/existing/private/file` can reuse an operator's saved
// MODEL_API_KEY. Never copy that file or key into demo artifacts. Startup makes no inference request.
const runtime = createGuardRuntime({ apiKey: process.env.MODEL_API_KEY, agentId: setup.agentId,
  maxRequests: 1, maxOutputTokens: 4096, fetcher,
  onFailure: (event) => console.warn(JSON.stringify(event)) });
const app = createApp(ctx, { port, decisionGuard: runtime, agentBinding: () => readAgentBindingFile(bindingPath) });

let snapshotQueue: Promise<void> = Promise.resolve();
function snapshot(): Promise<void> {
  const pending = snapshotQueue.catch(() => undefined).then(async () => {
    const state = await db.transaction(async (tx) => {
      await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const capturedAt = ctx.now();
      const snapshotDb: Database = { query: (sql, params) => tx.query(sql, params), exec: (sql) => tx.exec(sql),
        transaction: (fn) => fn(tx), async close() { throw new Error("Snapshot cannot close database"); } };
      const snapshotCtx = { ...ctx, db: snapshotDb, now: () => new Date(capturedAt) };
      const proposals = (await tx.query("SELECT id,title,content,status,revision,proposed_by,reviewed_by,reviewed_at,memory_id,applicability FROM memory_proposals ORDER BY proposed_at")).rows;
      const memories = (await tx.query("SELECT m.id,m.status,r.title,r.content,r.revision,r.approved_by,r.approved_at,r.applicability FROM memories m JOIN memory_revisions r ON r.memory_id=m.id AND r.revision=m.current_revision ORDER BY r.approved_at")).rows;
      const runs = (await tx.query("SELECT id,created_at,extraction,source_records,decision_records,applicability FROM decision_guard_runs ORDER BY created_at")).rows;
      const receipts = await listRetrievals(snapshotCtx, setup.ownerId, { projectId: setup.projectId, limit: 200 });
      return { schemaVersion: 1, capturedAt: capturedAt.toISOString(), classification: setup.classification,
        sourceManifestSha256: manifestSha256, proposals, memories, runs, receipts };
    });
    const temporary = join(evidenceDir, `.workflow-state-${process.pid}-${randomUUID()}.json`);
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, join(evidenceDir, "workflow-state.json"));
    } finally { await rm(temporary, { force: true }); }
  });
  snapshotQueue = pending;
  return pending;
}
await snapshot();
await writeFile(join(evidenceDir, "staging.json"), JSON.stringify({ ...setup, appUrl, projectUrl: `${appUrl}/projects/${setup.projectId}`,
  reviewUrl: `${appUrl}/proposals/${setup.historicalProposalId}`, extractionUrl: `${appUrl}/projects/${setup.projectId}/decision-guard`,
  maxDispatchAttemptsAcrossRestarts: 1,
  maxOutputTokens: 4096, aggregateConservativeCostCeilingUsd: 0.10,
  credentialConfiguredAtStartup: runtime.status().configured,
  repositoryAccess: "local public-repository stand-in, 30-day freshness; not GitHub App sync" }, null, 2) + "\n", { mode: 0o600 });
const transport = createLocalHttpServer(async (request) => {
  const result = await app(request);
  if (request.method === "POST") await snapshot();
  return result;
}, port);
const server = transport.server;
let closing = false;
async function close() { if (closing) return; closing = true;
  await transport.close();
  await runtime.forget();
  await snapshot(); await db.close(); }
server.on("error", () => { console.error("Cannot start demo; port 3062 may already be in use."); process.exitCode = 1; void close(); });
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ ready: true, appUrl, projectId: setup.projectId,
  historicalProposalId: setup.historicalProposalId, credentialConfigured: runtime.status().configured, automaticModelCalls: 0, automaticApprovals: 0 })));
