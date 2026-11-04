import { requireRepositoryId } from "./repository-identity.ts";
import { requireCaller, requireRole, resolveScope, type Principal } from "./access.ts";
import { mayContainPersonalData, requireNoSecrets } from "./content-checks.ts";
import { accessFreshSince, type MemoryNetContext } from "./context.ts";
import type { Queryable } from "./db.ts";
import { MemoryNetError, UnavailableError, ValidationError } from "./errors.ts";
import {
  READABLE_MEMORIES_SQL,
  SEARCH_DOCUMENT_SQL,
  readableMemoriesByIds,
  requireDecisionApplicabilityAccess,
  requireDecisionBranch,
  type Memory,
  type MemoryType,
} from "./knowledge.ts";
import { parseRelations, pathMatches, pathSpecificity, requirePathPattern, type MemoryRelation, type MemoryRelations } from "./relations.ts";
import { recordRetrieval, type Citation } from "./retrieval.ts";
import { MINIMUM_ROLE } from "./roles.ts";
import { requireId } from "./validation.ts";

/** Bounds on one task-context request and response. Tokens are estimated at four characters each. */
export const TASK_CONTEXT_LIMITS = {
  taskLength: 2000,
  paths: 50,
  defaultTokens: 2000,
  minTokens: 300,
  maxTokens: 8000,
  defaultItems: 10,
  maxItems: 20,
  maxDepth: 2,
  contentLength: 1500,
  compactLength: 240,
  citationsPerItem: 3,
  excerptLength: 300,
} as const;

/** Why an item was included. Every item has at least one reason. */
export type TaskContextReason =
  | { kind: "matched_task" }
  | { kind: "governs_path"; pattern: string; path: string }
  /** Reads as "subject relation object", for example "A depends_on B"; one of them is this item. */
  | { kind: "linked"; subject: string; relation: MemoryRelation; object: string; replacedObject: string | null }
  | { kind: "shared_evidence"; memoryId: string; sourceId: string };

export interface TaskContextItem {
  memoryId: string;
  revision: number;
  type: MemoryType;
  title: string;
  /** Full text up to the limit, or a short preview when the item is compact. */
  content: string;
  shortened: boolean;
  /** True when only a preview fit in the token budget; read the full memory before relying on details. */
  compact: boolean;
  approvedBy: string;
  approvedAt: Date;
  approvals: number;
  /** 0 to 1, relative within this response. */
  score: number;
  reasons: TaskContextReason[];
  paths: string[];
  citations: Citation[];
  moreCitations: number;
}

export interface TaskContextResponse {
  retrievalId: string;
  projectId: string;
  retrievedAt: Date;
  outcome: "results" | "no_results";
  items: TaskContextItem[];
  /**
   * Every reviewed conflict that involves a delivered item, from either side. bothDelivered is false when the budget
   * left one side out; ask again with a larger budget before relying on either.
   */
  conflicts: Array<{ memoryId: string; conflictsWith: string; bothDelivered: boolean }>;
  /** Conflicts left out of the list above by its size limit. */
  moreConflicts: number;
  /**
   * A delivered item links to a memory that was replaced; the link resolves to the current replacement. Check that
   * the delivered guidance still holds.
   */
  changedDependencies: Array<{ memoryId: string; linkedTo: string; replacedBy: string }>;
  /** Changed dependencies left out of the list above by its size limit. */
  moreChangedDependencies: number;
  /** Relevant guidance left out by the item limit or token budget. */
  omitted: number;
  budget: { maxTokens: number; usedTokens: number };
  applicability: { repositoryId: string; branch: string; at: Date } | null;
}

export interface TaskContextInput {
  projectId: string;
  task: string;
  paths?: readonly string[];
  maxTokens?: number;
  maxItems?: number;
  depth?: number;
  applicability?: { repositoryId: string; branch: string };
}

const FORWARD: Readonly<Record<MemoryRelation, number>> = { depends_on: 0.85, refines: 0.7, conflicts_with: 0.9, related: 0.5 };
const BACKWARD: Readonly<Record<MemoryRelation, number>> = { depends_on: 0.5, refines: 0.75, conflicts_with: 0.9, related: 0.5 };
const SHARED_EVIDENCE = 0.45;
const HOP_DECAY = 0.85;
const MIN_SCORE = 0.05;
const MAX_EVIDENCE_FANOUT = 50;
const LINEAGE_ROUNDS = 3;
/** Matches the published response limit, so a widely linked decision can never make a response invalid. */
export const MAX_NOTICES = 40;
const MAX_CONFLICT_PARTNERS = 3;

interface Candidate {
  id: string;
  approvedAt: Date;
  rank: number;
  relations: MemoryRelations;
  sourceIds: string[];
}

interface Edge {
  to: string;
  weight: number;
  reason: TaskContextReason;
}

function whole(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function cut(text: string, max: number): { text: string; shortened: boolean } {
  return text.length <= max ? { text, shortened: false } : { text: `${text.slice(0, max - 1).trimEnd()}…`, shortened: true };
}

const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

/** Every readable, current, in-scope memory with its text rank, relations and cited sources. Nothing else is ever traversed. */
async function loadCandidates(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  projectId: string,
  terms: string,
  scope: { repositoryId: string; branch: string; at: Date } | null,
): Promise<Candidate[]> {
  const scoped = scope
    ? `AND r.applicability->>'repositoryId' = $5 AND r.applicability->>'branch' = $6
       AND (r.applicability->>'validFrom')::timestamptz <= $7
       AND (r.applicability->>'validUntil' IS NULL OR $7 < (r.applicability->>'validUntil')::timestamptz)`
    : "";
  const { rows } = await q.query<{ id: string; approved_at: Date; rank: number; relations: unknown; source_ids: string[] }>(
    `WITH readable AS (${READABLE_MEMORIES_SQL} AND m.project_id = $3 AND m.status = 'approved' ${scoped})
     SELECT readable.id, readable.approved_at, readable.relations,
            CASE WHEN $4 = '' THEN 0 ELSE ts_rank(${SEARCH_DOCUMENT_SQL}, $4::tsquery) END AS rank,
            COALESCE((SELECT array_agg(me.source_id::text ORDER BY me.source_id) FROM memory_evidence me
                      WHERE me.memory_id = readable.id AND me.revision = readable.revision), '{}') AS source_ids
     FROM readable`,
    [caller.id, accessFreshSince(ctx), projectId, terms, ...(scope ? [scope.repositoryId, scope.branch, scope.at] : [])],
  );
  return rows.map((row) => ({ id: row.id, approvedAt: row.approved_at, rank: Number(row.rank), relations: parseRelations(row.relations), sourceIds: row.source_ids }));
}

/** Follows replacements from linked memories that are no longer current to a current, in-scope successor. */
async function resolveReplacements(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  missing: string[],
  inScope: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  let frontier = new Map(missing.map((id) => [id, id]));
  for (let round = 0; round < LINEAGE_ROUNDS && frontier.size > 0; round++) {
    const { rows } = await q.query<{ id: string; status: string; superseded_by: string | null }>(
      `SELECT readable.id, readable.status, readable.superseded_by FROM (${READABLE_MEMORIES_SQL} AND m.id = ANY($3::uuid[])) readable`,
      [caller.id, accessFreshSince(ctx), [...frontier.keys()]],
    );
    const next = new Map<string, string>();
    for (const row of rows) {
      const origin = frontier.get(row.id)!;
      if (row.status !== "superseded" || row.superseded_by === null) continue;
      if (inScope.has(row.superseded_by)) resolved.set(origin, row.superseded_by);
      else next.set(row.superseded_by, origin);
    }
    frontier = next;
  }
  return resolved;
}

function addEdge(adjacency: Map<string, Edge[]>, from: string, edge: Edge): void {
  const list = adjacency.get(from);
  if (list) list.push(edge);
  else adjacency.set(from, [edge]);
}

/**
 * Approved, current guidance for a task: memories matching the task text or governing the given paths,
 * then memories they depend on, refine, conflict with or share evidence with, scored by bounded spreading
 * activation over reviewed relations and packed into a token budget. Only memories the caller may read and
 * that apply to the scope are ever considered, so a relation never reveals or reaches hidden guidance.
 * Every response is recorded as a retrieval receipt.
 */
export async function getTaskContext(ctx: MemoryNetContext, callerId: string, input: TaskContextInput): Promise<TaskContextResponse> {
  const projectId = requireId(input.projectId, "projectId");
  if (typeof input.task !== "string" || input.task.trim() === "" || input.task.length > TASK_CONTEXT_LIMITS.taskLength) {
    throw new ValidationError(`Describe the task in 1 to ${TASK_CONTEXT_LIMITS.taskLength} characters`);
  }
  const task = input.task.trim();
  requireNoSecrets(task, "Task");
  const rawPaths = input.paths ?? [];
  if (!Array.isArray(rawPaths) || rawPaths.length > TASK_CONTEXT_LIMITS.paths) throw new ValidationError(`At most ${TASK_CONTEXT_LIMITS.paths} paths`);
  const paths = [...new Set(rawPaths.map(requirePathPattern))];
  const maxTokens = whole(input.maxTokens, "maxTokens", TASK_CONTEXT_LIMITS.defaultTokens, TASK_CONTEXT_LIMITS.minTokens, TASK_CONTEXT_LIMITS.maxTokens);
  const maxItems = whole(input.maxItems, "maxItems", TASK_CONTEXT_LIMITS.defaultItems, 1, TASK_CONTEXT_LIMITS.maxItems);
  const depth = whole(input.depth, "depth", 1, 0, TASK_CONTEXT_LIMITS.maxDepth);
  const observedAt = ctx.now();
  const scope = input.applicability
    ? { repositoryId: requireRepositoryId(input.applicability.repositoryId, "repositoryId"), branch: requireDecisionBranch(input.applicability.branch), at: observedAt }
    : null;
  const readCtx = { ...ctx, now: () => new Date(observedAt) };
  let allowed: Principal | null = null;
  try {
    const caller = await requireCaller(ctx.db, callerId);
    const projectScope = await resolveScope(ctx.db, { level: "project", id: projectId });
    await requireRole(ctx.db, caller, projectScope, MINIMUM_ROLE.read, "read task context");
    allowed = caller;
    return await ctx.db.transaction(async (tx) => {
      await requireRole(tx, caller, projectScope, MINIMUM_ROLE.read, "read task context");
      if (scope) await requireDecisionApplicabilityAccess(tx, readCtx, caller, projectId, { repositoryId: scope.repositoryId, branch: scope.branch, validFrom: observedAt, validUntil: null });
      const parsed = await tx.query<{ terms: string }>("SELECT replace(plainto_tsquery('english', $1)::text, ' & ', ' | ') AS terms", [task]);
      const terms = parsed.rows[0]?.terms ?? "";
      if (terms === "" && paths.length === 0) {
        throw new ValidationError('Describe the task with at least one word that is not a very common word such as "the", or name the files involved');
      }
      const candidates = await loadCandidates(tx, readCtx, caller, projectId, terms, scope);
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

      // Seeds: text relevance and reviewed path anchors, combined as a probabilistic OR.
      const maxRank = Math.max(0, ...candidates.map((c) => c.rank));
      const score = new Map<string, number>();
      const reasons = new Map<string, TaskContextReason[]>();
      for (const candidate of candidates) {
        const found: TaskContextReason[] = [];
        const text = maxRank > 0 && candidate.rank > 0 ? 0.9 * (candidate.rank / maxRank) : 0;
        if (text > 0) found.push({ kind: "matched_task" });
        let anchored = 0;
        for (const pattern of candidate.relations.paths) {
          const path = paths.find((item) => pathMatches(pattern, item));
          if (path === undefined) continue;
          const strength = 0.75 + 0.25 * Math.min(1, pathSpecificity(pattern) / 40);
          if (strength > anchored) anchored = strength;
          found.push({ kind: "governs_path", pattern, path });
        }
        const seed = 1 - (1 - text) * (1 - anchored);
        if (seed > 0) { score.set(candidate.id, seed); reasons.set(candidate.id, found); }
      }

      // Edges among in-scope readable memories only; replaced link targets resolve to their current successor.
      const linkTargets = candidates.flatMap((c) => c.relations.links.map((link) => link.memoryId)).filter((id) => !byId.has(id));
      const successors = await resolveReplacements(tx, readCtx, caller, [...new Set(linkTargets)], new Set(byId.keys()));
      const adjacency = new Map<string, Edge[]>();
      const changedDependencies: TaskContextResponse["changedDependencies"] = [];
      for (const candidate of candidates) {
        for (const link of candidate.relations.links) {
          const target = byId.has(link.memoryId) ? link.memoryId : successors.get(link.memoryId);
          if (target === undefined || target === candidate.id) continue;
          const replaced = target === link.memoryId ? null : link.memoryId;
          if (replaced) changedDependencies.push({ memoryId: candidate.id, linkedTo: replaced, replacedBy: target });
          const reason: TaskContextReason = { kind: "linked", subject: candidate.id, relation: link.relation, object: target, replacedObject: replaced };
          addEdge(adjacency, candidate.id, { to: target, weight: FORWARD[link.relation], reason });
          addEdge(adjacency, target, { to: candidate.id, weight: BACKWARD[link.relation], reason });
        }
      }
      const citedBy = new Map<string, string[]>();
      for (const candidate of candidates) for (const sourceId of candidate.sourceIds) citedBy.set(sourceId, [...(citedBy.get(sourceId) ?? []), candidate.id]);
      for (const [sourceId, memories] of citedBy) {
        if (memories.length < 2 || memories.length > MAX_EVIDENCE_FANOUT) continue;
        const weight = SHARED_EVIDENCE * Math.min(1, 3 / memories.length);
        for (const a of memories) for (const b of memories) {
          if (a !== b) addEdge(adjacency, a, { to: b, weight, reason: { kind: "shared_evidence", memoryId: a, sourceId } });
        }
      }

      // Bounded spreading activation: keep the strongest path to each memory within `depth` hops.
      let frontier = [...score.keys()];
      for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
        const next = new Set<string>();
        for (const from of frontier) {
          for (const edge of adjacency.get(from) ?? []) {
            const value = score.get(from)! * edge.weight * HOP_DECAY;
            if (value <= (score.get(edge.to) ?? 0)) continue;
            score.set(edge.to, value);
            const own = (reasons.get(edge.to) ?? []).filter((reason) => reason.kind === "matched_task" || reason.kind === "governs_path");
            reasons.set(edge.to, [...own, edge.reason]);
            next.add(edge.to);
          }
        }
        frontier = [...next];
      }

      const ranked = [...score.entries()].filter(([, value]) => value >= MIN_SCORE)
        .sort((a, b) => b[1] - a[1] || byId.get(b[0])!.approvedAt.getTime() - byId.get(a[0])!.approvedAt.getTime() || a[0].localeCompare(b[0]));
      // Conflicts count from either side. A conflicting decision is packed right after its counterpart.
      const conflictPairs: Array<{ a: string; b: string }> = [];
      const partners = new Map<string, Array<{ id: string; reason: TaskContextReason }>>();
      for (const candidate of candidates) {
        for (const link of candidate.relations.links) {
          if (link.relation !== "conflicts_with") continue;
          const target = byId.has(link.memoryId) ? link.memoryId : successors.get(link.memoryId);
          if (target === undefined || target === candidate.id) continue;
          conflictPairs.push({ a: candidate.id, b: target });
          const reason: TaskContextReason = { kind: "linked", subject: candidate.id, relation: "conflicts_with", object: target, replacedObject: target === link.memoryId ? null : link.memoryId };
          partners.set(candidate.id, [...(partners.get(candidate.id) ?? []), { id: target, reason }]);
          partners.set(target, [...(partners.get(target) ?? []), { id: candidate.id, reason }]);
        }
      }
      const head: string[] = [];
      const strongest = (list: Array<{ id: string; reason: TaskContextReason }>) => [...list].sort((a, b) =>
        (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || byId.get(b.id)!.approvedAt.getTime() - byId.get(a.id)!.approvedAt.getTime() || a.id.localeCompare(b.id));
      for (const [id] of ranked.slice(0, maxItems)) {
        if (!head.includes(id)) head.push(id);
        for (const partner of strongest(partners.get(id) ?? []).slice(0, MAX_CONFLICT_PARTNERS)) {
          if (head.includes(partner.id)) continue;
          head.push(partner.id);
          if (!score.has(partner.id)) { score.set(partner.id, score.get(id)! * FORWARD.conflicts_with * HOP_DECAY); reasons.set(partner.id, [partner.reason]); }
        }
      }
      const order = [...new Set([...head, ...ranked.map(([id]) => id)])].slice(0, maxItems + 10);
      const records = new Map<string, Memory>();
      for (const memory of await readableMemoriesByIds(tx, readCtx, caller, order)) {
        if (memory.status === "approved") records.set(memory.id, memory);
      }
      const top = Math.max(...order.map((id) => score.get(id) ?? 0), MIN_SCORE);
      const items: TaskContextItem[] = [];
      let used = 60;
      let omitted = Math.max(0, ranked.length - order.length);
      for (const id of order) {
        const memory = records.get(id);
        if (!memory) continue;
        const mustInclude = head.includes(id) && items.length === 0;
        if (items.length >= Math.max(maxItems, head.length)) { omitted++; continue; }
        const item = (compact: boolean): TaskContextItem => {
          const text = cut(memory.content, compact ? TASK_CONTEXT_LIMITS.compactLength : TASK_CONTEXT_LIMITS.contentLength);
          const cited = compact ? [] : memory.evidence.slice(0, TASK_CONTEXT_LIMITS.citationsPerItem);
          return {
            memoryId: memory.id, revision: memory.revision, type: memory.type, title: memory.title,
            content: text.text, shortened: text.shortened, compact,
            approvedBy: memory.approvedBy, approvedAt: memory.approvedAt, approvals: memory.approvals,
            score: Math.round(((score.get(id) ?? 0) / top) * 1000) / 1000,
            reasons: reasons.get(id) ?? [],
            paths: memory.relations.paths,
            citations: cited.map((e) => {
              const excerpt = cut(e.excerpt, TASK_CONTEXT_LIMITS.excerptLength);
              return { sourceId: e.sourceId, reference: e.reference, url: e.url, revision: e.revision, capturedAt: e.capturedAt, excerpt: excerpt.text, shortened: excerpt.shortened, flags: e.flags };
            }),
            moreCitations: memory.evidence.length - cited.length,
          };
        };
        const full = item(false);
        const fullCost = estimateTokens(full);
        if (used + fullCost <= maxTokens) { items.push(full); used += fullCost; continue; }
        const compact = item(true);
        const compactCost = estimateTokens(compact);
        if (used + compactCost <= maxTokens || mustInclude) { items.push(compact); used += compactCost; continue; }
        omitted++;
      }
      const delivered = new Set(items.map((item) => item.memoryId));
      const allConflicts: TaskContextResponse["conflicts"] = [];
      const seenPairs = new Set<string>();
      for (const { a, b } of conflictPairs) {
        const key = [a, b].sort().join(":");
        if (seenPairs.has(key) || (!delivered.has(a) && !delivered.has(b))) continue;
        seenPairs.add(key);
        allConflicts.push({ memoryId: a, conflictsWith: b, bothDelivered: delivered.has(a) && delivered.has(b) });
      }
      // Pairs the agent can act on first: both sides delivered, then the rest.
      allConflicts.sort((x, y) => Number(y.bothDelivered) - Number(x.bothDelivered));
      const changed = new Map<string, TaskContextResponse["changedDependencies"][number]>();
      for (const change of changedDependencies) {
        if (delivered.has(change.memoryId)) changed.set(`${change.memoryId}:${change.linkedTo}`, change);
      }
      const allChanged = [...changed.values()];
      const outcome = items.length > 0 ? "results" : "no_results";
      const retrievedAt = ctx.now();
      const retrievalId = await recordRetrieval(tx, {
        projectId,
        callerId: caller.id,
        terms: mayContainPersonalData(task) ? null : terms,
        outcome,
        retrievedAt,
        ...(scope ? { applicability: scope } : {}),
        items: items.map((item) => ({ memoryId: item.memoryId, revision: item.revision, status: "approved" as const })),
      });
      return {
        retrievalId, projectId, retrievedAt, outcome, items,
        conflicts: allConflicts.slice(0, MAX_NOTICES), moreConflicts: Math.max(0, allConflicts.length - MAX_NOTICES),
        changedDependencies: allChanged.slice(0, MAX_NOTICES), moreChangedDependencies: Math.max(0, allChanged.length - MAX_NOTICES),
        omitted, budget: { maxTokens, usedTokens: used }, applicability: scope,
      };
    });
  } catch (error) {
    if (error instanceof MemoryNetError) throw error;
    if (allowed) {
      await recordRetrieval(ctx.db, { projectId, callerId: allowed.id, terms: null, outcome: "failed", retrievedAt: ctx.now(), items: [] }).catch(() => undefined);
    }
    throw new UnavailableError("Task context failed, so nothing was searched. This is not the same as finding nothing: try again.", { cause: error });
  }
}
