import {
  requireCaller,
  requireHuman,
  requireRole,
  resolveScope,
} from "./access.ts";
import { recordAudit } from "./audit.ts";
import { requireNoSecrets } from "./content-checks.ts";
import { accessFreshSince, type MemoryNetContext } from "./context.ts";
import type { Queryable } from "./db.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import {
  EVIDENCE_JSON,
  findReadableMemory,
  lockChangeTarget,
  mapEvidence,
  mapProposal,
  proposalReadParams,
  resolveReports,
  setMemoryStatus,
  type ChangeKind,
  type Evidence,
  type Memory,
  type MemoryStatus,
  type MemoryType,
  type Proposal,
  type ProposalRow,
  type ReportResolution,
  normalizeDecisionApplicability,
  type DecisionApplicability,
  type DecisionApplicabilityInput,
} from "./knowledge.ts";
import { MINIMUM_ROLE } from "./roles.ts";
import {
  requireId,
  requirePositiveInteger,
  requireText,
} from "./validation.ts";

const REASON_MAX_LENGTH = 500;

/** One approved version of a memory, as its history shows it. */
export interface MemoryVersion {
  revision: number;
  /** False when this version cites a source the caller cannot read now; its text is then left out. */
  readable: boolean;
  type: MemoryType | null;
  title: string | null;
  content: string | null;
  approvedBy: string;
  approvedAt: Date;
  proposalId: string;
  proposalRevision: number;
  /** How this version came about: a new memory, a revision, a restore, or a replacement's first version. */
  changeKind: ChangeKind;
  restoredFromRevision: number | null;
  evidence: Evidence[];
  applicability: DecisionApplicability | null;
}

export interface StatusChange {
  revision: number;
  from: MemoryStatus;
  to: MemoryStatus;
  changedBy: string;
  changedAt: Date;
  reason: string | null;
}

export interface MemoryReport {
  id: string;
  memoryId: string;
  revision: number;
  reportedBy: string;
  reportedAt: Date;
  reason: string;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolution: ReportResolution | null;
  /** Why a person dismissed it. */
  resolutionNote: string | null;
}

/** A linked memory. The title is null when the caller cannot read that memory. */
export interface MemoryLink {
  id: string;
  title: string | null;
}

export interface MemoryHistory {
  memory: Memory;
  /** Oldest first. */
  versions: MemoryVersion[];
  statusChanges: StatusChange[];
  /** Older memories this one replaced. */
  replaces: MemoryLink[];
  replacedBy: MemoryLink | null;
  /** Pending changes to this memory; only people who may see proposals get any. */
  pendingChanges: Proposal[];
  reports: MemoryReport[];
}

interface ReportRow {
  id: string;
  memory_id: string;
  revision: number;
  reported_by: string;
  reported_at: Date;
  reason: string;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution: ReportResolution | null;
  resolution_note: string | null;
}

const REPORT_COLUMNS = `id, memory_id, revision, reported_by, reported_at, reason, resolved_by,
  resolved_at, resolution, resolution_note`;

function mapReport(row: ReportRow): MemoryReport {
  return {
    id: row.id,
    memoryId: row.memory_id,
    revision: row.revision,
    reportedBy: row.reported_by,
    reportedAt: row.reported_at,
    reason: row.reason,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    resolutionNote: row.resolution_note,
  };
}

function requireReason(value: unknown): string {
  const reason = requireText(value, "reason", REASON_MAX_LENGTH);
  requireNoSecrets(reason, "reason");
  return reason;
}

async function link(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Parameters<typeof findReadableMemory>[2],
  id: string,
): Promise<MemoryLink> {
  const memory = await findReadableMemory(q, ctx, caller, id);
  return { id, title: memory?.title ?? null };
}

/** A memory's whole story: every version, status change, replacement, pending change, and report the caller may see. */
export async function getMemoryHistory(
  ctx: MemoryNetContext,
  callerId: string,
  memoryId: string,
): Promise<MemoryHistory> {
  const id = requireId(memoryId, "memoryId");
  const caller = await requireCaller(ctx.db, callerId);
  const memory = await findReadableMemory(ctx.db, ctx, caller, id);
  if (!memory) throw new NotFoundError("Memory not found");
  const versions = await ctx.db.query<{
    revision: number;
    type: MemoryType;
    title: string;
    content: string;
    approved_by: string;
    approved_at: Date;
    proposal_id: string;
    proposal_revision: number;
    change_kind: ChangeKind;
    restored_from_revision: number | null;
    evidence: Parameters<typeof mapEvidence>[0];
    readable: boolean;
    applicability: DecisionApplicabilityInput | null;
  }>(
    `SELECT r.revision, r.type, r.title, r.content, r.approved_by, r.approved_at,
            r.proposal_id, r.proposal_revision, mp.change_kind, mp.restored_from_revision, r.applicability,
            (SELECT ${EVIDENCE_JSON} FROM memory_evidence me JOIN sources s ON s.id = me.source_id
             WHERE me.memory_id = r.memory_id AND me.revision = r.revision) AS evidence,
            NOT EXISTS (
              SELECT 1 FROM memory_evidence me
              WHERE me.memory_id = r.memory_id AND me.revision = r.revision
                AND NOT EXISTS (
                  SELECT 1 FROM source_read_access sra
                  WHERE sra.principal_id = $2 AND sra.source_id = me.source_id
                    AND sra.access_observed_at >= $3))
              AND (r.applicability IS NULL OR EXISTS(SELECT 1 FROM repository_connections rc JOIN repository_access ra
                ON ra.provider=rc.provider AND ra.external_repository_id=rc.external_repository_id
                WHERE rc.id=r.applicability_connection_id AND rc.disconnected_at IS NULL
                  AND ra.principal_id=$2 AND ra.can_read AND ra.observed_at >= $3)) AS readable
     FROM memory_revisions r JOIN memory_proposals mp ON mp.id = r.proposal_id
     WHERE r.memory_id = $1
     ORDER BY r.revision`,
    [id, caller.id, accessFreshSince(ctx)],
  );
  const changes = await ctx.db.query<{
    revision: number;
    from_status: MemoryStatus;
    to_status: MemoryStatus;
    changed_by: string;
    changed_at: Date;
    reason: string | null;
  }>(
    `SELECT revision, from_status, to_status, changed_by, changed_at, reason
     FROM memory_status_changes WHERE memory_id = $1 ORDER BY id`,
    [id],
  );
  const replaced = await ctx.db.query<{ id: string }>(
    "SELECT id FROM memories WHERE superseded_by = $1 ORDER BY created_at, id",
    [id],
  );
  const pending = await ctx.db.query<ProposalRow>(
    `${PENDING_CHANGES_SQL} AND mp.target_memory_id = $5 ORDER BY mp.proposed_at, mp.id`,
    [...proposalReadParams(ctx, caller), id],
  );
  const reports = await ctx.db.query<ReportRow>(
    `SELECT ${REPORT_COLUMNS}
     FROM memory_reports WHERE memory_id = $1 ORDER BY reported_at DESC, id`,
    [id],
  );
  const replaces: MemoryLink[] = [];
  for (const row of replaced.rows)
    replaces.push(await link(ctx.db, ctx, caller, row.id));
  return {
    memory,
    versions: versions.rows.map((row) => ({
      revision: row.revision,
      readable: row.readable,
      type: row.readable ? row.type : null,
      title: row.readable ? row.title : null,
      content: row.readable ? row.content : null,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      proposalId: row.proposal_id,
      proposalRevision: row.proposal_revision,
      changeKind: row.change_kind,
      restoredFromRevision: row.restored_from_revision,
      evidence: row.readable ? mapEvidence(row.evidence) : [],
      applicability: row.readable ? normalizeDecisionApplicability(row.applicability) : null,
    })),
    statusChanges: changes.rows.map((row) => ({
      revision: row.revision,
      from: row.from_status,
      to: row.to_status,
      changedBy: row.changed_by,
      changedAt: row.changed_at,
      reason: row.reason,
    })),
    replaces,
    replacedBy:
      memory.supersededBy === null
        ? null
        : await link(ctx.db, ctx, caller, memory.supersededBy),
    pendingChanges: pending.rows.map(mapProposal),
    reports: reports.rows.map(mapReport),
  };
}

// The readable-proposal query, limited to pending ones; binds $1-$4 like proposalReadParams.
const PENDING_CHANGES_SQL = `
  SELECT mp.id, mp.project_id, mp.type, mp.title, mp.content, mp.owner_id, mp.status,
         mp.revision, mp.proposed_by, mp.proposed_at, mp.reviewed_by, mp.reviewed_at,
         mp.review_reason, mp.memory_id, mp.content_flags, mp.change_kind,
         mp.target_memory_id, mp.base_revision, mp.restored_from_revision, mp.applicability, mp.applicability_connection_id, mp.base_status_generation,
         (SELECT ${EVIDENCE_JSON} FROM proposal_evidence pe JOIN sources s ON s.id = pe.source_id
          WHERE pe.proposal_id = mp.id) AS evidence
  FROM memory_proposals mp
  JOIN effective_project_roles epr
    ON epr.project_id = mp.project_id AND epr.principal_id = $1
  WHERE $3::boolean AND epr.rank >= $4::int AND mp.status = 'pending'
    AND (mp.applicability IS NULL OR EXISTS(SELECT 1 FROM repository_connections rc JOIN repository_access ra
      ON ra.provider=rc.provider AND ra.external_repository_id=rc.external_repository_id
      WHERE rc.id=mp.applicability_connection_id AND rc.disconnected_at IS NULL
        AND ra.principal_id=$1 AND ra.can_read AND ra.observed_at >= $2))
    AND NOT EXISTS (
      SELECT 1 FROM proposal_evidence pe
      WHERE pe.proposal_id = mp.id
        AND NOT EXISTS (
          SELECT 1 FROM source_read_access sra
          WHERE sra.principal_id = $1 AND sra.source_id = pe.source_id
            AND sra.access_observed_at >= $2))`;

/** Loads a memory for a status change: readable, in a project where the caller holds the role, and locked. */
async function startStatusChange(
  tx: Queryable,
  ctx: MemoryNetContext,
  callerId: string,
  memoryId: string,
  expectedRevision: number,
  minimum: (typeof MINIMUM_ROLE)[keyof typeof MINIMUM_ROLE],
  action: string,
) {
  const caller = await requireCaller(tx, callerId);
  requireHuman(caller, action);
  const memory = await findReadableMemory(tx, ctx, caller, memoryId);
  if (!memory) throw new NotFoundError("Memory not found");
  const scope = await resolveScope(tx, {
    level: "project",
    id: memory.projectId,
  });
  await requireRole(tx, caller, scope, minimum, action);
  const target = await lockChangeTarget(tx, memory.id);
  if (target.current_revision !== expectedRevision) {
    throw new ConflictError(
      `The memory changed since you opened it: it is now at version ${target.current_revision}. Reload and try again.`,
    );
  }
  return { caller, scope, target };
}

/**
 * Takes disputed guidance out of current use until a reviewer resolves it. A person with the contributor role or
 * higher must give a reason. Agents cannot suspend; they can report instead.
 */
export async function suspendMemory(
  ctx: MemoryNetContext,
  callerId: string,
  input: { memoryId: string; expectedRevision: number; reason: string },
): Promise<Memory> {
  const memoryId = requireId(input.memoryId, "memoryId");
  const expectedRevision = requirePositiveInteger(
    input.expectedRevision,
    "expectedRevision",
  );
  const reason = requireReason(input.reason);
  return ctx.db.transaction(async (tx) => {
    const { caller, scope, target } = await startStatusChange(
      tx,
      ctx,
      callerId,
      memoryId,
      expectedRevision,
      MINIMUM_ROLE.suspend,
      "suspend memories",
    );
    if (target.status !== "approved") {
      throw new ConflictError(
        target.status === "suspended"
          ? "This memory is already suspended"
          : "This memory was replaced, so it is no longer current",
      );
    }
    const now = ctx.now();
    await setMemoryStatus(tx, target, "suspended", caller.id, now, {
      reason,
      revision: target.current_revision,
    });
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "memory.suspended",
      organizationId: scope.organizationId,
      projectId: target.project_id,
      targetType: "memory",
      targetId: target.id,
      reason,
      details: { revision: target.current_revision },
    });
    const memory = await findReadableMemory(tx, ctx, caller, target.id);
    if (!memory) throw new NotFoundError("Memory not found");
    return memory;
  });
}

/** Makes a suspended memory current again, unchanged. Needs a person with the reviewer role or higher. */
export async function reinstateMemory(
  ctx: MemoryNetContext,
  callerId: string,
  input: { memoryId: string; expectedRevision: number; reason: string },
): Promise<Memory> {
  const memoryId = requireId(input.memoryId, "memoryId");
  const expectedRevision = requirePositiveInteger(
    input.expectedRevision,
    "expectedRevision",
  );
  const reason = requireReason(input.reason);
  return ctx.db.transaction(async (tx) => {
    const { caller, scope, target } = await startStatusChange(
      tx,
      ctx,
      callerId,
      memoryId,
      expectedRevision,
      MINIMUM_ROLE.reinstate,
      "reinstate memories",
    );
    if (target.status !== "suspended") {
      throw new ConflictError("Only a suspended memory can be reinstated");
    }
    const now = ctx.now();
    await setMemoryStatus(tx, target, "approved", caller.id, now, {
      reason,
      revision: target.current_revision,
    });
    await resolveReports(tx, target.id, caller.id, now, "reinstated");
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "memory.reinstated",
      organizationId: scope.organizationId,
      projectId: target.project_id,
      targetType: "memory",
      targetId: target.id,
      reason,
      details: { revision: target.current_revision },
    });
    const memory = await findReadableMemory(tx, ctx, caller, target.id);
    if (!memory) throw new NotFoundError("Memory not found");
    return memory;
  });
}

/** Removes current authority explicitly. A new authored proposal and human review
 * are required to publish guidance again; reinstatement/restore cannot undo it. */
export async function revokeMemory(
  ctx: MemoryNetContext,
  callerId: string,
  input: { memoryId: string; expectedRevision: number; reason: string },
): Promise<Memory> {
  const memoryId = requireId(input.memoryId, "memoryId");
  const expectedRevision = requirePositiveInteger(input.expectedRevision, "expectedRevision");
  const reason = requireReason(input.reason);
  return ctx.db.transaction(async (tx) => {
    const { caller, scope, target } = await startStatusChange(tx, ctx, callerId, memoryId, expectedRevision, MINIMUM_ROLE.review, "revoke decisions");
    if (target.status !== "approved" && target.status !== "suspended") throw new ConflictError("Only current or suspended decisions can be revoked");
    const now = ctx.now();
    await setMemoryStatus(tx, target, "revoked", caller.id, now, { reason, revision: target.current_revision });
    await recordAudit(tx, { occurredAt: now, actorId: caller.id, action: "memory.revoked", organizationId: scope.organizationId,
      projectId: target.project_id, targetType: "memory", targetId: target.id, reason, details: { revision: target.current_revision } });
    const memory = await findReadableMemory(tx, ctx, caller, target.id);
    if (!memory) throw new NotFoundError("Memory not found");
    return memory;
  });
}

/**
 * Reports that a memory may be outdated. Anyone who can read it may report, agents included.
 * A report changes nothing by itself: a person suspends, changes, or dismisses.
 */
export async function reportOutdated(
  ctx: MemoryNetContext,
  callerId: string,
  input: { memoryId: string; reason: string },
): Promise<MemoryReport> {
  const memoryId = requireId(input.memoryId, "memoryId");
  const reason = requireReason(input.reason);
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    const memory = await findReadableMemory(tx, ctx, caller, memoryId);
    if (!memory) throw new NotFoundError("Memory not found");
    const scope = await resolveScope(tx, {
      level: "project",
      id: memory.projectId,
    });
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.reportOutdated,
      "report memories",
    );
    if (memory.status === "superseded" || memory.status === "revoked") {
      throw new ConflictError("This memory was already replaced or revoked");
    }
    const now = ctx.now();
    const { rows } = await tx.query<ReportRow>(
      `INSERT INTO memory_reports (project_id, memory_id, revision, reported_by, reported_at, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${REPORT_COLUMNS}`,
      [memory.projectId, memory.id, memory.revision, caller.id, now, reason],
    );
    const report = rows[0];
    if (!report) throw new Error("Report was not saved");
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "memory.reported",
      organizationId: scope.organizationId,
      projectId: memory.projectId,
      targetType: "memory",
      targetId: memory.id,
      reason,
      details: { revision: memory.revision, reportId: report.id },
    });
    return mapReport(report);
  });
}

/** Closes a report without changing the memory. Needs a person with the reviewer role or higher. */
export async function dismissReport(
  ctx: MemoryNetContext,
  callerId: string,
  input: { reportId: string; reason: string },
): Promise<MemoryReport> {
  const reportId = requireId(input.reportId, "reportId");
  const reason = requireReason(input.reason);
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    requireHuman(caller, "dismiss reports");
    const found = await tx.query<ReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM memory_reports WHERE id = $1 FOR UPDATE`,
      [reportId],
    );
    const report = found.rows[0];
    const memory =
      report && (await findReadableMemory(tx, ctx, caller, report.memory_id));
    if (!report || !memory) throw new NotFoundError("Report not found");
    const scope = await resolveScope(tx, {
      level: "project",
      id: memory.projectId,
    });
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.reinstate,
      "dismiss reports",
    );
    if (report.resolved_at !== null) {
      throw new ConflictError("This report was already resolved");
    }
    const now = ctx.now();
    const { rows } = await tx.query<ReportRow>(
      `UPDATE memory_reports
       SET resolved_by = $2, resolved_at = $3, resolution = 'dismissed', resolution_note = $4
       WHERE id = $1
       RETURNING ${REPORT_COLUMNS}`,
      [report.id, caller.id, now, reason],
    );
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "memory.report_dismissed",
      organizationId: scope.organizationId,
      projectId: memory.projectId,
      targetType: "memory",
      targetId: memory.id,
      reason,
      details: { reportId: report.id },
    });
    const updated = rows[0];
    if (!updated) throw new Error("Report was not updated");
    return mapReport(updated);
  });
}
