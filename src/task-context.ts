import { requireRepositoryId } from "./repository-identity.ts";
import { requireCaller, requireRole, resolveScope, type Principal, type ScopeLevel } from "./access.ts";
import { mayContainPersonalData, requireNoSecrets } from "./content-checks.ts";
import { accessFreshSince, type MemoryNetContext } from "./context.ts";
import type { Queryable } from "./db.ts";
import { basedOnChanges, type BasedOnChange } from "./definition-freshness.ts";
import { readableProjectDefinitions, type Definition, type DefinitionKind } from "./definitions.ts";
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
import { parseRelations, pathMatches, pathSpecificity, readableMemoryIds, requirePathPattern, type MemoryRelation, type MemoryRelations } from "./relations.ts";
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
  /** Definitions share the token budget: at most this part of it, and at most `definitions` of them. */
  definitionShare: 0.35,
  definitions: 6,
  pathReasonsPerDefinition: 3,
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

/** Why a definition was delivered. Every delivered definition has at least one reason. */
export type TaskContextDefinitionReason =
  /** A rule or instruction of the project, its business unit or its organization: it applies to all work there. */
  | { kind: "applies_to_scope" }
  /** The agent definition the calling agent account runs as. */
  | { kind: "runs_as_caller" }
  | { kind: "matched_task" }
  /** The file matched a path pattern in its appliesTo, or (pattern null) the words of its name, purpose, appliesTo or responsibilities. */
  | { kind: "matched_path"; path: string; pattern: string | null };

/** A reviewed definition delivered as organizational guidance, at its current approved version. */
export interface TaskContextDefinition {
  definitionId: string;
  revision: number;
  kind: DefinitionKind;
  name: string;
  purpose: string;
  /** What it requires, asks for or does. Empty when compact. */
  responsibilities: string[];
  /** Full text up to the limit, or a short preview when compact. */
  instructions: string;
  shortened: boolean;
  /** What it does not cover or must never do. Empty when compact. */
  boundaries: string[];
  appliesTo: string | null;
  scope: { level: ScopeLevel; id: string };
  approvedBy: string;
  approvedAt: Date;
  /** True when only a preview fit in its share of the token budget. */
  compact: boolean;
  reasons: TaskContextDefinitionReason[];
  /**
   * Decisions this version is based on that the caller may read; change is null while one is unchanged. The
   * replacement is named only when the caller may read it. Compact items list changed decisions only.
   */
  basedOn: Array<{ memoryId: string; change: BasedOnChange["change"] | null; replacedBy: string | null }>;
  /** A decision it is based on changed after this version was approved, so it may be outdated. */
  reviewNeeded: boolean;
}

export interface TaskContextResponse {
  retrievalId: string;
  projectId: string;
  retrievedAt: Date;
  /** Whether any decision was delivered; definitions do not change it. */
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
  /**
   * The caller's own agent definition, then rules and instructions (project, business unit, organization), then
   * skills matching the task or files, best match first. Only active definitions of the project's own chain.
   */
  definitions: TaskContextDefinition[];
  /** Eligible definitions left out by their item limit or share of the token budget. */
  moreDefinitions: number;
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

interface DefinitionCandidate {
  definition: Definition;
  reasons: TaskContextDefinitionReason[];
  basedOn: TaskContextDefinition["basedOn"];
  reviewNeeded: boolean;
  /** Orders matching skills: path patterns, then path words, then task text rank. */
  strength: number;
}

const LEVEL_ORDER: Readonly<Record<ScopeLevel, number>> = { project: 0, business_unit: 1, organization: 2 };
const KIND_ORDER: Readonly<Record<DefinitionKind, number>> = { agent: 0, rule: 1, instruction: 1, skill: 2 };

/** Path patterns such as src/payments/** written in a definition's appliesTo. Other words are ignored. */
function appliesToPatterns(appliesTo: string | null): string[] {
  const patterns: string[] = [];
  for (const word of appliesTo?.split(/[\s,;()"'`]+/) ?? []) {
    const candidate = word.replace(/[.:]+$/, "");
    if (!/[/*?]/.test(candidate)) continue;
    try { patterns.push(requirePathPattern(candidate)); } catch { /* prose, not a path pattern */ }
  }
  return patterns;
}

/** For each definition: whether the task words match its text, their rank, and the files whose words match it. */
async function matchDefinitions(q: Queryable, definitions: readonly Definition[], terms: string, paths: readonly string[]) {
  if (definitions.length === 0) return [];
  const { rows } = await q.query<{ task: boolean; rank: number; paths: string[] }>(
    `WITH docs AS (
       SELECT u.i, setweight(to_tsvector('english', u.name), 'A') || setweight(to_tsvector('english', u.purpose || ' ' || u.applies_to), 'B')
                   || setweight(to_tsvector('english', u.duties), 'C') AS doc
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS u(name, purpose, applies_to, duties, i)),
     files AS (
       SELECT f.path, f.n, replace(plainto_tsquery('english', regexp_replace(f.path, '[^[:alnum:]]+', ' ', 'g'))::text, ' & ', ' | ') AS words
       FROM unnest($6::text[]) WITH ORDINALITY AS f(path, n))
     SELECT CASE WHEN $5 = '' THEN false ELSE docs.doc @@ $5::tsquery END AS task,
            CASE WHEN $5 = '' THEN 0 ELSE ts_rank(docs.doc, $5::tsquery) END AS rank,
            COALESCE((SELECT array_agg(files.path ORDER BY files.n) FROM files
                      WHERE CASE WHEN files.words = '' THEN false ELSE docs.doc @@ files.words::tsquery END), '{}') AS paths
     FROM docs ORDER BY docs.i`,
    [definitions.map((d) => d.name), definitions.map((d) => d.purpose), definitions.map((d) => d.appliesTo ?? ""),
      definitions.map((d) => d.responsibilities.join("\n")), terms, [...paths]],
  );
  return rows.map((row) => ({ task: row.task, rank: Number(row.rank), paths: row.paths }));
}

/**
 * Active definitions of the project, its business unit and its organization that the caller may see, never
 * another unit's or project's: rules and instructions always, skills when the task or a file matches them, and
 * agent definitions only when they run as the caller. reviewNeeded and basedOn use only memories the caller may read.
 */
async function selectDefinitions(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  projectId: string,
  terms: string,
  paths: readonly string[],
): Promise<DefinitionCandidate[]> {
  const { definitions, linkedMemories } = await readableProjectDefinitions(q, ctx, caller, projectId);
  const active = definitions.filter((d) => d.status === "active" && (d.kind !== "agent" || d.runsAs === caller.id));
  const matches = await matchDefinitions(q, active, terms, paths);
  const readable = new Map(linkedMemories.map((memory) => [memory.id, memory]));
  const candidates: Array<DefinitionCandidate & { changes: BasedOnChange[] }> = [];
  for (const [index, definition] of active.entries()) {
    const match = matches[index]!;
    const found: TaskContextDefinitionReason[] = match.task ? [{ kind: "matched_task" }] : [];
    const patterns = appliesToPatterns(definition.appliesTo);
    let patternPaths = 0, wordPaths = 0;
    for (const path of paths) {
      if (patternPaths + wordPaths === TASK_CONTEXT_LIMITS.pathReasonsPerDefinition) break;
      const pattern = patterns.find((item) => pathMatches(item, path));
      if (pattern !== undefined) { found.push({ kind: "matched_path", path, pattern }); patternPaths++; }
      else if (match.paths.includes(path)) { found.push({ kind: "matched_path", path, pattern: null }); wordPaths++; }
    }
    if (definition.kind === "skill" && found.length === 0) continue;
    const own: TaskContextDefinitionReason[] = definition.kind === "agent" ? [{ kind: "runs_as_caller" }]
      : definition.kind === "skill" ? [] : [{ kind: "applies_to_scope" }];
    const changes = basedOnChanges(definition, readable);
    candidates.push({ definition, reasons: [...own, ...found], basedOn: [], reviewNeeded: changes.length > 0,
      strength: 2 * patternPaths + wordPaths + (match.task ? match.rank : 0), changes });
  }
  // A replacement is named only when the caller may read it.
  const replacements = candidates.flatMap((c) => c.changes.flatMap((change) => change.replacedBy ?? []));
  const nameable = await readableMemoryIds(q, ctx, caller, READABLE_MEMORIES_SQL, replacements);
  for (const candidate of candidates) {
    const changed = new Map(candidate.changes.map((change) => [change.memoryId, change]));
    // Links already follow the caller's view, so every based_on target here is readable.
    const linked = new Set(candidate.definition.links.filter((link) => link.relation === "based_on").map((link) => link.targetId));
    candidate.basedOn = [...linked].map((memoryId) => {
      const change = changed.get(memoryId);
      const replacedBy = change?.replacedBy ?? null;
      return { memoryId, change: change?.change ?? null, replacedBy: replacedBy !== null && nameable.has(replacedBy) ? replacedBy : null };
    });
  }
  const name = (d: Definition) => d.name.toLowerCase();
  return candidates.sort((a, b) => {
    const x = a.definition, y = b.definition;
    return KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || (x.kind === "skill" ? b.strength - a.strength : 0)
      || LEVEL_ORDER[x.scope.level] - LEVEL_ORDER[y.scope.level] || Number(x.kind === "instruction") - Number(y.kind === "instruction")
      || (name(x) < name(y) ? -1 : name(x) > name(y) ? 1 : 0) || x.id.localeCompare(y.id);
  });
}

function definitionItem(candidate: DefinitionCandidate, compact: boolean): TaskContextDefinition {
  const { definition } = candidate;
  const text = cut(definition.instructions, compact ? TASK_CONTEXT_LIMITS.compactLength : TASK_CONTEXT_LIMITS.contentLength);
  return {
    definitionId: definition.id, revision: definition.revision, kind: definition.kind, name: definition.name, purpose: definition.purpose,
    responsibilities: compact ? [] : definition.responsibilities, instructions: text.text, shortened: text.shortened,
    boundaries: compact ? [] : definition.boundaries, appliesTo: definition.appliesTo, scope: definition.scope,
    approvedBy: definition.approvedBy, approvedAt: definition.approvedAt, compact, reasons: candidate.reasons,
    basedOn: compact ? candidate.basedOn.filter((item) => item.change !== null) : candidate.basedOn,
    reviewNeeded: candidate.reviewNeeded,
  };
}

/** Packs definitions into their share of the budget: whole when they fit, else a preview, else counted as left out. */
function packDefinitions(candidates: readonly DefinitionCandidate[], maxTokens: number) {
  const budget = Math.floor(maxTokens * TASK_CONTEXT_LIMITS.definitionShare);
  const definitions: TaskContextDefinition[] = [];
  let used = 0, more = 0;
  for (const candidate of candidates) {
    if (definitions.length >= TASK_CONTEXT_LIMITS.definitions) { more++; continue; }
    const full = definitionItem(candidate, false);
    const fullCost = estimateTokens(full);
    if (used + fullCost <= budget) { definitions.push(full); used += fullCost; continue; }
    const preview = definitionItem(candidate, true);
    const previewCost = estimateTokens(preview);
    if (used + previewCost <= budget) { definitions.push(preview); used += previewCost; continue; }
    more++;
  }
  return { definitions, more, used };
}

/**
 * Approved, current guidance for a task: memories matching the task text or governing the given paths,
 * then memories they depend on, refine, conflict with or share evidence with, scored by bounded spreading
 * activation over reviewed relations and packed into a token budget. Only memories the caller may read and
 * that apply to the scope are ever considered, so a relation never reveals or reaches hidden guidance.
 * Reviewed definitions of the project's own chain that apply to the task share the budget (see selectDefinitions).
 * Every response is recorded as a retrieval receipt, with each delivered memory and definition version.
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
      // Definitions take their share of the budget first; decisions keep the rest.
      const guidance = packDefinitions(await selectDefinitions(tx, readCtx, caller, projectId, terms, paths), maxTokens);

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
      let used = 60 + guidance.used;
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
        definitions: guidance.definitions.map((definition) => ({ definitionId: definition.definitionId, revision: definition.revision })),
      });
      return {
        retrievalId, projectId, retrievedAt, outcome, items,
        conflicts: allConflicts.slice(0, MAX_NOTICES), moreConflicts: Math.max(0, allConflicts.length - MAX_NOTICES),
        changedDependencies: allChanged.slice(0, MAX_NOTICES), moreChangedDependencies: Math.max(0, allChanged.length - MAX_NOTICES),
        omitted, definitions: guidance.definitions, moreDefinitions: guidance.more,
        budget: { maxTokens, usedTokens: used }, applicability: scope,
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
