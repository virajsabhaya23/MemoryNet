import type { Queryable } from "./db.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.ts";
import { ROLE_RANK, type PrincipalKind, type Role } from "./roles.ts";
import { requireId, requireOneOf } from "./validation.ts";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  displayName: string;
  githubUserId: string | null;
}

export const SCOPE_LEVELS = [
  "organization",
  "business_unit",
  "project",
] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

/** Caller-supplied pointer to an organization, business unit, or project. */
export interface ScopeRef {
  level: ScopeLevel;
  id: string;
}

/** A resolved scope with its full lineage. */
export interface Scope {
  level: ScopeLevel;
  organizationId: string;
  businessUnitId: string | null;
  projectId: string | null;
}

const SCOPE_LABEL: Readonly<Record<ScopeLevel, string>> = {
  organization: "Organization",
  business_unit: "Business unit",
  project: "Project",
};

const SCOPE_LINEAGE_SQL: Readonly<Record<ScopeLevel, string>> = {
  organization:
    "SELECT id AS organization_id, NULL::uuid AS business_unit_id FROM organizations WHERE id = $1",
  business_unit:
    "SELECT organization_id, id AS business_unit_id FROM business_units WHERE id = $1",
  project:
    "SELECT organization_id, business_unit_id FROM projects WHERE id = $1",
};

// Inheritance lives in the effective_*_roles views (migration 001).
const EFFECTIVE_RANK_SQL: Readonly<Record<ScopeLevel, string>> = {
  organization:
    "SELECT rank FROM effective_organization_roles WHERE principal_id = $1 AND organization_id = $2",
  business_unit:
    "SELECT rank FROM effective_business_unit_roles WHERE principal_id = $1 AND business_unit_id = $2",
  project:
    "SELECT rank FROM effective_project_roles WHERE principal_id = $1 AND project_id = $2",
};

export function requireScopeRef(value: unknown, field = "scope"): ScopeRef {
  if (typeof value !== "object" || value === null) {
    throw new ValidationError(`${field} must be an object with level and id`);
  }
  const { level, id } = value as { level?: unknown; id?: unknown };
  return {
    level: requireOneOf(level, SCOPE_LEVELS, `${field}.level`),
    id: requireId(id, `${field}.id`),
  };
}

export function scopeNotFound(level: ScopeLevel): NotFoundError {
  return new NotFoundError(`${SCOPE_LABEL[level]} not found`);
}

export function scopeTargetId(scope: Scope): string {
  return scope.projectId ?? scope.businessUnitId ?? scope.organizationId;
}

interface PrincipalRow {
  id: string;
  kind: PrincipalKind;
  display_name: string;
  github_user_id: string | null;
}

export function mapPrincipal(row: PrincipalRow): Principal {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    githubUserId: row.github_user_id,
  };
}

export async function findPrincipal(
  q: Queryable,
  id: string,
): Promise<Principal | null> {
  const { rows } = await q.query<PrincipalRow>(
    "SELECT id, kind, display_name, github_user_id FROM principals WHERE id = $1",
    [id],
  );
  return rows[0] ? mapPrincipal(rows[0]) : null;
}

/** Loads the caller. Unknown callers are refused, never treated as anonymous. */
export async function requireCaller(
  q: Queryable,
  callerId: unknown,
): Promise<Principal> {
  const caller = await findPrincipal(q, requireId(callerId, "callerId"));
  if (!caller) throw new ForbiddenError("Caller is not a registered principal");
  return caller;
}

export function requireHuman(caller: Principal, action: string): void {
  if (caller.kind !== "human")
    throw new ForbiddenError(`Agents cannot ${action}`);
}

export async function resolveScope(
  q: Queryable,
  ref: ScopeRef,
): Promise<Scope> {
  const { rows } = await q.query<{
    organization_id: string;
    business_unit_id: string | null;
  }>(SCOPE_LINEAGE_SQL[ref.level], [ref.id]);
  const row = rows[0];
  if (!row) throw scopeNotFound(ref.level);
  return {
    level: ref.level,
    organizationId: row.organization_id,
    businessUnitId: row.business_unit_id,
    projectId: ref.level === "project" ? ref.id : null,
  };
}

/** Highest active role rank covering the scope, including inherited roles. 0 means no access. */
export async function effectiveRank(
  q: Queryable,
  caller: Principal,
  scope: Scope,
): Promise<number> {
  const { rows } = await q.query<{ rank: number }>(
    EFFECTIVE_RANK_SQL[scope.level],
    [caller.id, scopeTargetId(scope)],
  );
  return rows[0]?.rank ?? 0;
}

/** Callers with no role at the scope get "not found", so other teams' scopes stay invisible. */
export async function requireRole(
  q: Queryable,
  caller: Principal,
  scope: Scope,
  minimum: Role,
  action: string,
): Promise<number> {
  const rank = await effectiveRank(q, caller, scope);
  if (rank === 0) throw scopeNotFound(scope.level);
  if (rank < ROLE_RANK[minimum]) {
    throw new ForbiddenError(
      `The ${minimum} role or higher is required to ${action}`,
    );
  }
  return rank;
}

/** Serializes membership changes inside one organization, such as removing the last owner. */
export async function lockOrganization(
  q: Queryable,
  organizationId: string,
): Promise<void> {
  await q.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [
    organizationId,
  ]);
}

export async function hasFreshRepositoryAccess(
  q: Queryable,
  principalId: string,
  provider: string,
  externalRepositoryId: string,
  freshSince: Date,
): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM repository_access
     WHERE principal_id = $1 AND provider = $2 AND external_repository_id = $3
       AND can_read AND observed_at >= $4`,
    [principalId, provider, externalRepositoryId, freshSince],
  );
  return rows.length > 0;
}
