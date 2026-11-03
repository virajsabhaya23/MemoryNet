import {
  effectiveRank,
  requireCaller,
  requireHuman,
  requireRole,
  resolveScope,
  scopeNotFound,
} from "./access.ts";
import { recordAudit } from "./audit.ts";
import type { MemoryNetContext } from "./context.ts";
import { insertReturning, type Queryable } from "./db.ts";
import { MINIMUM_ROLE, roleForRank, type Role } from "./roles.ts";
import { requireId, requireSlug, requireText } from "./validation.ts";

export interface Organization {
  id: string;
  slug: string;
  name: string;
  createdBy: string;
  createdAt: Date;
}

export interface BusinessUnit {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  createdBy: string;
  createdAt: Date;
}

export interface Project {
  id: string;
  organizationId: string;
  businessUnitId: string;
  slug: string;
  name: string;
  createdBy: string;
  createdAt: Date;
}

/** Parts of one organization the caller can see, with the caller's role at each level. */
export interface OrganizationTree {
  organization: Organization;
  /** Null when the caller only holds roles on parts of the organization. */
  role: Role | null;
  businessUnits: Array<
    BusinessUnit & {
      role: Role | null;
      projects: Array<Project & { role: Role }>;
    }
  >;
}

const NAME_MAX_LENGTH = 120;

interface OrganizationRow {
  id: string;
  slug: string;
  name: string;
  created_by: string;
  created_at: Date;
}

interface BusinessUnitRow extends OrganizationRow {
  organization_id: string;
}

interface ProjectRow extends BusinessUnitRow {
  business_unit_id: string;
}

function mapOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapBusinessUnit(row: BusinessUnitRow): BusinessUnit {
  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    organizationId: row.organization_id,
    businessUnitId: row.business_unit_id,
    slug: row.slug,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Creates an organization and makes the caller its first owner. */
export async function createOrganization(
  ctx: MemoryNetContext,
  callerId: string,
  input: { slug: string; name: string },
): Promise<Organization> {
  const slug = requireSlug(input.slug, "slug");
  const name = requireText(input.name, "name", NAME_MAX_LENGTH);
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    requireHuman(caller, "create organizations");
    const now = ctx.now();
    const row = await insertReturning<OrganizationRow>(
      tx,
      `INSERT INTO organizations (slug, name, created_by, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, slug, name, created_by, created_at`,
      [slug, name, caller.id, now],
      "An organization with this slug already exists",
    );
    await tx.query(
      `INSERT INTO role_assignments (principal_id, organization_id, role, granted_by, granted_at)
       VALUES ($1, $2, 'owner', $1, $3)`,
      [caller.id, row.id, now],
    );
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "organization.created",
      organizationId: row.id,
      targetType: "organization",
      targetId: row.id,
    });
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "role.assigned",
      organizationId: row.id,
      targetType: "principal",
      targetId: caller.id,
      details: {
        role: "owner",
        previousRole: null,
        scopeLevel: "organization",
        scopeId: row.id,
      },
    });
    return mapOrganization(row);
  });
}

export async function createBusinessUnit(
  ctx: MemoryNetContext,
  callerId: string,
  input: { organizationId: string; slug: string; name: string },
): Promise<BusinessUnit> {
  const organizationId = requireId(input.organizationId, "organizationId");
  const slug = requireSlug(input.slug, "slug");
  const name = requireText(input.name, "name", NAME_MAX_LENGTH);
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    const scope = await resolveScope(tx, {
      level: "organization",
      id: organizationId,
    });
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.manageStructure,
      "create business units",
    );
    const now = ctx.now();
    const row = await insertReturning<BusinessUnitRow>(
      tx,
      `INSERT INTO business_units (organization_id, slug, name, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, organization_id, slug, name, created_by, created_at`,
      [organizationId, slug, name, caller.id, now],
      "A business unit with this slug already exists in the organization",
    );
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "business_unit.created",
      organizationId,
      targetType: "business_unit",
      targetId: row.id,
    });
    return mapBusinessUnit(row);
  });
}

export async function createProject(
  ctx: MemoryNetContext,
  callerId: string,
  input: { businessUnitId: string; slug: string; name: string },
): Promise<Project> {
  const businessUnitId = requireId(input.businessUnitId, "businessUnitId");
  const slug = requireSlug(input.slug, "slug");
  const name = requireText(input.name, "name", NAME_MAX_LENGTH);
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    const scope = await resolveScope(tx, {
      level: "business_unit",
      id: businessUnitId,
    });
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.manageStructure,
      "create projects",
    );
    const now = ctx.now();
    const row = await insertReturning<ProjectRow>(
      tx,
      `INSERT INTO projects (organization_id, business_unit_id, slug, name, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, organization_id, business_unit_id, slug, name, created_by, created_at`,
      [scope.organizationId, businessUnitId, slug, name, caller.id, now],
      "A project with this slug already exists in the organization",
    );
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "project.created",
      organizationId: scope.organizationId,
      projectId: row.id,
      targetType: "project",
      targetId: row.id,
    });
    return mapProject(row);
  });
}

/** Names of projects the caller was already allowed to see, such as the projects of listed proposals. */
export async function describeProjects(
  q: Queryable,
  ids: readonly string[],
): Promise<Map<string, { name: string; organizationName: string }>> {
  const { rows } = await q.query<{
    id: string;
    name: string;
    organization_name: string;
  }>(
    `SELECT p.id, p.name, o.name AS organization_name
     FROM projects p JOIN organizations o ON o.id = p.organization_id
     WHERE p.id = ANY($1::uuid[])`,
    [[...new Set(ids)]],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      { name: row.name, organizationName: row.organization_name },
    ]),
  );
}

/** Organizations where the caller holds any role, at any level. */
export async function listOrganizations(
  ctx: MemoryNetContext,
  callerId: string,
): Promise<Organization[]> {
  const caller = await requireCaller(ctx.db, callerId);
  const { rows } = await ctx.db.query<OrganizationRow>(
    `SELECT o.id, o.slug, o.name, o.created_by, o.created_at
     FROM organizations o
     WHERE EXISTS (SELECT 1 FROM effective_organization_roles r
                   WHERE r.principal_id = $1 AND r.organization_id = o.id)
        OR EXISTS (SELECT 1 FROM effective_business_unit_roles r
                   JOIN business_units b ON b.id = r.business_unit_id
                   WHERE r.principal_id = $1 AND b.organization_id = o.id)
        OR EXISTS (SELECT 1 FROM effective_project_roles r
                   JOIN projects p ON p.id = r.project_id
                   WHERE r.principal_id = $1 AND p.organization_id = o.id)
     ORDER BY o.slug`,
    [caller.id],
  );
  return rows.map(mapOrganization);
}

/** Parts of the organization the caller's roles cover; each visible project brings its business unit. */
export async function getOrganizationTree(
  ctx: MemoryNetContext,
  callerId: string,
  organizationId: string,
): Promise<OrganizationTree> {
  const caller = await requireCaller(ctx.db, callerId);
  const id = requireId(organizationId, "organizationId");
  const organization = await ctx.db.query<OrganizationRow>(
    "SELECT id, slug, name, created_by, created_at FROM organizations WHERE id = $1",
    [id],
  );
  const organizationRow = organization.rows[0];
  if (!organizationRow) throw scopeNotFound("organization");
  const organizationRank = await effectiveRank(ctx.db, caller, {
    level: "organization",
    organizationId: id,
    businessUnitId: null,
    projectId: null,
  });
  const units = await ctx.db.query<BusinessUnitRow & { rank: number | null }>(
    `SELECT b.id, b.organization_id, b.slug, b.name, b.created_by, b.created_at, r.rank
     FROM business_units b
     LEFT JOIN effective_business_unit_roles r
       ON r.business_unit_id = b.id AND r.principal_id = $1
     WHERE b.organization_id = $2
     ORDER BY b.slug`,
    [caller.id, id],
  );
  const projects = await ctx.db.query<ProjectRow & { rank: number }>(
    `SELECT p.id, p.organization_id, p.business_unit_id, p.slug, p.name,
            p.created_by, p.created_at, r.rank
     FROM projects p
     JOIN effective_project_roles r ON r.project_id = p.id AND r.principal_id = $1
     WHERE p.organization_id = $2
     ORDER BY p.slug`,
    [caller.id, id],
  );
  const businessUnits = units.rows
    .map((unit) => ({
      ...mapBusinessUnit(unit),
      role: unit.rank === null ? null : roleForRank(unit.rank),
      projects: projects.rows
        .filter((project) => project.business_unit_id === unit.id)
        .map((project) => ({
          ...mapProject(project),
          role: roleForRank(project.rank),
        })),
    }))
    .filter((unit) => unit.role !== null || unit.projects.length > 0);
  if (organizationRank === 0 && businessUnits.length === 0) {
    throw scopeNotFound("organization");
  }
  return {
    organization: mapOrganization(organizationRow),
    role: organizationRank === 0 ? null : roleForRank(organizationRank),
    businessUnits,
  };
}
