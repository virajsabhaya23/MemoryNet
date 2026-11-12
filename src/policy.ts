import { requireCaller, requireHuman, requireRole, resolveScope } from "./access.ts";
import { recordAudit } from "./audit.ts";
import { requireNoSecrets } from "./content-checks.ts";
import type { MemoryNetContext } from "./context.ts";
import type { Queryable } from "./db.ts";
import { ConflictError, ValidationError } from "./errors.ts";
import { MINIMUM_ROLE } from "./roles.ts";
import { requireBoolean, requireId, requireText } from "./validation.ts";

export interface ProjectPolicy {
  projectId: string;
  /** Different reviewers who must approve the same exact proposal version before it is published. */
  requiredApprovals: number;
  /** Whether agent principals may propose memories in this project. */
  agentProposals: boolean;
  /** Most pending proposals one agent may have waiting for review in this project. */
  agentPendingLimit: number;
  /** 0 for the built-in default, which has never been changed. */
  revision: number;
  changedBy: string | null;
  changedAt: Date | null;
  reason: string | null;
}

export const DEFAULT_POLICY = { requiredApprovals: 1, agentProposals: true, agentPendingLimit: 25 } as const;
export const MAX_REQUIRED_APPROVALS = 3;
const MAX_AGENT_PENDING_LIMIT = 500;

interface PolicyRow {
  revision: number;
  required_approvals: number;
  agent_proposals: boolean;
  agent_pending_limit: number;
  changed_by: string;
  changed_at: Date;
  reason: string;
}

/** The current policy, without an access check. Callers check the project role first. */
export async function readProjectPolicy(q: Queryable, projectId: string): Promise<ProjectPolicy> {
  const row = (await q.query<PolicyRow>(
    `SELECT revision, required_approvals, agent_proposals, agent_pending_limit, changed_by, changed_at, reason
     FROM project_policy_revisions WHERE project_id = $1 ORDER BY revision DESC LIMIT 1`,
    [projectId],
  )).rows[0];
  if (!row) return { projectId, ...DEFAULT_POLICY, revision: 0, changedBy: null, changedAt: null, reason: null };
  return {
    projectId,
    requiredApprovals: row.required_approvals,
    agentProposals: row.agent_proposals,
    agentPendingLimit: row.agent_pending_limit,
    revision: row.revision,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
    reason: row.reason,
  };
}

/** Anyone with a role in the project may read its policy. */
export async function getProjectPolicy(ctx: MemoryNetContext, callerId: string, projectId: string): Promise<ProjectPolicy> {
  const id = requireId(projectId, "projectId");
  const caller = await requireCaller(ctx.db, callerId);
  const scope = await resolveScope(ctx.db, { level: "project", id });
  await requireRole(ctx.db, caller, scope, MINIMUM_ROLE.read, "read the review policy");
  return readProjectPolicy(ctx.db, id);
}

function requireWholeNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/**
 * Saves a new policy version. Administrators and owners only, people only, with a reason, naming the
 * version they saw so two changes at once become a visible conflict. Pending proposals are judged by the
 * policy in force when the last needed approval is given.
 */
export async function setProjectPolicy(
  ctx: MemoryNetContext,
  callerId: string,
  input: {
    projectId: string;
    expectedRevision: number;
    requiredApprovals: number;
    agentProposals: boolean;
    agentPendingLimit: number;
    reason: string;
  },
): Promise<ProjectPolicy> {
  const projectId = requireId(input.projectId, "projectId");
  const expectedRevision = requireWholeNumber(input.expectedRevision, "expectedRevision", 0, 2_147_483_647);
  const requiredApprovals = requireWholeNumber(input.requiredApprovals, "requiredApprovals", 1, MAX_REQUIRED_APPROVALS);
  const agentProposals = requireBoolean(input.agentProposals, "agentProposals");
  const agentPendingLimit = requireWholeNumber(input.agentPendingLimit, "agentPendingLimit", 1, MAX_AGENT_PENDING_LIMIT);
  const reason = requireText(input.reason, "reason", 500);
  requireNoSecrets(reason, "reason");
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    requireHuman(caller, "change the review policy");
    const scope = await resolveScope(tx, { level: "project", id: projectId });
    await requireRole(tx, caller, scope, MINIMUM_ROLE.managePolicy, "change the review policy");
    await tx.query("SELECT id FROM projects WHERE id = $1 FOR NO KEY UPDATE", [projectId]);
    const current = await readProjectPolicy(tx, projectId);
    if (current.revision !== expectedRevision) {
      throw new ConflictError(`The policy changed since you opened it: it is now at version ${current.revision}. Reload and try again.`);
    }
    if (current.requiredApprovals === requiredApprovals && current.agentProposals === agentProposals && current.agentPendingLimit === agentPendingLimit) {
      throw new ValidationError("Nothing changed, so no new policy version was saved");
    }
    const now = ctx.now();
    const revision = current.revision + 1;
    await tx.query(
      `INSERT INTO project_policy_revisions (project_id, revision, required_approvals, agent_proposals, agent_pending_limit, changed_by, changed_at, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [projectId, revision, requiredApprovals, agentProposals, agentPendingLimit, caller.id, now, reason],
    );
    await recordAudit(tx, {
      occurredAt: now, actorId: caller.id, action: "policy.changed",
      organizationId: scope.organizationId, projectId, targetType: "project", targetId: projectId, reason,
      details: {
        revision, requiredApprovals, agentProposals, agentPendingLimit,
        previousRequiredApprovals: current.requiredApprovals,
      },
    });
    return readProjectPolicy(tx, projectId);
  });
}

/** Refuses an agent proposal the project policy does not allow. Runs inside the proposal transaction. */
export async function requireAgentProposalAllowed(q: Queryable, agentId: string, projectId: string): Promise<void> {
  const policy = await readProjectPolicy(q, projectId);
  if (!policy.agentProposals) throw new ValidationError("This project does not accept proposals from agents; ask a person to propose it");
  const pending = (await q.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM memory_proposals WHERE project_id = $1 AND proposed_by = $2 AND status = 'pending'",
    [projectId, agentId],
  )).rows[0]?.count ?? 0;
  if (pending >= policy.agentPendingLimit) {
    throw new ConflictError(`This agent already has ${pending} proposals waiting for review here (the limit is ${policy.agentPendingLimit}). Wait for reviews before proposing more.`);
  }
}
