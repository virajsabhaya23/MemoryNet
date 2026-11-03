import {
  effectiveRank,
  findPrincipal,
  lockOrganization,
  mapPrincipal,
  requireCaller,
  requireHuman,
  requireRole,
  requireScopeRef,
  resolveScope,
  scopeNotFound,
  scopeTargetId,
  type Principal,
  type Scope,
  type ScopeRef,
} from "./access.ts";
import { recordAudit } from "./audit.ts";
import type { MemoryNetContext } from "./context.ts";
import { firstRow, insertReturning, type Queryable } from "./db.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./errors.ts";
import {
  AGENT_ROLES,
  MINIMUM_ROLE,
  PRINCIPAL_KINDS,
  ROLE_RANK,
  ROLES,
  roleForRank,
  roleNeededToManage,
  type PrincipalKind,
  type Role,
} from "./roles.ts";
import {
  optionalText,
  requireGithubId,
  requireId,
  requireOneOf,
  requireText,
} from "./validation.ts";

export interface RoleAssignment {
  id: string;
  principalId: string;
  principalName: string;
  principalKind: PrincipalKind;
  scope: ScopeRef;
  role: Role;
  grantedBy: string;
  grantedAt: Date;
}

/** One of the caller's own roles, at the scope where it was granted. */
export interface OwnRole {
  scope: ScopeRef;
  scopeName: string;
  organizationName: string;
  role: Role;
  grantedAt: Date;
}

const NAME_MAX_LENGTH = 120;
const REASON_MAX_LENGTH = 500;

const ASSIGNMENT_SELECT = `
  SELECT ra.id, ra.principal_id, pr.display_name, pr.kind, ra.organization_id,
         ra.business_unit_id, ra.project_id, ra.role, ra.granted_by, ra.granted_at
  FROM role_assignments ra
  JOIN principals pr ON pr.id = ra.principal_id`;

interface AssignmentRow {
  id: string;
  principal_id: string;
  display_name: string;
  kind: PrincipalKind;
  organization_id: string;
  business_unit_id: string | null;
  project_id: string | null;
  role: Role;
  granted_by: string;
  granted_at: Date;
}

function mapAssignment(row: AssignmentRow): RoleAssignment {
  const scope: ScopeRef = row.project_id
    ? { level: "project", id: row.project_id }
    : row.business_unit_id
      ? { level: "business_unit", id: row.business_unit_id }
      : { level: "organization", id: row.organization_id };
  return {
    id: row.id,
    principalId: row.principal_id,
    principalName: row.display_name,
    principalKind: row.kind,
    scope,
    role: row.role,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
  };
}

/** A grant names only its own level; a project grant leaves business_unit_id empty. */
function assignmentColumns(
  scope: Scope,
): [string, string | null, string | null] {
  if (scope.level === "organization") return [scope.organizationId, null, null];
  if (scope.level === "business_unit") {
    return [scope.organizationId, scope.businessUnitId, null];
  }
  return [scope.organizationId, null, scope.projectId];
}

async function loadAssignment(
  q: Queryable,
  assignmentId: string,
): Promise<RoleAssignment> {
  const { rows } = await q.query<AssignmentRow>(
    `${ASSIGNMENT_SELECT} WHERE ra.id = $1`,
    [assignmentId],
  );
  return mapAssignment(firstRow(rows));
}

async function findActiveAssignment(
  q: Queryable,
  principalId: string,
  scope: Scope,
): Promise<{ id: string; role: Role } | null> {
  const { rows } = await q.query<{ id: string; role: Role }>(
    `SELECT id, role FROM role_assignments
     WHERE principal_id = $1 AND organization_id = $2
       AND business_unit_id IS NOT DISTINCT FROM $3::uuid
       AND project_id IS NOT DISTINCT FROM $4::uuid
       AND revoked_at IS NULL
     FOR UPDATE`,
    [principalId, ...assignmentColumns(scope)],
  );
  return rows[0] ?? null;
}

async function revokeAssignment(
  q: Queryable,
  assignmentId: string,
  revokedBy: string,
  reason: string,
  now: Date,
): Promise<void> {
  await q.query(
    `UPDATE role_assignments SET revoked_by = $2, revoked_at = $3, revoke_reason = $4
     WHERE id = $1 AND revoked_at IS NULL`,
    [assignmentId, revokedBy, now, reason],
  );
}

async function ensureAnotherOrganizationOwner(
  q: Queryable,
  organizationId: string,
  leavingAssignmentIds: string[],
): Promise<void> {
  const { rows } = await q.query<{ owners: number }>(
    `SELECT COUNT(*)::int AS owners FROM role_assignments
     WHERE organization_id = $1 AND business_unit_id IS NULL AND project_id IS NULL
       AND role = 'owner' AND revoked_at IS NULL AND id <> ALL($2::uuid[])`,
    [organizationId, leavingAssignmentIds],
  );
  if ((rows[0]?.owners ?? 0) === 0) {
    throw new ConflictError("An organization must keep at least one owner");
  }
}

function requireManagerOf(callerRank: number, role: Role): void {
  const needed = roleNeededToManage(role);
  if (callerRank < ROLE_RANK[needed]) {
    throw new ForbiddenError(
      `Only an ${needed} can assign, change, or remove the ${role} role`,
    );
  }
}

/** Registers a person or agent. Called by sign-in and agent setup; grants no access by itself. */
export async function createPrincipal(
  ctx: MemoryNetContext,
  input: { kind: PrincipalKind; displayName: string; githubUserId?: string },
): Promise<Principal> {
  const kind = requireOneOf(input.kind, PRINCIPAL_KINDS, "kind");
  const displayName = requireText(
    input.displayName,
    "displayName",
    NAME_MAX_LENGTH,
  );
  const githubUserId =
    input.githubUserId === undefined
      ? null
      : requireGithubId(input.githubUserId, "githubUserId");
  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const row = await insertReturning<{ id: string }>(
      tx,
      `INSERT INTO principals (kind, display_name, github_user_id, created_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [kind, displayName, githubUserId, now],
      "This GitHub account is already linked to a principal",
    );
    await recordAudit(tx, {
      occurredAt: now,
      actorId: null,
      action: "principal.created",
      targetType: "principal",
      targetId: row.id,
      details: { kind },
    });
    return { id: row.id, kind, displayName, githubUserId };
  });
}

/** Grants a role at one scope, replacing the principal's previous role at that exact scope. */
export async function assignRole(
  ctx: MemoryNetContext,
  callerId: string,
  input: { principalId: string; scope: ScopeRef; role: Role; reason?: string },
): Promise<RoleAssignment> {
  const principalId = requireId(input.principalId, "principalId");
  const scopeRef = requireScopeRef(input.scope);
  const role = requireOneOf(input.role, ROLES, "role");
  const reason = optionalText(input.reason, "reason", REASON_MAX_LENGTH);
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    requireHuman(caller, "manage access");
    const scope = await resolveScope(tx, scopeRef);
    await lockOrganization(tx, scope.organizationId);
    const callerRank = await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.manageMembers,
      "manage access",
    );
    if (principalId === caller.id) {
      throw new ForbiddenError("You cannot change your own role");
    }
    requireManagerOf(callerRank, role);
    const target = await findPrincipal(tx, principalId);
    if (!target) throw new NotFoundError("Principal not found");
    if (target.kind === "agent" && !AGENT_ROLES.includes(role)) {
      throw new ValidationError(
        `Agents can hold only these roles: ${AGENT_ROLES.join(", ")}`,
      );
    }
    const existing = await findActiveAssignment(tx, principalId, scope);
    if (existing) requireManagerOf(callerRank, existing.role);
    if (existing?.role === role) return loadAssignment(tx, existing.id);

    const now = ctx.now();
    if (existing) {
      if (existing.role === "owner" && scope.level === "organization") {
        await ensureAnotherOrganizationOwner(tx, scope.organizationId, [
          existing.id,
        ]);
      }
      await revokeAssignment(
        tx,
        existing.id,
        caller.id,
        reason ?? `Changed to ${role}`,
        now,
      );
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO role_assignments
         (principal_id, organization_id, business_unit_id, project_id, role, granted_by, granted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [principalId, ...assignmentColumns(scope), role, caller.id, now],
    );
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "role.assigned",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      targetType: "principal",
      targetId: principalId,
      reason,
      details: {
        role,
        previousRole: existing?.role ?? null,
        scopeLevel: scope.level,
        scopeId: scopeTargetId(scope),
      },
    });
    return loadAssignment(tx, firstRow(rows).id);
  });
}

/** Removes a role at one scope. Anyone may give up their own role; the last owner may not. */
export async function revokeRole(
  ctx: MemoryNetContext,
  callerId: string,
  input: { principalId: string; scope: ScopeRef; reason: string },
): Promise<void> {
  const principalId = requireId(input.principalId, "principalId");
  const scopeRef = requireScopeRef(input.scope);
  const reason = requireText(input.reason, "reason", REASON_MAX_LENGTH);
  await ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    requireHuman(caller, "manage access");
    const scope = await resolveScope(tx, scopeRef);
    await lockOrganization(tx, scope.organizationId);
    const leaving = principalId === caller.id;
    const callerRank = leaving
      ? await effectiveRank(tx, caller, scope)
      : await requireRole(
          tx,
          caller,
          scope,
          MINIMUM_ROLE.manageMembers,
          "manage access",
        );
    if (callerRank === 0) throw scopeNotFound(scope.level);
    const existing = await findActiveAssignment(tx, principalId, scope);
    if (!existing) {
      throw new NotFoundError(
        "No active role for this principal at this scope",
      );
    }
    if (!leaving) requireManagerOf(callerRank, existing.role);
    if (existing.role === "owner" && scope.level === "organization") {
      await ensureAnotherOrganizationOwner(tx, scope.organizationId, [
        existing.id,
      ]);
    }
    const now = ctx.now();
    await revokeAssignment(tx, existing.id, caller.id, reason, now);
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "role.revoked",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      targetType: "principal",
      targetId: principalId,
      reason,
      details: {
        role: existing.role,
        scopeLevel: scope.level,
        scopeId: scopeTargetId(scope),
      },
    });
  });
}

/** Revokes every role a principal holds anywhere in the organization, in one change. */
export async function removeFromOrganization(
  ctx: MemoryNetContext,
  callerId: string,
  input: { principalId: string; organizationId: string; reason: string },
): Promise<{ revokedCount: number }> {
  const principalId = requireId(input.principalId, "principalId");
  const organizationId = requireId(input.organizationId, "organizationId");
  const reason = requireText(input.reason, "reason", REASON_MAX_LENGTH);
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    requireHuman(caller, "manage access");
    const scope = await resolveScope(tx, {
      level: "organization",
      id: organizationId,
    });
    await lockOrganization(tx, organizationId);
    const leaving = principalId === caller.id;
    const callerRank = leaving
      ? 0
      : await requireRole(
          tx,
          caller,
          scope,
          MINIMUM_ROLE.manageMembers,
          "remove members",
        );
    const { rows: assignments } = await tx.query<{
      id: string;
      role: Role;
      business_unit_id: string | null;
      project_id: string | null;
    }>(
      `SELECT id, role, business_unit_id, project_id FROM role_assignments
       WHERE principal_id = $1 AND organization_id = $2 AND revoked_at IS NULL
       FOR UPDATE`,
      [principalId, organizationId],
    );
    if (assignments.length === 0) {
      if (leaving) throw scopeNotFound("organization");
      return { revokedCount: 0 };
    }
    if (!leaving) {
      for (const assignment of assignments) {
        requireManagerOf(callerRank, assignment.role);
      }
    }
    const organizationOwnerIds = assignments
      .filter(
        (assignment) =>
          assignment.role === "owner" &&
          assignment.business_unit_id === null &&
          assignment.project_id === null,
      )
      .map((assignment) => assignment.id);
    if (organizationOwnerIds.length > 0) {
      await ensureAnotherOrganizationOwner(
        tx,
        organizationId,
        organizationOwnerIds,
      );
    }
    const now = ctx.now();
    for (const assignment of assignments) {
      await revokeAssignment(tx, assignment.id, caller.id, reason, now);
    }
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "member.removed",
      organizationId,
      targetType: "principal",
      targetId: principalId,
      reason,
      details: { revokedCount: assignments.length },
    });
    return { revokedCount: assignments.length };
  });
}

/** Active roles granted directly at this scope. Inherited roles appear at their own scope. */
export async function listRoleAssignments(
  ctx: MemoryNetContext,
  callerId: string,
  scopeRef: ScopeRef,
): Promise<RoleAssignment[]> {
  const ref = requireScopeRef(scopeRef);
  const caller = await requireCaller(ctx.db, callerId);
  const scope = await resolveScope(ctx.db, ref);
  await requireRole(
    ctx.db,
    caller,
    scope,
    MINIMUM_ROLE.manageMembers,
    "view access",
  );
  const { rows } = await ctx.db.query<AssignmentRow>(
    `${ASSIGNMENT_SELECT}
     WHERE ra.organization_id = $1
       AND ra.business_unit_id IS NOT DISTINCT FROM $2::uuid
       AND ra.project_id IS NOT DISTINCT FROM $3::uuid
       AND ra.revoked_at IS NULL
     ORDER BY pr.display_name, ra.id`,
    assignmentColumns(scope),
  );
  return rows.map(mapAssignment);
}

/** The caller's own active roles, each at the scope where it was granted. */
export async function listOwnRoles(
  ctx: MemoryNetContext,
  callerId: string,
): Promise<OwnRole[]> {
  const caller = await requireCaller(ctx.db, callerId);
  const { rows } = await ctx.db.query<
    AssignmentRow & { scope_name: string; organization_name: string }
  >(
    `SELECT ra.id, ra.principal_id, pr.display_name, pr.kind, ra.organization_id,
            ra.business_unit_id, ra.project_id, ra.role, ra.granted_by, ra.granted_at,
            COALESCE(p.name, b.name, o.name) AS scope_name, o.name AS organization_name
     FROM role_assignments ra
     JOIN principals pr ON pr.id = ra.principal_id
     JOIN organizations o ON o.id = ra.organization_id
     LEFT JOIN business_units b ON b.id = ra.business_unit_id
     LEFT JOIN projects p ON p.id = ra.project_id
     WHERE ra.principal_id = $1 AND ra.revoked_at IS NULL
     ORDER BY o.name, b.name NULLS FIRST, p.name NULLS FIRST, ra.id`,
    [caller.id],
  );
  return rows.map((row) => ({
    scope: mapAssignment(row).scope,
    scopeName: row.scope_name,
    organizationName: row.organization_name,
    role: row.role,
    grantedAt: row.granted_at,
  }));
}

/** Every person and agent, for choosing whom to give a role. Only people who administer a scope may list them. */
export async function listPrincipals(
  ctx: MemoryNetContext,
  callerId: string,
): Promise<Principal[]> {
  const caller = await requireCaller(ctx.db, callerId);
  requireHuman(caller, "list people and agents");
  const { rows: administered } = await ctx.db.query(
    `SELECT 1 FROM role_assignments ra JOIN roles r ON r.name = ra.role
     WHERE ra.principal_id = $1 AND ra.revoked_at IS NULL AND r.rank >= $2
     LIMIT 1`,
    [caller.id, ROLE_RANK[MINIMUM_ROLE.manageMembers]],
  );
  if (administered.length === 0) {
    throw new ForbiddenError(
      `The ${MINIMUM_ROLE.manageMembers} role or higher is required to list people and agents`,
    );
  }
  const { rows } = await ctx.db.query<{
    id: string;
    kind: PrincipalKind;
    display_name: string;
    github_user_id: string | null;
  }>(
    `SELECT id, kind, display_name, github_user_id FROM principals
     ORDER BY kind = 'agent', display_name, id`,
  );
  return rows.map(mapPrincipal);
}

/** People whose role covers the project, so they may own its memories. Needs the contributor role. */
export async function listProjectPeople(
  ctx: MemoryNetContext,
  callerId: string,
  projectId: string,
): Promise<Array<{ id: string; displayName: string; role: Role }>> {
  const id = requireId(projectId, "projectId");
  const caller = await requireCaller(ctx.db, callerId);
  const scope = await resolveScope(ctx.db, { level: "project", id });
  await requireRole(
    ctx.db,
    caller,
    scope,
    MINIMUM_ROLE.propose,
    "choose owners",
  );
  const { rows } = await ctx.db.query<{
    id: string;
    display_name: string;
    rank: number;
  }>(
    `SELECT pr.id, pr.display_name, epr.rank
     FROM effective_project_roles epr JOIN principals pr ON pr.id = epr.principal_id
     WHERE epr.project_id = $1 AND pr.kind = 'human'
     ORDER BY pr.display_name, pr.id`,
    [id],
  );
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    role: roleForRank(row.rank),
  }));
}

/** Names and kinds for principal IDs the caller was already allowed to see, such as a memory's owner. */
export async function describePrincipals(
  q: Queryable,
  ids: readonly string[],
): Promise<Map<string, { displayName: string; kind: PrincipalKind }>> {
  const { rows } = await q.query<{
    id: string;
    kind: PrincipalKind;
    display_name: string;
  }>(
    "SELECT id, kind, display_name FROM principals WHERE id = ANY($1::uuid[])",
    [[...new Set(ids)]],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      { displayName: row.display_name, kind: row.kind },
    ]),
  );
}
