import { createHash } from "node:crypto";
import { requireCaller, requireHuman, requireRole, resolveScope } from "../access.ts";
import { requireNoSecrets } from "../content-checks.ts";
import type { MemoryNetContext } from "../context.ts";
import { firstRow, type Database, type Queryable } from "../db.ts";
import { ConflictError, ForbiddenError, MemoryNetError, NotFoundError, ValidationError } from "../errors.ts";
import { getMemory, getProposal, getSource, normalizeDecisionApplicability, proposeChange, proposeMemory, requireDecisionApplicabilityAccess, type DecisionApplicability, type Memory, type Proposal, type Source } from "../knowledge.ts";
import { MINIMUM_ROLE } from "../roles.ts";
import { requireCommitSha, requireId } from "../validation.ts";
import { GUARD_LIMITS, validateGuardOutput, type DecisionGuardProvider, type GuardCandidate, type GuardInput } from "./model.ts";
import { extractForReview, type ExtractionForReviewInput } from "./review.ts";

export type CreateGuardRunInput = ExtractionForReviewInput;
export type GuardExtraction = Awaited<ReturnType<typeof extractForReview>>;
/** Matches the existing proposal evidence bound in knowledge.ts. Every model
 * context dependency must fit that bound before disclosure, even if uncited. */
export const GUARD_MAX_CONTEXT_SOURCES = 20;
export interface GuardPublication {
  candidateIndex: number;
  kind: "new" | "replace";
  targetMemoryId: string | null;
  proposalId: string;
  proposalRevision: number;
}
export interface GuardRun {
  id: string;
  projectId: string;
  requesterId: string;
  agentId: string;
  createdAt: Date;
  applicability: DecisionApplicability | null;
  /** Immutable comparison selection, independent of optional model conflict hints. */
  comparedDecisions: Array<{ memoryId: string; revision: number }>;
  extraction: GuardExtraction;
  publications: GuardPublication[];
}
export interface PublishGuardCandidateInput {
  runId: string;
  candidateIndex: number;
  kind: "new" | "replace";
  targetMemoryId?: string;
}
export interface GuardProvenance { run: GuardRun; publication: GuardPublication; candidate: GuardCandidate }
interface RunRow {
  id: string; project_id: string; requester_id: string; agent_id: string; created_at: Date;
  extraction: GuardExtraction; source_records: Source[]; decision_records: Memory[];
  applicability: DecisionApplicability | null; applicability_connection_id: string | null;
}

function txContext(ctx: MemoryNetContext, tx: Queryable): MemoryNetContext {
  const db: Database = { query: (sql, params) => tx.query(sql, params), exec: (sql) => tx.exec(sql),
    transaction: (fn) => fn(tx), async close() { throw new Error("Cannot close a transaction-scoped database"); } };
  const time = ctx.now();
  return { ...ctx, db, now: () => new Date(time) };
}
function hash(value: unknown): string {
  // jsonb canonicalizes object key order; provenance comparisons must survive a
  // database round trip while preserving array order and exact source text.
  const canonical = JSON.stringify(value, (_, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
  return createHash("sha256").update(canonical).digest("hex");
}
function checkedIds(value: readonly string[], maximum: number, required = false): string[] {
  if (!Array.isArray(value) || value.length > maximum || (required && value.length === 0)) throw new ValidationError("Invalid Decision Guard record selection");
  const result = value.map((id) => requireId(id, "recordId")).sort();
  if (new Set(result).size !== result.length) throw new ValidationError("Decision Guard record selection must be unique");
  return result;
}
async function contributor(ctx: MemoryNetContext, callerId: string, projectId: string, human = false) {
  const caller = await requireCaller(ctx.db, callerId);
  if (human) requireHuman(caller, "review Decision Guard drafts");
  await requireRole(ctx.db, caller, await resolveScope(ctx.db, { level: "project", id: projectId }), MINIMUM_ROLE.propose, "use Decision Guard");
  return caller;
}
async function snapshot(ctx: MemoryNetContext, requesterId: string, agentId: string, input: CreateGuardRunInput) {
  const requester = await contributor(ctx, requesterId, input.projectId, true);
  const agent = await contributor(ctx, agentId, input.projectId);
  if (agent.kind !== "agent") throw new ValidationError("Decision Guard proposer must be an agent principal");
  const applicability = normalizeDecisionApplicability(input.applicability);
  const applicabilityConnectionId = await requireDecisionApplicabilityAccess(ctx.db, ctx, requester, input.projectId, applicability);
  await requireDecisionApplicabilityAccess(ctx.db, ctx, agent, input.projectId, applicability);
  const decisions: Memory[] = [];
  const allSourceIds = new Set(input.sourceIds);
  for (const id of input.decisionIds ?? []) {
    const memory = await getMemory(ctx, requesterId, id);
    const agentMemory = await getMemory(ctx, agentId, id);
    if (memory.projectId !== input.projectId || memory.status !== "approved" || memory.type !== "decision" || hash(memory) !== hash(agentMemory)) {
      throw new ConflictError("Decision Guard requires current approved decisions in this project");
    }
    requireNoSecrets(`${memory.title}\n${memory.content}`, "Approved decision");
    if (applicability && (hash(memory.applicability) !== hash(applicability) ||
        memory.applicability!.validFrom.getTime() > ctx.now().getTime() ||
        (memory.applicability!.validUntil !== null && memory.applicability!.validUntil.getTime() <= ctx.now().getTime()))) {
      throw new ValidationError("Conflict comparisons must have the same active reviewed applicability");
    }
    decisions.push(memory);
    for (const evidence of memory.evidence) allSourceIds.add(evidence.sourceId);
  }
  if (allSourceIds.size > GUARD_MAX_CONTEXT_SOURCES) throw new ValidationError("Decision Guard context exceeds the proposal evidence dependency limit");
  const sources: Source[] = [];
  for (const id of [...allSourceIds].sort()) {
    const source = await getSource(ctx, requesterId, id);
    const agentSource = await getSource(ctx, agentId, id);
    if (source.projectId !== input.projectId || hash(source) !== hash(agentSource)) throw new NotFoundError("Source not found");
    if (input.sourceIds.includes(id)) {
      if (source.revision === null) throw new ValidationError("Decision Guard requires revision-pinned evidence");
      requireCommitSha(source.revision, "source revision");
      requireNoSecrets(JSON.stringify({ url: source.url, excerpt: source.excerpt }), "Evidence");
    }
    sources.push(source);
  }
  return { sources, decisions, applicabilityConnectionId };
}
function guardInput(input: CreateGuardRunInput, records: { sources: Source[]; decisions: Memory[] }): GuardInput {
  return {
    sources: records.sources.filter((source) => input.sourceIds.includes(source.id)).map((source) => ({ sourceId: source.id, revision: source.revision!, url: source.url, text: source.excerpt })),
    approvedDecisions: records.decisions.map((memory) => ({ memoryId: memory.id, revision: memory.revision, title: memory.title, content: memory.content })),
  };
}
async function consistentSnapshot(ctx: MemoryNetContext, requesterId: string, agentId: string, input: CreateGuardRunInput, expected?: { sources: Source[]; decisions: Memory[]; applicabilityConnectionId: string | null }) {
  return ctx.db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const records = await snapshot(txContext(ctx, tx), requesterId, agentId, input);
    if (expected && hash(records) !== hash(expected)) throw new ConflictError("Decision Guard inputs changed; extract a new draft");
    return records;
  });
}

/** One model call creates only an immutable unreviewed draft. No API key is stored. */
export async function createGuardRun(ctx: MemoryNetContext, requesterId: string, agentId: string, provider: DecisionGuardProvider, raw: CreateGuardRunInput): Promise<GuardRun> {
  const input = { projectId: requireId(raw.projectId, "projectId"), sourceIds: checkedIds(raw.sourceIds, GUARD_LIMITS.sources, true), decisionIds: checkedIds(raw.decisionIds ?? [], GUARD_LIMITS.approvedDecisions), applicability: normalizeDecisionApplicability(raw.applicability) };
  const original = await consistentSnapshot(ctx, requesterId, agentId, input);
  // Agent admission is checked by extractForReview; this final wrapper admits
  // BOTH the real requesting human and agent immediately before dispatch.
  let admissionFailure: MemoryNetError | undefined;
  const gated: DecisionGuardProvider = { async complete(messages) {
    try { await consistentSnapshot(ctx, requesterId, agentId, input, original); }
    catch (error) { if (error instanceof MemoryNetError) admissionFailure = error; throw error; }
    return provider.complete(messages);
  } };
  let extraction: GuardExtraction;
  try { extraction = await extractForReview(ctx, agentId, gated, input); }
  catch (error) { if (admissionFailure) throw admissionFailure; throw error; }
  requireNoSecrets(JSON.stringify(extraction.candidates), "Model output");
  const id = await ctx.db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const scoped = txContext(ctx, tx);
    const current = await snapshot(scoped, requesterId, agentId, input);
    if (hash(current) !== hash(original)) throw new ConflictError("Decision Guard inputs changed; extract a new draft");
    if (hash(extraction.sourceSnapshots) !== hash(guardInput(input, current).sources)) throw new ConflictError("Decision Guard evidence snapshot does not match");
    const row = firstRow((await tx.query<{ id: string }>(
      `INSERT INTO decision_guard_runs(project_id, requester_id, agent_id, created_at, extraction, source_records, decision_records,applicability,applicability_connection_id)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9) RETURNING id`,
      [input.projectId, requesterId, agentId, scoped.now(), JSON.stringify(extraction), JSON.stringify(current.sources), JSON.stringify(current.decisions), input.applicability ? JSON.stringify(input.applicability) : null, current.applicabilityConnectionId],
    )).rows);
    for (const source of current.sources) await tx.query("INSERT INTO decision_guard_run_sources(project_id,run_id,source_id) VALUES($1,$2,$3)", [input.projectId, row.id, source.id]);
    return row.id;
  });
  return getGuardRun(ctx, requesterId, id);
}

async function readableRun(ctx: MemoryNetContext, callerId: string, id: string, lock = false): Promise<RunRow> {
  const row = (await ctx.db.query<RunRow>(`SELECT * FROM decision_guard_runs WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [requireId(id, "runId")])).rows[0];
  if (!row) throw new NotFoundError("Decision Guard draft not found");
  const caller = await contributor(ctx, callerId, row.project_id, true);
  await requireDecisionApplicabilityAccess(ctx.db, ctx, caller, row.project_id, normalizeDecisionApplicability(row.applicability));
  const sources = await ctx.db.query<{ source_id: string }>("SELECT source_id FROM decision_guard_run_sources WHERE run_id=$1 ORDER BY source_id", [row.id]);
  for (const source of sources.rows) await getSource(ctx, callerId, source.source_id);
  return row;
}
async function publications(ctx: MemoryNetContext, runId: string): Promise<GuardPublication[]> {
  const { rows } = await ctx.db.query<{ candidate_index: number; kind: "new" | "replace"; target_memory_id: string | null; proposal_id: string; proposal_revision: number }>(
    "SELECT candidate_index,kind,target_memory_id,proposal_id,proposal_revision FROM decision_guard_publications WHERE run_id=$1 ORDER BY candidate_index", [runId]);
  return rows.map((row) => ({ candidateIndex: row.candidate_index, kind: row.kind, targetMemoryId: row.target_memory_id, proposalId: row.proposal_id, proposalRevision: row.proposal_revision }));
}
export async function getGuardRun(ctx: MemoryNetContext, callerId: string, runId: string): Promise<GuardRun> {
  return ctx.db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const scoped = txContext(ctx, tx);
    const row = await readableRun(scoped, callerId, runId);
    const comparedDecisions = [];
    for (const memory of row.decision_records) {
      // Original context dependencies are checked above. Also check present
      // memory visibility before exposing a comparison ID to the review UI.
      await getMemory(scoped, callerId, memory.id);
      comparedDecisions.push({ memoryId: memory.id, revision: memory.revision });
    }
    return { id: row.id, projectId: row.project_id, requesterId: row.requester_id, agentId: row.agent_id, createdAt: row.created_at, applicability: normalizeDecisionApplicability(row.applicability), comparedDecisions, extraction: row.extraction, publications: await publications(scoped, row.id) };
  });
}

/** Explicit selection creates a pending proposal; existing review remains the sole authority. */
export async function publishGuardCandidate(ctx: MemoryNetContext, callerId: string, raw: PublishGuardCandidateInput): Promise<Proposal> {
  const runId = requireId(raw.runId, "runId");
  if (!Number.isSafeInteger(raw.candidateIndex) || raw.candidateIndex < 0 || raw.candidateIndex >= GUARD_LIMITS.candidates || (raw.kind !== "new" && raw.kind !== "replace")) throw new ValidationError("Invalid Decision Guard candidate selection");
  const targetMemoryId = raw.targetMemoryId === undefined ? null : requireId(raw.targetMemoryId, "targetMemoryId");
  if ((raw.kind === "replace") !== (targetMemoryId !== null)) throw new ValidationError("Replacement requires an explicit target decision");
  return ctx.db.transaction(async (tx) => {
    // Row-lock serialization plus READ COMMITTED lets a concurrent replay see
    // the first publication after waiting for the immutable run's lock.
    await tx.exec("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    const scoped = txContext(ctx, tx);
    const row = await readableRun(scoped, callerId, runId, true);
    if (row.requester_id !== callerId) throw new ForbiddenError("Only the requesting person may publish this candidate");
    const candidate = row.extraction.candidates[raw.candidateIndex];
    if (!candidate) throw new ValidationError("Decision Guard candidate does not exist");
    const previous = (await publications(scoped, runId)).find((item) => item.candidateIndex === raw.candidateIndex);
    if (previous) {
      if (previous.kind !== raw.kind || previous.targetMemoryId !== targetMemoryId) throw new ConflictError("This candidate already has a different publication selection");
      return getProposal(scoped, callerId, previous.proposalId);
    }
    const input: CreateGuardRunInput = { projectId: row.project_id, sourceIds: row.extraction.sourceSnapshots.map((source) => source.sourceId), decisionIds: row.decision_records.map((memory) => memory.id), applicability: normalizeDecisionApplicability(row.applicability) };
    const current = await snapshot(scoped, row.requester_id, row.agent_id, input);
    if (hash(current.sources) !== hash(row.source_records) || hash(current.decisions) !== hash(row.decision_records)) throw new ConflictError("Decision Guard inputs changed; extract a new draft");
    if (current.applicabilityConnectionId !== row.applicability_connection_id) throw new ConflictError("Applicability repository connection changed; extract a new draft");
    validateGuardOutput(JSON.stringify({ candidates: row.extraction.candidates }), guardInput(input, current));
    const fields = { type: "decision" as const, title: candidate.title, content: candidate.decision,
      // Generated text can depend on every disclosed context input, including
      // unquoted evidence and conflict-decision inputs. Preserve all dependency
      // ACLs through the existing proposal/memory evidence visibility rule.
      // Exact quoted support is separately immutable in the run provenance.
      evidenceSourceIds: current.sources.map((source) => source.id), ownerId: row.requester_id, applicability: input.applicability };
    let proposal: Proposal;
    if (raw.kind === "replace") {
      // A model hint is advisory, never a veto over an explicit human choice.
      // Limit that choice to the immutable, fully revalidated comparison set.
      const target = row.decision_records.find((memory) => memory.id === targetMemoryId);
      if (!target) throw new ValidationError("Replacement target must be a decision compared in this run");
      proposal = await proposeChange(scoped, row.agent_id, { ...fields, memoryId: target.id, expectedRevision: target.revision, kind: "replace" });
    } else proposal = await proposeMemory(scoped, row.agent_id, { ...fields, projectId: row.project_id });
    await tx.query(`INSERT INTO decision_guard_publications(project_id,run_id,candidate_index,kind,target_memory_id,proposal_id,proposal_revision,requested_by,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [row.project_id, runId, raw.candidateIndex, raw.kind, targetMemoryId, proposal.id, proposal.revision, callerId, scoped.now()]);
    return proposal;
  });
}

export async function getGuardProposalProvenance(ctx: MemoryNetContext, callerId: string, proposalId: string, proposalRevision?: number): Promise<GuardProvenance | null> {
  await getProposal(ctx, callerId, requireId(proposalId, "proposalId"));
  const row = (await ctx.db.query<{ run_id: string; candidate_index: number; proposal_revision: number }>("SELECT run_id,candidate_index,proposal_revision FROM decision_guard_publications WHERE proposal_id=$1", [proposalId])).rows[0];
  if (!row || (proposalRevision !== undefined && proposalRevision !== row.proposal_revision)) return null;
  const run = await getGuardRun(ctx, callerId, row.run_id);
  const publication = run.publications.find((item) => item.proposalId === proposalId)!;
  return { run, publication, candidate: run.extraction.candidates[row.candidate_index]! };
}
