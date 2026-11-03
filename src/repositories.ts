import {
  findPrincipal,
  requireCaller,
  requireHuman,
  requireRole,
  resolveScope,
} from "./access.ts";
import { recordAudit } from "./audit.ts";
import type { MemoryNetContext } from "./context.ts";
import { firstRow, insertReturning } from "./db.ts";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import { MINIMUM_ROLE } from "./roles.ts";
import {
  optionalDate,
  requireBoolean,
  requireGithubFullName,
  requireGithubId,
  requireId,
  requireOneOf,
  requireText,
} from "./validation.ts";

export const PROVIDERS = ["github"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface RepositoryConnection {
  id: string;
  projectId: string;
  provider: Provider;
  externalRepositoryId: string;
  fullName: string;
  connectedBy: string;
  connectedAt: Date;
  /** Null while connected, and also when the system disconnected the repository. */
  disconnectedBy: string | null;
  disconnectedAt: Date | null;
  disconnectReason: string | null;
}

const REASON_MAX_LENGTH = 500;

const CONNECTION_COLUMNS = `id, project_id, provider, external_repository_id, full_name,
  connected_by, connected_at, disconnected_by, disconnected_at, disconnect_reason`;

interface ConnectionRow {
  id: string;
  project_id: string;
  provider: Provider;
  external_repository_id: string;
  full_name: string;
  connected_by: string;
  connected_at: Date;
  disconnected_by: string | null;
  disconnected_at: Date | null;
  disconnect_reason: string | null;
}

function mapConnection(row: ConnectionRow): RepositoryConnection {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    externalRepositoryId: row.external_repository_id,
    fullName: row.full_name,
    connectedBy: row.connected_by,
    connectedAt: row.connected_at,
    disconnectedBy: row.disconnected_by,
    disconnectedAt: row.disconnected_at,
    disconnectReason: row.disconnect_reason,
  };
}

function repositoryKey(
  provider: Provider,
  externalRepositoryId: string,
): string {
  return `${provider}:${externalRepositoryId}`;
}

function requireRepository(input: {
  provider: unknown;
  externalRepositoryId: unknown;
}): { provider: Provider; externalRepositoryId: string } {
  return {
    provider: requireOneOf(input.provider, PROVIDERS, "provider"),
    externalRepositoryId: requireGithubId(
      input.externalRepositoryId,
      "externalRepositoryId",
    ),
  };
}

/** Links a repository to a project. A repository can belong to only one project at a time. */
export async function connectRepository(
  ctx: MemoryNetContext,
  callerId: string,
  input: {
    projectId: string;
    provider: Provider;
    externalRepositoryId: string;
    fullName: string;
  },
): Promise<RepositoryConnection> {
  const projectId = requireId(input.projectId, "projectId");
  const { provider, externalRepositoryId } = requireRepository(input);
  const fullName = requireGithubFullName(input.fullName, "fullName");
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    requireHuman(caller, "connect repositories");
    const scope = await resolveScope(tx, { level: "project", id: projectId });
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.manageRepositories,
      "connect repositories",
    );
    const now = ctx.now();
    const row = await insertReturning<ConnectionRow>(
      tx,
      `INSERT INTO repository_connections
         (project_id, provider, external_repository_id, full_name, connected_by, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${CONNECTION_COLUMNS}`,
      [projectId, provider, externalRepositoryId, fullName, caller.id, now],
      "This repository is already connected to a project",
    );
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "repository.connected",
      organizationId: scope.organizationId,
      projectId,
      targetType: "repository",
      targetId: repositoryKey(provider, externalRepositoryId),
      details: { fullName, connectionId: row.id },
    });
    return mapConnection(row);
  });
}

/** Unlinks a repository. Its sources, and memories citing them, stop being readable at once. */
export async function disconnectRepository(
  ctx: MemoryNetContext,
  callerId: string,
  input: { connectionId: string; reason: string },
): Promise<RepositoryConnection> {
  const connectionId = requireId(input.connectionId, "connectionId");
  const reason = requireText(input.reason, "reason", REASON_MAX_LENGTH);
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    requireHuman(caller, "disconnect repositories");
    const found = await tx.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM repository_connections WHERE id = $1 FOR UPDATE`,
      [connectionId],
    );
    const connection = found.rows[0];
    if (!connection) throw new NotFoundError("Repository connection not found");
    const scope = await resolveScope(tx, {
      level: "project",
      id: connection.project_id,
    });
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.manageRepositories,
      "disconnect repositories",
    );
    if (connection.disconnected_at !== null) {
      throw new ConflictError("This repository is already disconnected");
    }
    const now = ctx.now();
    const { rows } = await tx.query<ConnectionRow>(
      `UPDATE repository_connections
       SET disconnected_by = $2, disconnected_at = $3, disconnect_reason = $4
       WHERE id = $1
       RETURNING ${CONNECTION_COLUMNS}`,
      [connectionId, caller.id, now, reason],
    );
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "repository.disconnected",
      organizationId: scope.organizationId,
      projectId: connection.project_id,
      targetType: "repository",
      targetId: repositoryKey(
        connection.provider,
        connection.external_repository_id,
      ),
      reason,
      details: { fullName: connection.full_name, connectionId },
    });
    return mapConnection(firstRow(rows));
  });
}

/** Current and past repository connections of a project. */
export async function listRepositoryConnections(
  ctx: MemoryNetContext,
  callerId: string,
  projectId: string,
): Promise<RepositoryConnection[]> {
  const id = requireId(projectId, "projectId");
  const caller = await requireCaller(ctx.db, callerId);
  const scope = await resolveScope(ctx.db, { level: "project", id });
  await requireRole(
    ctx.db,
    caller,
    scope,
    MINIMUM_ROLE.manageRepositories,
    "view repository connections",
  );
  const { rows } = await ctx.db.query<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM repository_connections
     WHERE project_id = $1 ORDER BY connected_at, id`,
    [id],
  );
  return rows.map(mapConnection);
}

/** Repositories connected to the project now, for choosing where evidence comes from. Needs the contributor role. */
export async function listConnectedRepositories(
  ctx: MemoryNetContext,
  callerId: string,
  projectId: string,
): Promise<
  Array<{ provider: Provider; externalRepositoryId: string; fullName: string }>
> {
  const id = requireId(projectId, "projectId");
  const caller = await requireCaller(ctx.db, callerId);
  const scope = await resolveScope(ctx.db, { level: "project", id });
  await requireRole(ctx.db, caller, scope, MINIMUM_ROLE.propose, "record sources");
  const { rows } = await ctx.db.query<{
    provider: Provider;
    external_repository_id: string;
    full_name: string;
  }>(
    `SELECT provider, external_repository_id, full_name FROM repository_connections
     WHERE project_id = $1 AND disconnected_at IS NULL ORDER BY full_name`,
    [id],
  );
  return rows.map((row) => ({
    provider: row.provider,
    externalRepositoryId: row.external_repository_id,
    fullName: row.full_name,
  }));
}

/** Trusted system entry point for verified provider removal events. Never expose to user or agent credentials. */
export async function handleRepositoryRemoved(
  ctx: MemoryNetContext,
  input: { provider: Provider; externalRepositoryId: string; reason: string },
): Promise<{ disconnected: boolean }> {
  const { provider, externalRepositoryId } = requireRepository(input);
  const reason = requireText(input.reason, "reason", REASON_MAX_LENGTH);
  return ctx.db.transaction(async (tx) => {
    const now = ctx.now();
    const { rows } = await tx.query<{
      id: string;
      project_id: string;
      full_name: string;
      organization_id: string;
    }>(
      `UPDATE repository_connections rc
       SET disconnected_at = $3, disconnect_reason = $4
       FROM projects p
       WHERE p.id = rc.project_id
         AND rc.provider = $1 AND rc.external_repository_id = $2
         AND rc.disconnected_at IS NULL
       RETURNING rc.id, rc.project_id, rc.full_name, p.organization_id`,
      [provider, externalRepositoryId, now, reason],
    );
    const connection = rows[0];
    if (!connection) return { disconnected: false };
    await recordAudit(tx, {
      occurredAt: now,
      actorId: null,
      action: "repository.disconnected",
      organizationId: connection.organization_id,
      projectId: connection.project_id,
      targetType: "repository",
      targetId: repositoryKey(provider, externalRepositoryId),
      reason,
      details: { fullName: connection.full_name, connectionId: connection.id },
    });
    return { disconnected: true };
  });
}

/** Trusted system entry point for provider access reports. Never expose to user or agent credentials. */
export async function recordRepositoryAccess(
  ctx: MemoryNetContext,
  input: {
    principalId: string;
    provider: Provider;
    externalRepositoryId: string;
    canRead: boolean;
    observedAt?: Date;
  },
): Promise<{ applied: boolean }> {
  const principalId = requireId(input.principalId, "principalId");
  const { provider, externalRepositoryId } = requireRepository(input);
  const canRead = requireBoolean(input.canRead, "canRead");
  const now = ctx.now();
  const observedAt = optionalDate(input.observedAt, "observedAt") ?? now;
  if (observedAt.getTime() > now.getTime()) {
    throw new ValidationError("observedAt cannot be in the future");
  }
  return ctx.db.transaction(async (tx) => {
    if (!(await findPrincipal(tx, principalId))) {
      throw new NotFoundError("Principal not found");
    }
    const current = await tx.query<{ can_read: boolean; observed_at: Date }>(
      `SELECT can_read, observed_at FROM repository_access
       WHERE principal_id = $1 AND provider = $2 AND external_repository_id = $3
       FOR UPDATE`,
      [principalId, provider, externalRepositoryId],
    );
    const previous = current.rows[0];
    if (previous && previous.observed_at.getTime() > observedAt.getTime()) {
      return { applied: false };
    }
    await tx.query(
      `INSERT INTO repository_access
         (principal_id, provider, external_repository_id, can_read, observed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (principal_id, provider, external_repository_id)
       DO UPDATE SET can_read = EXCLUDED.can_read, observed_at = EXCLUDED.observed_at`,
      [principalId, provider, externalRepositoryId, canRead, observedAt],
    );
    if (!previous || previous.can_read !== canRead) {
      const connected = await tx.query<{
        project_id: string;
        organization_id: string;
      }>(
        `SELECT rc.project_id, p.organization_id
         FROM repository_connections rc JOIN projects p ON p.id = rc.project_id
         WHERE rc.provider = $1 AND rc.external_repository_id = $2
           AND rc.disconnected_at IS NULL`,
        [provider, externalRepositoryId],
      );
      await recordAudit(tx, {
        occurredAt: now,
        actorId: null,
        action: canRead
          ? "repository_access.granted"
          : "repository_access.removed",
        organizationId: connected.rows[0]?.organization_id ?? null,
        projectId: connected.rows[0]?.project_id ?? null,
        targetType: "principal",
        targetId: principalId,
        details: {
          repository: repositoryKey(provider, externalRepositoryId),
          observedAt: observedAt.toISOString(),
        },
      });
    }
    return { applied: true };
  });
}
