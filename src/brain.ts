import { requireCaller, requireHuman, requireRole, resolveScope } from "./access.ts";
import type { MemoryNetContext } from "./context.ts";
import { ValidationError } from "./errors.ts";
import { listMemories, listReviewQueue, type Memory } from "./knowledge.ts";
import { getNetwork, type NetworkNode } from "./network.ts";
import { requireId } from "./validation.ts";
import { listWork } from "./work.ts";

export type BrainFindingKind =
  | "stale_work"
  | "warning_nodes"
  | "flagged_nodes"
  | "uncited_sources"
  | "expired_applicability"
  | "pending_reviews";

export interface BrainFinding {
  kind: BrainFindingKind;
  /** Null for organization-wide findings such as the review queue. */
  projectId: string | null;
  projectName: string | null;
  count: number;
  href: string;
  label: string;
}

function warningsOf(node: NetworkNode): number {
  const details = node.details as { warnings?: string[] };
  return details.warnings?.length ?? 0;
}

function flagsOf(node: NetworkNode): number {
  const details = node.details as { flags?: string[] };
  return details.flags?.length ?? 0;
}

/**
 * Deterministic brain health: what needs a person, computed only from records
 * the caller may already read. No model is involved and nothing is changed.
 */
export async function analyzeBrainHealth(
  ctx: MemoryNetContext,
  callerId: string,
  input: { organizationId: string; projectId?: string },
): Promise<BrainFinding[]> {
  const organizationId = requireId(input.organizationId, "organizationId");
  const graph = await getNetwork(ctx, callerId, organizationId, { includeUncitedSources: true });
  const findings: BrainFinding[] = [];
  const projects = graph.clusters.filter(
    (cluster) => cluster.level === "project" && (input.projectId === undefined || cluster.recordId === input.projectId),
  );
  const projectName = new Map(projects.map((cluster) => [cluster.id, cluster.name]));
  const projectRecord = new Map(projects.map((cluster) => [cluster.id, cluster.recordId]));

  const cited = new Set(graph.edges.filter((edge) => edge.relation === "cites").map((edge) => edge.to));
  const byProject = (kind: BrainFindingKind) => {
    const counts = new Map<string, number>();
    return {
      add(clusterId: string) {
        if (!projectRecord.has(clusterId)) return;
        counts.set(clusterId, (counts.get(clusterId) ?? 0) + 1);
      },
      emit(hrefFor: (recordId: string) => string, labelFor: (name: string, count: number) => string) {
        for (const [clusterId, count] of counts) {
          const recordId = projectRecord.get(clusterId)!;
          findings.push({
            kind,
            projectId: recordId,
            projectName: projectName.get(clusterId) ?? null,
            count,
            href: hrefFor(recordId),
            label: labelFor(projectName.get(clusterId) ?? "Project", count),
          });
        }
      },
    };
  };

  const warnings = byProject("warning_nodes");
  const flagged = byProject("flagged_nodes");
  const uncited = byProject("uncited_sources");
  for (const node of graph.nodes) {
    if (warningsOf(node) > 0) warnings.add(node.clusterId);
    if (flagsOf(node) > 0) flagged.add(node.clusterId);
    if (node.kind === "source" && !cited.has(node.id)) uncited.add(node.clusterId);
  }
  warnings.emit(
    (recordId) => `/orgs/${organizationId}/network`,
    (name, count) => `${count} ${count === 1 ? "record needs" : "records need"} a look in ${name}`,
  );
  flagged.emit(
    (recordId) => `/orgs/${organizationId}/network`,
    (name, count) => `${count} flagged ${count === 1 ? "record" : "records"} in ${name}`,
  );
  uncited.emit(
    (recordId) => `/projects/${recordId}#evidence`,
    (name, count) => `${count} uncited ${count === 1 ? "source" : "sources"} in ${name}`,
  );

  for (const cluster of projects) {
    const recordId = cluster.recordId;
    const work = await listWork(ctx, callerId, recordId).catch(() => []);
    const stale = work.filter((item) => item.contextStatus === "review_needed").length;
    if (stale > 0) {
      findings.push({
        kind: "stale_work",
        projectId: recordId,
        projectName: cluster.name,
        count: stale,
        href: `/projects/${recordId}/work`,
        label: `${stale} work ${stale === 1 ? "item needs" : "items need"} review in ${cluster.name}`,
      });
    }
    const memories = await listMemories(ctx, callerId, {
      scope: { level: "project", id: recordId },
      limit: 200,
    }).catch(() => []);
    const expired = memories.filter(
      (memory) => memory.applicability?.validUntil !== null && memory.applicability?.validUntil !== undefined && memory.applicability.validUntil <= ctx.now(),
    ).length;
    if (expired > 0) {
      findings.push({
        kind: "expired_applicability",
        projectId: recordId,
        projectName: cluster.name,
        count: expired,
        href: `/projects/${recordId}#current-knowledge`,
        label: `${expired} ${expired === 1 ? "memory is" : "memories are"} outside its applicability window in ${cluster.name}`,
      });
    }
  }

  if (input.projectId === undefined) {
    const pending = (await listReviewQueue(ctx, callerId, { limit: 200 }).catch(() => [])).length;
    if (pending > 0) {
      findings.push({
        kind: "pending_reviews",
        projectId: null,
        projectName: null,
        count: pending,
        href: "/review",
        label: `${pending} ${pending === 1 ? "proposal" : "proposals"} waiting for review`,
      });
    }
  }
  return findings;
}

export interface BrainBrief {
  id: string;
  projectId: string;
  requesterId: string;
  agentId: string;
  model: string;
  content: string;
  citations: string[];
  createdAt: Date;
}

interface BrainBriefRow {
  id: string;
  project_id: string;
  requester_id: string;
  agent_id: string;
  model: string;
  content: string;
  citations: string[];
  created_at: Date;
}

function mapBrief(row: BrainBriefRow): BrainBrief {
  return {
    id: row.id,
    projectId: row.project_id,
    requesterId: row.requester_id,
    agentId: row.agent_id,
    model: row.model,
    content: row.content,
    citations: row.citations ?? [],
    createdAt: row.created_at,
  };
}

/** Current approved knowledge a brief may draw on, checked for a human contributor. */
export async function buildBriefInput(
  ctx: MemoryNetContext,
  callerId: string,
  projectId: string,
): Promise<{ projectId: string; memories: Memory[] }> {
  const caller = await requireCaller(ctx.db, callerId);
  requireHuman(caller, "request a brain brief");
  const id = requireId(projectId, "projectId");
  const scope = await resolveScope(ctx.db, { level: "project", id });
  await requireRole(ctx.db, caller, scope, "contributor", "request a brain brief");
  const memories = await listMemories(ctx, caller.id, { scope: { level: "project", id }, limit: 50 });
  return { projectId: id, memories };
}

/** Stores a brief. Citations that do not resolve to readable project memories are dropped. */
export async function createBrainBrief(
  ctx: MemoryNetContext,
  callerId: string,
  input: { projectId: string; agentId: string; model: string; content: string; citations: string[] },
): Promise<BrainBrief> {
  const { projectId, memories } = await buildBriefInput(ctx, callerId, input.projectId);
  const content = input.content.trim();
  if (content.length === 0 || content.length > 20_000) {
    throw new ValidationError("A brain brief must be between 1 and 20000 characters");
  }
  const readable = new Set(memories.map((memory) => memory.id));
  const citations = [...new Set(input.citations)].filter((id) => readable.has(id));
  const agentId = requireId(input.agentId, "agentId");
  const { rows } = await ctx.db.query<BrainBriefRow>(
    `INSERT INTO brain_briefs (project_id, requester_id, agent_id, model, content, citations, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
    [projectId, callerId, agentId, input.model, content, JSON.stringify(citations), ctx.now()],
  );
  return mapBrief(rows[0]!);
}

export async function listBrainBriefs(
  ctx: MemoryNetContext,
  callerId: string,
  projectId: string,
): Promise<BrainBrief[]> {
  const caller = await requireCaller(ctx.db, callerId);
  const id = requireId(projectId, "projectId");
  const scope = await resolveScope(ctx.db, { level: "project", id });
  await requireRole(ctx.db, caller, scope, "reader", "read brain briefs");
  const { rows } = await ctx.db.query<BrainBriefRow>(
    "SELECT * FROM brain_briefs WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20",
    [id],
  );
  return rows.map(mapBrief);
}
