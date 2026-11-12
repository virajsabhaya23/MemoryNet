import { requireRepositoryId } from "./repository-identity.ts";
import {
  requireCaller,
  requireRole,
  resolveScope,
  type Principal,
} from "./access.ts";
import {
  mayContainPersonalData,
  requireNoSecrets,
  type ContentFlag,
} from "./content-checks.ts";
import { accessFreshSince, type MemoryNetContext } from "./context.ts";
import { firstRow, type Queryable } from "./db.ts";
import type { DefinitionKind } from "./definitions.ts";
import { MemoryNetError, UnavailableError, ValidationError } from "./errors.ts";
import {
  findReadableMemory,
  READABLE_MEMORIES_SQL,
  searchReadableMemories,
  requireDecisionBranch,
  requireDecisionApplicabilityAccess,
  normalizeDecisionApplicability,
  type DecisionApplicability,
  type DecisionContextScope,
  type DecisionContextScopeInput,
  type Memory,
  type MemoryStatus,
  type MemoryType,
} from "./knowledge.ts";
import { MINIMUM_ROLE, ROLE_RANK } from "./roles.ts";
import { optionalLimit, requireId, requireText } from "./validation.ts";

/** results: current guidance was supplied. no_results: none was. failed: nothing was searched. */
export const RETRIEVAL_OUTCOMES = ["results", "no_results", "failed"] as const;
export type RetrievalOutcome = (typeof RETRIEVAL_OUTCOMES)[number];

/** Bounds on one context response. Provisional until a token budget is chosen (architecture, open choices). */
export const CONTEXT_LIMITS = {
  queryLength: 200,
  defaultResults: 8,
  maxResults: 20,
  notCurrent: 5,
  contentLength: 1500,
  citationsPerMemory: 3,
  excerptLength: 400,
} as const;

const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 500;

/** A cited source: where the guidance came from. */
export interface Citation {
  sourceId: string;
  /** Such as pull/42. */
  reference: string;
  url: string;
  /** The commit, when known. */
  revision: string | null;
  capturedAt: Date;
  excerpt: string;
  /** True when the excerpt was cut to keep the response small; the source's page has all of it. */
  shortened: boolean;
  flags: ContentFlag[];
}

/** Current, approved guidance, supplied with its text and evidence. */
export interface ContextMemory {
  memoryId: string;
  revision: number;
  type: MemoryType;
  title: string;
  content: string;
  /** True when the text was cut to keep the response small; the memory's page has all of it. */
  shortened: boolean;
  ownerId: string;
  approvedBy: string;
  approvedAt: Date;
  citations: Citation[];
  /** Cited sources left out to keep the response small. */
  moreCitations: number;
  applicability: DecisionApplicability | null;
}

/** A match that is not current guidance. Listed so nobody takes it for current, without its text. */
export interface NotCurrentMatch {
  memoryId: string;
  revision: number;
  status: "suspended" | "superseded" | "revoked";
  type: MemoryType;
  title: string;
  since: Date | null;
  reason: string | null;
  /** The memory that replaced it, when the caller may read that one. */
  replacedBy: {
    memoryId: string;
    revision: number;
    title: string;
    status: MemoryStatus;
  } | null;
}

export interface ContextResponse {
  /** The retrieval record of this response. */
  retrievalId: string;
  projectId: string;
  outcome: Exclude<RetrievalOutcome, "failed">;
  /** Best match first. */
  current: ContextMemory[];
  notCurrent: NotCurrentMatch[];
  /** More current guidance matched than was returned. */
  moreMatches: boolean;
  retrievedAt: Date;
  applicability: DecisionContextScope | null;
}

function cut(text: string, max: number): { text: string; shortened: boolean } {
  if (text.length <= max) return { text, shortened: false };
  return { text: `${text.slice(0, max - 1).trimEnd()}…`, shortened: true };
}

function toContextMemory(memory: Memory): ContextMemory {
  const content = cut(memory.content, CONTEXT_LIMITS.contentLength);
  const cited = memory.evidence.slice(0, CONTEXT_LIMITS.citationsPerMemory);
  return {
    memoryId: memory.id,
    revision: memory.revision,
    type: memory.type,
    title: memory.title,
    content: content.text,
    shortened: content.shortened,
    ownerId: memory.ownerId,
    approvedBy: memory.approvedBy,
    approvedAt: memory.approvedAt,
    citations: cited.map((item) => {
      const excerpt = cut(item.excerpt, CONTEXT_LIMITS.excerptLength);
      return {
        sourceId: item.sourceId,
        reference: item.reference,
        url: item.url,
        revision: item.revision,
        capturedAt: item.capturedAt,
        excerpt: excerpt.text,
        shortened: excerpt.shortened,
        flags: item.flags,
      };
    }),
    moreCitations: memory.evidence.length - cited.length,
    applicability: memory.applicability,
  };
}

async function toNotCurrent(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  memory: Memory,
): Promise<NotCurrentMatch> {
  const next =
    memory.supersededBy === null
      ? null
      : await findReadableMemory(q, ctx, caller, memory.supersededBy);
  return {
    memoryId: memory.id,
    revision: memory.revision,
    status: memory.status === "revoked" ? "revoked" : memory.status === "suspended" ? "suspended" : "superseded",
    type: memory.type,
    title: memory.title,
    since: memory.statusChangedAt,
    reason: memory.statusReason,
    replacedBy: next
      ? {
          memoryId: next.id,
          revision: next.revision,
          title: next.title,
          status: next.status,
        }
      : null,
  };
}

export interface NewRecord {
  projectId: string;
  callerId: string;
  terms: string | null;
  outcome: RetrievalOutcome;
  retrievedAt: Date;
  applicability?: DecisionContextScope;
  items: ReadonlyArray<{
    memoryId: string;
    revision: number;
    status: MemoryStatus;
  }>;
  /** Definition versions delivered as reviewed guidance, in delivery order. */
  definitions?: ReadonlyArray<{ definitionId: string; revision: number }>;
}

/** Writes one append-only receipt, its items and its delivered definitions. Call inside the retrieval's transaction. */
export async function recordRetrieval(
  q: Queryable,
  record: NewRecord,
): Promise<string> {
  const { id } = firstRow(
    (
      await q.query<{ id: string }>(
        `INSERT INTO retrievals (project_id, caller_id, search_terms, outcome, retrieved_at, applicability)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
        [
          record.projectId,
          record.callerId,
          record.terms,
          record.outcome,
          record.retrievedAt,
          record.applicability ? JSON.stringify(record.applicability) : null,
        ],
      )
    ).rows,
  );
  for (const [index, item] of record.items.entries()) {
    await q.query(
      `INSERT INTO retrieval_items (retrieval_id, position, memory_id, revision, status, status_generation)
       VALUES ($1, $2, $3, $4, $5, (SELECT status_generation FROM memories WHERE id=$3 AND current_revision=$4))`,
      [id, index + 1, item.memoryId, item.revision, item.status],
    );
  }
  for (const [index, definition] of (record.definitions ?? []).entries()) {
    await q.query(
      "INSERT INTO retrieval_definitions (retrieval_id, position, definition_id, revision) VALUES ($1, $2, $3, $4)",
      [id, index + 1, definition.definitionId, definition.revision],
    );
  }
  return id;
}

async function retrieve(
  tx: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  projectId: string,
  query: string,
  limit: number,
  applicability?: DecisionContextScope,
  currentOnly = false,
): Promise<ContextResponse> {
  const { terms, matches } = await searchReadableMemories(
    tx,
    ctx,
    caller,
    projectId,
    query,
    { current: limit + 1, notCurrent: currentOnly ? 0 : CONTEXT_LIMITS.notCurrent },
    applicability,
  );
  if (terms === "") {
    throw new ValidationError(
      'Search needs at least one word that is not a very common word such as "the"',
    );
  }
  const currentMatches = matches.filter((item) => item.status === "approved");
  const current = currentMatches.slice(0, limit).map(toContextMemory);
  const notCurrent: NotCurrentMatch[] = [];
  for (const memory of matches) {
    if (memory.status !== "approved") {
      notCurrent.push(await toNotCurrent(tx, ctx, caller, memory));
    }
  }
  const outcome = current.length > 0 ? "results" : "no_results";
  const retrievedAt = ctx.now();
  const retrievalId = await recordRetrieval(tx, {
    projectId,
    callerId: caller.id,
    // The words are kept to study misses; text that may hold personal data is not.
    terms: mayContainPersonalData(query) ? null : terms,
    outcome,
    retrievedAt,
    applicability,
    items: [
      ...current.map((item) => ({
        memoryId: item.memoryId,
        revision: item.revision,
        status: "approved" as const,
      })),
      ...notCurrent,
    ],
  });
  return {
    retrievalId,
    projectId,
    outcome,
    current,
    notCurrent,
    moreMatches: currentMatches.length > limit,
    retrievedAt,
    applicability: applicability ?? null,
  };
}

/**
 * Current, approved knowledge in one project that matches a search, with IDs, versions, and evidence,
 * bounded in size. Suspended or replaced matches are listed as not current, without their text.
 * Every call is recorded: who, when, the searched words, and each memory version returned. If the
 * search or its record fails, it throws UnavailableError and records the failure: never "nothing found".
 */
export async function getContext(
  ctx: MemoryNetContext,
  callerId: string,
  input: { projectId: string; query: string; limit?: number; applicability?: DecisionContextScopeInput; currentOnly?: boolean },
): Promise<ContextResponse> {
  const projectId = requireId(input.projectId, "projectId");
  if (input.currentOnly !== undefined && typeof input.currentOnly !== "boolean") throw new ValidationError("currentOnly must be boolean");
  const observedAt = ctx.now();
  let applicability: DecisionContextScope | undefined;
  if (input.applicability !== undefined) {
    const value = input.applicability;
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["repositoryId", "branch", "at"].includes(key))) throw new ValidationError("Invalid context applicability");
    const repositoryId = requireRepositoryId(value.repositoryId, "repositoryId"), branch = requireDecisionBranch(value.branch);
    const at = value.at === undefined ? observedAt : normalizeDecisionApplicability({ repositoryId, branch, validFrom: value.at })!.validFrom;
    if (!Number.isFinite(at.getTime()) || at.getTime() !== observedAt.getTime()) throw new ValidationError("Only current-time applicability queries are supported; historical/future reconstruction is unavailable");
    applicability = { repositoryId, branch, at };
  }
  const readCtx = { ...ctx, now: () => new Date(observedAt) };
  const query = requireText(input.query, "Search", CONTEXT_LIMITS.queryLength);
  requireNoSecrets(query, "Search");
  const limit = optionalLimit(
    input.limit,
    CONTEXT_LIMITS.defaultResults,
    CONTEXT_LIMITS.maxResults,
  );
  let allowed: Principal | null = null;
  try {
    const caller = await requireCaller(ctx.db, callerId);
    const scope = await resolveScope(ctx.db, {
      level: "project",
      id: projectId,
    });
    await requireRole(
      ctx.db,
      caller,
      scope,
      MINIMUM_ROLE.read,
      "search knowledge",
    );
    allowed = caller;
    return await ctx.db.transaction(async (tx) => {
      await requireRole(tx, caller, scope, MINIMUM_ROLE.read, "search knowledge");
      if (applicability) await requireDecisionApplicabilityAccess(tx, readCtx, caller, projectId, { repositoryId: applicability.repositoryId, branch: applicability.branch, validFrom: observedAt, validUntil: null });
      return retrieve(tx, readCtx, caller, projectId, query, limit, applicability, input.currentOnly === true);
    });
  } catch (error) {
    if (error instanceof MemoryNetError) throw error;
    if (allowed) {
      await recordRetrieval(ctx.db, {
        projectId,
        callerId: allowed.id,
        terms: null,
        outcome: "failed",
        retrievedAt: ctx.now(),
        items: [],
      }).catch(() => undefined);
    }
    throw new UnavailableError(
      "Search failed, so nothing was searched. This is not the same as finding nothing: try again.",
      { cause: error },
    );
  }
}

/** A memory version a retrieval returned. */
export interface RetrievedItem {
  memoryId: string;
  revision: number;
  /** Its status then: approved items were supplied as current guidance, the others listed as not current. */
  status: MemoryStatus;
  /** The title of that version. */
  title: string;
}

/** A definition version a retrieval delivered as reviewed guidance. */
export interface RetrievedDefinition {
  definitionId: string;
  revision: number;
  kind: DefinitionKind;
  /** The name of that version. */
  name: string;
}

export interface RetrievalRecord {
  id: string;
  projectId: string;
  callerId: string;
  /** The searched words as the text search stores them; null when the search may have held personal data. */
  terms: string | null;
  failed: boolean;
  retrievedAt: Date;
  /** What it returned that the viewer may read now. Anything else is left out without a trace. */
  items: RetrievedItem[];
  /** Definitions it delivered that the viewer may see now, in delivery order. */
  definitions: RetrievedDefinition[];
  applicability: DecisionContextScope | null;
}

/**
 * Retrieval records in one project, newest first. Everyone sees their own; people with the administrator
 * role or higher see everyone's. Items follow today's read rules, so revoked access hides them here too.
 */
export async function listRetrievals(
  ctx: MemoryNetContext,
  callerId: string,
  filter: { projectId: string; limit?: number },
): Promise<RetrievalRecord[]> {
  const projectId = requireId(filter.projectId, "projectId");
  const limit = optionalLimit(filter.limit, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT);
  const caller = await requireCaller(ctx.db, callerId);
  const scope = await resolveScope(ctx.db, { level: "project", id: projectId });
  const rank = await requireRole(
    ctx.db,
    caller,
    scope,
    MINIMUM_ROLE.read,
    "see searches",
  );
  const everyone =
    caller.kind === "human" && rank >= ROLE_RANK[MINIMUM_ROLE.readRetrievalLog];
  const { rows } = await ctx.db.query<{
    id: string;
    project_id: string;
    caller_id: string;
    search_terms: string | null;
    outcome: RetrievalOutcome;
    retrieved_at: Date;
    applicability: { repositoryId: string; branch: string; at: string } | null;
  }>(
    `SELECT id, project_id, caller_id, search_terms, outcome, retrieved_at, applicability
     FROM retrievals rt
     WHERE project_id = $1 AND ($2::boolean OR caller_id = $3)
       AND (rt.applicability IS NULL OR EXISTS(SELECT 1 FROM repository_connections rc JOIN repository_access ra
         ON ra.provider=rc.provider AND ra.external_repository_id=rc.external_repository_id
         WHERE rc.project_id=rt.project_id AND rc.external_repository_id=rt.applicability->>'repositoryId'
           AND rc.disconnected_at IS NULL AND ra.principal_id=$3 AND ra.can_read AND ra.observed_at >= $5))
     ORDER BY retrieved_at DESC, id DESC
     LIMIT $4`,
    [projectId, everyone, caller.id, limit, accessFreshSince(ctx)],
  );
  const items = await ctx.db.query<{
    retrieval_id: string;
    memory_id: string;
    revision: number;
    status: MemoryStatus;
    title: string;
  }>(
    `SELECT ri.retrieval_id, ri.memory_id, ri.revision, ri.status, mr.title
     FROM retrieval_items ri
     JOIN memory_revisions mr ON mr.memory_id = ri.memory_id AND mr.revision = ri.revision
     WHERE ri.retrieval_id = ANY($3::uuid[])
       AND ri.memory_id IN (
         SELECT readable.id FROM (${READABLE_MEMORIES_SQL} AND m.project_id = $4) readable)
       AND NOT EXISTS (
         SELECT 1 FROM memory_evidence me
         WHERE me.memory_id = ri.memory_id AND me.revision = ri.revision
           AND NOT EXISTS (
             SELECT 1 FROM source_read_access sra
             WHERE sra.principal_id = $1 AND sra.source_id = me.source_id
               AND sra.access_observed_at >= $2))
     ORDER BY ri.retrieval_id, ri.position`,
    [caller.id, accessFreshSince(ctx), rows.map((row) => row.id), projectId],
  );
  const byRetrieval = new Map<string, RetrievedItem[]>();
  for (const item of items.rows) {
    const list = byRetrieval.get(item.retrieval_id) ?? [];
    list.push({
      memoryId: item.memory_id,
      revision: item.revision,
      status: item.status,
      title: item.title,
    });
    byRetrieval.set(item.retrieval_id, list);
  }
  // Same rule as definition pages: a role at the definition's level, above it, or inside it.
  const delivered = await ctx.db.query<{
    retrieval_id: string;
    definition_id: string;
    revision: number;
    kind: DefinitionKind;
    name: string;
  }>(
    `SELECT rd.retrieval_id, rd.definition_id, rd.revision, d.kind, dr.name
     FROM retrieval_definitions rd
     JOIN definitions d ON d.id = rd.definition_id
     JOIN definition_revisions dr ON dr.definition_id = rd.definition_id AND dr.revision = rd.revision
     WHERE rd.retrieval_id = ANY($1::uuid[])
       AND EXISTS (SELECT 1 FROM definition_read_access dra
                   WHERE dra.definition_id = rd.definition_id AND dra.principal_id = $2)
     ORDER BY rd.retrieval_id, rd.position`,
    [rows.map((row) => row.id), caller.id],
  );
  const definitionsByRetrieval = new Map<string, RetrievedDefinition[]>();
  for (const row of delivered.rows) {
    const list = definitionsByRetrieval.get(row.retrieval_id) ?? [];
    list.push({ definitionId: row.definition_id, revision: row.revision, kind: row.kind, name: row.name });
    definitionsByRetrieval.set(row.retrieval_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    callerId: row.caller_id,
    terms: row.search_terms,
    failed: row.outcome === "failed",
    retrievedAt: row.retrieved_at,
    items: byRetrieval.get(row.id) ?? [],
    definitions: definitionsByRetrieval.get(row.id) ?? [],
    applicability: row.applicability === null ? null : { repositoryId: row.applicability.repositoryId, branch: row.applicability.branch, at: new Date(row.applicability.at) },
  }));
}
