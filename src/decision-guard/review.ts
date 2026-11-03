import { createHash } from "node:crypto";
import { requireCaller, requireRole, resolveScope } from "../access.ts";
import { requireNoSecrets } from "../content-checks.ts";
import type { MemoryNetContext } from "../context.ts";
import type { Database, Queryable } from "../db.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getMemory, getSource, type DecisionApplicabilityInput, type Memory, type Source } from "../knowledge.ts";
import { MINIMUM_ROLE } from "../roles.ts";
import { requireCommitSha, requireId } from "../validation.ts";
import { extractDecisionCandidates, GUARD_LIMITS, type ApprovedDecision, type DecisionGuardProvider, type GuardSource } from "./model.ts";

export interface ExtractionForReviewInput {
  projectId: string;
  sourceIds: readonly string[];
  decisionIds?: readonly string[];
  /** Human-selected review scope, persisted by createGuardRun. */
  applicability?: DecisionApplicabilityInput | null;
}

function ids(value: readonly string[], maximum: number, required: boolean): string[] {
  if (!Array.isArray(value) || value.length > maximum || (required && value.length === 0)) {
    throw new ValidationError("Decision Guard requires a bounded list of record IDs");
  }
  const checked = value.map((id) => requireId(id, "recordId"));
  if (new Set(checked).size !== checked.length) throw new ValidationError("Decision Guard record IDs must be unique");
  return checked.sort();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function authorize(ctx: MemoryNetContext, callerId: string, projectId: string): Promise<void> {
  const caller = await requireCaller(ctx.db, callerId);
  const scope = await resolveScope(ctx.db, { level: "project", id: projectId });
  await requireRole(ctx.db, caller, scope, MINIMUM_ROLE.propose, "extract decision candidates");
}

async function sourceFor(ctx: MemoryNetContext, callerId: string, projectId: string, id: string): Promise<Source> {
  const source = await getSource(ctx, callerId, id);
  if (source.projectId !== projectId) throw new NotFoundError("Source not found");
  if (source.revision === null) throw new ValidationError("Decision Guard requires revision-pinned evidence");
  requireCommitSha(source.revision, "source revision");
  requireNoSecrets(JSON.stringify({ url: source.url, excerpt: source.excerpt }), "Evidence");
  return source;
}

async function decisionFor(ctx: MemoryNetContext, callerId: string, projectId: string, id: string): Promise<Memory> {
  const memory = await getMemory(ctx, callerId, id);
  if (memory.projectId !== projectId) throw new NotFoundError("Memory not found");
  if (memory.status !== "approved" || memory.type !== "decision") {
    throw new ValidationError("Conflict comparison requires a current approved decision");
  }
  requireNoSecrets(`${memory.title}\n${memory.content}`, "Approved decision");
  return memory;
}

/** Route existing read helpers through the admitted transaction, never the outer connection. */
function transactionDatabase(tx: Queryable): Database {
  return {
    query: (sql, params) => tx.query(sql, params),
    exec: (sql) => tx.exec(sql),
    transaction: (fn) => fn(tx),
    async close() { throw new Error("Cannot close a transaction-scoped database"); },
  };
}

async function revalidateSnapshot(
  ctx: MemoryNetContext,
  callerId: string,
  projectId: string,
  sources: readonly Source[],
  decisions: readonly Memory[],
): Promise<{ sources: Source[]; decisions: Memory[] }> {
  return ctx.db.transaction(async (tx) => {
    // A consistent authorization/data snapshot, including on server PostgreSQL.
    // No transaction is held across a provider request.
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const snapshotCtx = { ...ctx, db: transactionDatabase(tx), now: (() => {
      const observedAt = ctx.now();
      return () => new Date(observedAt);
    })() };
    await authorize(snapshotCtx, callerId, projectId);
    const currentSources: Source[] = [];
    for (const source of sources) {
      const current = await sourceFor(snapshotCtx, callerId, projectId, source.id);
      if (hash(current) !== hash(source)) throw new ConflictError("Evidence changed during extraction; start a new review");
      currentSources.push(current);
    }
    const currentDecisions: Memory[] = [];
    for (const memory of decisions) {
      const current = await getMemory(snapshotCtx, callerId, memory.id);
      if (current.projectId !== projectId || current.status !== "approved" || hash(current) !== hash(memory)) {
        throw new ConflictError("Approved decisions changed during extraction; start a new review");
      }
      currentDecisions.push(current);
    }
    return { sources: currentSources, decisions: currentDecisions };
  });
}

/**
 * Permission-bound staging only. The caller is an already-authenticated principal;
 * this service does not provide external sign-in or permission to spend/disclose.
 * Nothing is persisted, proposed, approved or superseded. Provider access remains
 * separately disabled until an operator explicitly configures an authorized path.
 * Disclosure is authorized against the final consistent admission snapshot.
 * Permission changes after dispatch cannot undo data already sent to a provider;
 * the separate post-inference snapshot withholds results after such changes.
 */
export async function extractForReview(
  ctx: MemoryNetContext,
  callerId: string,
  provider: DecisionGuardProvider,
  input: ExtractionForReviewInput,
) {
  const projectId = requireId(input.projectId, "projectId");
  const sourceIds = ids(input.sourceIds, GUARD_LIMITS.sources, true);
  const decisionIds = ids(input.decisionIds ?? [], GUARD_LIMITS.approvedDecisions, false);
  await authorize(ctx, callerId, projectId);
  const sources: Source[] = [];
  for (const id of sourceIds) sources.push(await sourceFor(ctx, callerId, projectId, id));
  const decisions: Memory[] = [];
  for (const id of decisionIds) decisions.push(await decisionFor(ctx, callerId, projectId, id));

  const admitted = await revalidateSnapshot(ctx, callerId, projectId, sources, decisions);
  const sourceSnapshots: GuardSource[] = admitted.sources.map((source) => ({
    sourceId: source.id, revision: source.revision!, url: source.url, text: source.excerpt,
  }));
  const approvedDecisions: ApprovedDecision[] = admitted.decisions.map((memory) => ({
    memoryId: memory.id, revision: memory.revision, title: memory.title, content: memory.content,
  }));
  const result = await extractDecisionCandidates(provider, { sources: sourceSnapshots, approvedDecisions });

  // Provider latency is an authorization race window. Re-read permissions and the
  // complete authorized records before returning any generated or source content.
  await revalidateSnapshot(ctx, callerId, projectId, admitted.sources, admitted.decisions);
  return { ...result, projectId, sourceSnapshots };
}
