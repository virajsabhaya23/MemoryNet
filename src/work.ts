import { REPOSITORY_ID } from "./repository-identity.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { requireCaller, requireRole, resolveScope, type Principal } from "./access.ts";
import { recordAudit } from "./audit.ts";
import { requireNoSecrets } from "./content-checks.ts";
import { accessFreshSince, type MemoryNetContext } from "./context.ts";
import type { Queryable } from "./db.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { findReadableMemory, requireDecisionApplicabilityAccess, requireDecisionBranch, type Memory } from "./knowledge.ts";
import { requireId } from "./validation.ts";

const ArtifactSchema = z.object({
  kind: z.enum(["spec", "instruction", "file", "test"]),
  path: z.string().min(1).max(500).refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").some((s) => s === ".." || s === "." || s === "") && !/[\x00-\x1f]/.test(p), "Use a relative repository path"),
  requirementId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const WorkInputSchema = z.object({
  projectId: z.uuid(), title: z.string().trim().min(1).max(200),
  repositoryId: z.string().regex(REPOSITORY_ID), branch: z.string().min(1).max(255),
  codeCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  artifacts: z.array(ArtifactSchema).min(1).max(40),
  decisions: z.array(z.object({ memoryId: z.uuid(), revision: z.number().int().positive() }).strict()).min(1).max(20),
}).strict();
export type WorkInput = z.infer<typeof WorkInputSchema>;
type Artifact = WorkInput["artifacts"][number];
export interface WorkPin { memoryId: string; revision: number; statusGeneration: number }
export interface WorkRecord {
  id: string; projectId: string; createdBy: string; title: string; repositoryId: string; branch: string;
  codeCommit: string; artifacts: Artifact[]; createdAt: Date; closedAt: Date | null; pins: WorkPin[];
}
export interface WorkIssue { memoryId: string; pinnedRevision: number; observedRevision?: number; reason: "revision_changed" | "lifecycle_changed" | "not_approved" | "outside_validity" }
export interface WorkAssessment { work: WorkRecord; checkedAt: Date; contextStatus: "current" | "review_needed"; issues: WorkIssue[] }
interface WorkRow {
  id: string; project_id: string; created_by: string; title: string; repository_id: string; branch: string;
  code_commit: string; artifacts: Artifact[]; created_at: Date; closed_at: Date | null;
}

async function authorize(q: Queryable, callerId: string, projectId: string, write = false) {
  const caller = await requireCaller(q, callerId);
  const scope = await resolveScope(q, { level: "project", id: projectId });
  await requireRole(q, caller, scope, write ? "contributor" : "reader", write ? "track decision-dependent work" : "read decision-dependent work");
  return caller;
}
function applicable(memory: Memory, repositoryId: string, branch: string, at: Date) {
  const a = memory.applicability;
  return a !== null && a.repositoryId === repositoryId && a.branch === branch && a.validFrom <= at && (a.validUntil === null || at < a.validUntil);
}
async function repositoryAccess(q: Queryable, ctx: MemoryNetContext, caller: Principal, work: { projectId: string; repositoryId: string; branch: string }) {
  await requireDecisionApplicabilityAccess(q, ctx, caller, work.projectId, { repositoryId: work.repositoryId, branch: work.branch, validFrom: ctx.now(), validUntil: null });
}

/** Explicit links are declared by the contributor. They are not inferred code dependencies or approved tests. */
export async function createWork(ctx: MemoryNetContext, callerId: string, raw: WorkInput): Promise<string> {
  const parsed = WorkInputSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError("Invalid work baseline: include a full commit, relative artifact paths, SHA-256 hashes, requirement IDs and exact decision revisions");
  const input = parsed.data;
  requireDecisionBranch(input.branch);
  requireNoSecrets(JSON.stringify(input), "Work baseline");
  if (new Set(input.decisions.map((d) => d.memoryId)).size !== input.decisions.length) throw new ValidationError("Duplicate decision pin");
  if (new Set(input.artifacts.map((a) => `${a.path}:${a.requirementId}`)).size !== input.artifacts.length) throw new ValidationError("Duplicate artifact requirement link");
  return ctx.db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const now = ctx.now(), readCtx = { ...ctx, now: () => now };
    const caller = await authorize(tx, callerId, input.projectId, true);
    await repositoryAccess(tx, readCtx, caller, input);
    const pins: WorkPin[] = [];
    for (const pin of input.decisions) {
      const memory = await findReadableMemory(tx, readCtx, caller, pin.memoryId);
      if (!memory || memory.projectId !== input.projectId) throw new NotFoundError("Decision not found");
      if (memory.revision !== pin.revision || memory.status !== "approved" || !applicable(memory, input.repositoryId, input.branch, now)) throw new ConflictError("Decision changed or does not currently apply to this exact repository and branch");
      pins.push({ ...pin, statusGeneration: memory.statusGeneration });
    }
    const row = (await tx.query<{ id: string }>(`INSERT INTO decision_work
      (project_id,created_by,title,repository_id,branch,code_commit,artifacts,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
    [input.projectId, caller.id, input.title, input.repositoryId, input.branch, input.codeCommit, JSON.stringify(input.artifacts), now])).rows[0]!;
    for (const pin of pins) await tx.query(`INSERT INTO decision_work_pins (work_id,project_id,memory_id,revision,status_generation) VALUES ($1,$2,$3,$4,$5)`, [row.id,input.projectId,pin.memoryId,pin.revision,pin.statusGeneration]);
    await recordAudit(tx, { occurredAt: now, actorId: caller.id, action: "work.created", projectId: input.projectId, targetType: "work", targetId: row.id });
    return row.id;
  });
}

// Historical evidence permissions matter even when the current revision cites a different repository.
async function load(q: Queryable, ctx: MemoryNetContext, caller: Principal, row: WorkRow): Promise<{ work: WorkRecord; memories: Memory[] } | null> {
  const work: WorkRecord = { id: row.id, projectId: row.project_id, createdBy: row.created_by, title: row.title,
    repositoryId: row.repository_id, branch: row.branch, codeCommit: row.code_commit, artifacts: row.artifacts,
    createdAt: row.created_at, closedAt: row.closed_at, pins: [] };
  try { await repositoryAccess(q, ctx, caller, work); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
  const pins = (await q.query<{ memory_id: string; revision: number; status_generation: number }>("SELECT memory_id,revision,status_generation FROM decision_work_pins WHERE work_id=$1 ORDER BY memory_id", [row.id])).rows;
  if (pins.length === 0) return null;
  const memories: Memory[] = [];
  for (const pin of pins) {
    const memory = await findReadableMemory(q, ctx, caller, pin.memory_id);
    if (!memory || memory.projectId !== work.projectId) return null;
    const denied = await q.query(`SELECT 1 FROM memory_evidence me WHERE me.memory_id=$1 AND me.revision=$2
      AND NOT EXISTS (SELECT 1 FROM source_read_access sra WHERE sra.source_id=me.source_id AND sra.principal_id=$3 AND sra.access_observed_at >= $4)`, [pin.memory_id,pin.revision,caller.id,accessFreshSince(ctx)]);
    if (denied.rows.length) return null;
    work.pins.push({ memoryId: pin.memory_id, revision: pin.revision, statusGeneration: pin.status_generation });
    memories.push(memory);
  }
  return { work, memories };
}
export function decisionPinIssues(memory: Memory, pin: Pick<WorkPin, "revision" | "statusGeneration">,
  scope: { repositoryId: string; branch: string }, checkedAt: Date) {
  const reasons: WorkIssue["reason"][] = [];
  if (memory.status !== "approved") reasons.push("not_approved");
  if (memory.revision !== pin.revision) reasons.push("revision_changed");
  if (memory.statusGeneration !== pin.statusGeneration) reasons.push("lifecycle_changed");
  if (!applicable(memory, scope.repositoryId, scope.branch, checkedAt)) reasons.push("outside_validity");
  return reasons;
}
function assess(ctx: MemoryNetContext, work: WorkRecord, memories: Memory[]): WorkAssessment {
  const checkedAt = ctx.now(), issues: WorkIssue[] = [];
  for (const [i, pin] of work.pins.entries()) {
    const memory = memories[i]!;
    const reasons = decisionPinIssues(memory, pin, work, checkedAt);
    for (const reason of reasons) issues.push({ memoryId: pin.memoryId, pinnedRevision: pin.revision, observedRevision: memory.revision, reason });
  }
  return { work, checkedAt, contextStatus: issues.length ? "review_needed" : "current", issues };
}

/** On-demand assessment from one consistent database snapshot; never a code-behavior verdict. */
export async function listWork(ctx: MemoryNetContext, callerId: string, projectId: string): Promise<WorkAssessment[]> {
  requireId(projectId, "projectId");
  return ctx.db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const now = ctx.now(), readCtx = { ...ctx, now: () => now };
    const caller = await authorize(tx, callerId, projectId);
    const rows = (await tx.query<WorkRow>("SELECT * FROM decision_work WHERE project_id=$1 AND closed_at IS NULL ORDER BY created_at DESC,id DESC", [projectId])).rows;
    const result: WorkAssessment[] = [];
    for (const row of rows) {
      const loaded = await load(tx, readCtx, caller, row);
      if (loaded) result.push(assess(readCtx, loaded.work, loaded.memories));
    }
    return result;
  });
}

export async function exportWork(ctx: MemoryNetContext, callerId: string, workId: string) {
  requireId(workId, "workId");
  return ctx.db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const now = ctx.now(), readCtx = { ...ctx, now: () => now };
    const row = (await tx.query<WorkRow>("SELECT * FROM decision_work WHERE id=$1", [workId])).rows[0];
    if (!row) throw new NotFoundError("Work not found");
    const caller = await authorize(tx, callerId, row.project_id);
    const loaded = await load(tx, readCtx, caller, row);
    if (!loaded) throw new NotFoundError("Work not found");
    const assessment = assess(readCtx, loaded.work, loaded.memories);
    if (assessment.contextStatus !== "current" || row.closed_at) throw new ConflictError("Work needs a new reviewed context baseline before export");
    return { schemaVersion: 1 as const, authority: "memorynet" as const, ...assessment,
      verification: "Context only. Artifact hashes and commit are contributor declarations; code behavior and artifact contents have not been verified.",
      decisions: loaded.memories.map((m) => ({ requirementId: `MN-${m.id}`, memoryId: m.id, revision: m.revision,
        title: m.title, content: m.content, contentSha256: createHash("sha256").update(m.content).digest("hex"),
        approvedBy: m.approvedBy, approvedAt: m.approvedAt, applicability: m.applicability,
        citations: m.evidence.map((e) => ({ sourceId: e.sourceId, url: e.url, revision: e.revision, excerpt: e.excerpt })) })) };
  });
}

export async function closeWork(ctx: MemoryNetContext, callerId: string, workId: string): Promise<void> {
  requireId(workId, "workId");
  await ctx.db.transaction(async (tx) => {
    const row = (await tx.query<WorkRow>("SELECT * FROM decision_work WHERE id=$1 FOR UPDATE", [workId])).rows[0];
    if (!row) throw new NotFoundError("Work not found");
    const caller = await authorize(tx, callerId, row.project_id, true);
    if (!(await load(tx, ctx, caller, row))) throw new NotFoundError("Work not found");
    if (row.closed_at) return;
    await tx.query("UPDATE decision_work SET closed_at=$2 WHERE id=$1", [workId,ctx.now()]);
    await recordAudit(tx, { occurredAt: ctx.now(), actorId: caller.id, action: "work.closed", projectId: row.project_id, targetType: "work", targetId: workId });
  });
}
