import {
  requireCaller,
  requireHuman,
  requireRole,
  requireScopeRef,
  resolveScope,
  scopeTargetId,
  type ScopeRef,
} from "./access.ts";
import { recordAudit } from "./audit.ts";
import type { ContentFlag } from "./content-checks.ts";
import type { MemoryNetContext } from "./context.ts";
import { firstRow } from "./db.ts";
import {
  readableMemories,
  type CaptureMethod,
  type MemoryStatus,
  type MemoryType,
} from "./knowledge.ts";
import type { Provider } from "./repositories.ts";
import { MINIMUM_ROLE, type PrincipalKind } from "./roles.ts";

export const EXPORT_FORMAT = "memorynet.knowledge-export";
/** Version3 preserves reviewed applicability and lifecycle generation; version2 added source capture metadata. */
export const EXPORT_FORMAT_VERSION = 3;

const COVERAGE =
  "Approved memories in this organizational scope whose evidence and reviewed applicability repository the exporter could read at export time. Includes all readable branches and validity intervals: inspect applicability before use; this is not an active agent context response. Proposals, rejected proposals, roles, and repository access are not included.";

/** Plain JSON that other tools can read without MemoryNet. Dates are ISO 8601 strings. */
export interface KnowledgeExport {
  format: typeof EXPORT_FORMAT;
  formatVersion: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;
  exportedBy: string;
  scope: ScopeRef;
  /** What the export leaves out, so a partial export is not mistaken for a complete one. */
  coverage: string;
  organization: { id: string; slug: string; name: string };
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    businessUnit: { id: string; slug: string; name: string };
  }>;
  principals: Array<{ id: string; kind: PrincipalKind; displayName: string }>;
  sources: Array<{
    id: string;
    projectId: string;
    provider: Provider;
    externalRepositoryId: string;
    reference: string;
    url: string;
    revision: string | null;
    excerpt: string;
    captureMethod: CaptureMethod;
    /** Null when the GitHub App captured the source. */
    capturedBy: string | null;
    capturedAt: string;
    flags: ContentFlag[];
  }>;
  memories: Array<{
    id: string;
    projectId: string;
    ownerId: string;
    status: MemoryStatus;
    statusGeneration: number;
    applicability: { repositoryId: string; branch: string; validFrom: string; validUntil: string | null } | null;
    revision: number;
    type: MemoryType;
    title: string;
    content: string;
    proposalId: string;
    proposedBy: string;
    approvedBy: string;
    approvedAt: string;
    evidenceSourceIds: string[];
  }>;
}

interface ExportSourceRow {
  id: string;
  project_id: string;
  provider: Provider;
  external_repository_id: string;
  reference: string;
  url: string;
  revision: string | null;
  excerpt: string;
  captured_by: string | null;
  captured_at: Date;
  capture_method: CaptureMethod;
  content_flags: ContentFlag[];
}

interface ExportProjectRow {
  id: string;
  slug: string;
  name: string;
  business_unit_id: string;
  business_unit_slug: string;
  business_unit_name: string;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Exports approved knowledge as portable JSON, so it outlasts any AI model or tool.
 * Only people with the administrator role or higher may export, and each memory still follows the read rules.
 */
export async function exportKnowledge(
  ctx: MemoryNetContext,
  callerId: string,
  input: { scope: ScopeRef },
): Promise<KnowledgeExport> {
  const scopeRef = requireScopeRef(input.scope);
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    requireHuman(caller, "export knowledge");
    const scope = await resolveScope(tx, scopeRef);
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.exportKnowledge,
      "export knowledge",
    );
    const memories = await readableMemories(tx, ctx, caller, scopeRef, null);
    const sources = await tx.query<ExportSourceRow>(
      `SELECT id, project_id, provider, external_repository_id, reference, url, revision,
              excerpt, captured_by, captured_at, capture_method, content_flags
       FROM sources WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [
        sortedUnique(
          memories.flatMap((memory) => memory.evidence.map((e) => e.sourceId)),
        ),
      ],
    );
    const principals = await tx.query<{
      id: string;
      kind: PrincipalKind;
      display_name: string;
    }>(
      "SELECT id, kind, display_name FROM principals WHERE id = ANY($1::uuid[]) ORDER BY id",
      [
        sortedUnique([
          caller.id,
          ...memories.flatMap((m) => [m.ownerId, m.proposedBy, m.approvedBy]),
          ...sources.rows.flatMap((source) =>
            source.captured_by === null ? [] : [source.captured_by],
          ),
        ]),
      ],
    );
    const organization = await tx.query<{
      id: string;
      slug: string;
      name: string;
    }>("SELECT id, slug, name FROM organizations WHERE id = $1", [
      scope.organizationId,
    ]);
    const projects = await tx.query<ExportProjectRow>(
      `SELECT p.id, p.slug, p.name, b.id AS business_unit_id,
              b.slug AS business_unit_slug, b.name AS business_unit_name
       FROM projects p JOIN business_units b ON b.id = p.business_unit_id
       WHERE p.id = ANY($1::uuid[])
       ORDER BY b.slug, p.slug`,
      [sortedUnique(memories.map((memory) => memory.projectId))],
    );
    const now = ctx.now();
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "knowledge.exported",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      targetType: scope.level,
      targetId: scopeTargetId(scope),
      details: {
        memoryCount: memories.length,
        sourceCount: sources.rows.length,
      },
    });
    return {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: now.toISOString(),
      exportedBy: caller.id,
      scope: scopeRef,
      coverage: COVERAGE,
      organization: firstRow(organization.rows),
      projects: projects.rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        businessUnit: {
          id: row.business_unit_id,
          slug: row.business_unit_slug,
          name: row.business_unit_name,
        },
      })),
      principals: principals.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        displayName: row.display_name,
      })),
      sources: sources.rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        provider: row.provider,
        externalRepositoryId: row.external_repository_id,
        reference: row.reference,
        url: row.url,
        revision: row.revision,
        excerpt: row.excerpt,
        captureMethod: row.capture_method,
        capturedBy: row.captured_by,
        capturedAt: row.captured_at.toISOString(),
        flags: row.content_flags,
      })),
      memories: memories.map((memory) => ({
        id: memory.id,
        projectId: memory.projectId,
        ownerId: memory.ownerId,
        status: memory.status,
        statusGeneration: memory.statusGeneration,
        applicability: memory.applicability === null ? null : {
          repositoryId: memory.applicability.repositoryId, branch: memory.applicability.branch,
          validFrom: memory.applicability.validFrom.toISOString(), validUntil: memory.applicability.validUntil?.toISOString() ?? null,
        },
        revision: memory.revision,
        type: memory.type,
        title: memory.title,
        content: memory.content,
        proposalId: memory.proposalId,
        proposedBy: memory.proposedBy,
        approvedBy: memory.approvedBy,
        approvedAt: memory.approvedAt.toISOString(),
        evidenceSourceIds: memory.evidence.map((e) => e.sourceId),
      })),
    };
  });
}
