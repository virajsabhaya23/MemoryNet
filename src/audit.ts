import type { Queryable } from "./db.ts";

export interface AuditEntry {
  occurredAt: Date;
  /** Null for system actions, such as repository changes reported by the provider. */
  actorId: string | null;
  action: string;
  organizationId?: string | null;
  projectId?: string | null;
  targetType: string;
  targetId: string;
  reason?: string | null;
  details?: Record<string, string | number | boolean | null>;
}

/** Records an attributable change. Pass identifiers and labels only; never content or credentials. */
export async function recordAudit(
  q: Queryable,
  entry: AuditEntry,
): Promise<void> {
  await q.query(
    `INSERT INTO audit_events
       (occurred_at, actor_id, action, organization_id, project_id, target_type, target_id, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      entry.occurredAt,
      entry.actorId,
      entry.action,
      entry.organizationId ?? null,
      entry.projectId ?? null,
      entry.targetType,
      entry.targetId,
      entry.reason ?? null,
      JSON.stringify(entry.details ?? {}),
    ],
  );
}
