import {
  hasFreshRepositoryAccess,
  requireCaller,
  requireHuman,
  requireRole,
  requireScopeRef,
  resolveScope,
  type Principal,
  type Scope,
  type ScopeLevel,
  type ScopeRef,
} from "./access.ts";
import { recordAudit } from "./audit.ts";
import {
  flagDetails,
  mayContainPersonalData,
  requireNoSecrets,
  type ContentFlag,
} from "./content-checks.ts";
import { accessFreshSince, type MemoryNetContext } from "./context.ts";
import { firstRow, type Queryable } from "./db.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./errors.ts";
import { PROVIDERS, type Provider } from "./repositories.ts";
import { MINIMUM_ROLE, ROLE_RANK } from "./roles.ts";
import {
  isPullRequestUrl,
  optionalCommitSha,
  optionalLimit,
  optionalText,
  requireGithubId,
  requireHttpsUrl,
  requireId,
  requireIds,
  requireOneOf,
  requirePositiveInteger,
  requirePullRequestReference,
  requireText,
} from "./validation.ts";

export const MEMORY_TYPES = [
  "decision",
  "rationale",
  "lesson",
  "constraint",
  "failed_approach",
  "incident",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Proposals are never trusted context. Approving one publishes a memory. */
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Mirrors the memories table. approved is current guidance; suspended is disputed; superseded is replaced. */
export const MEMORY_STATUSES = ["approved", "suspended", "superseded", "revoked"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export interface DecisionApplicabilityInput {
  /** Stable numeric GitHub repository ID, never a local connection UUID. */
  repositoryId: string;
  branch: string;
  validFrom: Date | string;
  validUntil?: Date | string | null;
}
export interface DecisionApplicability {
  repositoryId: string;
  branch: string;
  validFrom: Date;
  validUntil: Date | null;
}
export interface DecisionContextScopeInput { repositoryId: string; branch: string; at?: Date | string }
export interface DecisionContextScope { repositoryId: string; branch: string; at: Date }

export function requireDecisionBranch(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || value === "@" ||
      /[\s\u0000-\u001f\u007f~^:?*\[\\]/.test(value) || value.includes("..") || value.includes("@{") || value.includes("//") ||
      /(^|\/)\.|\.lock(\/|$)|^[-/]|[/.]$/.test(value)) throw new ValidationError("Applicability needs an exact valid branch name");
  return value;
}
function decisionDate(value: unknown, field: string): Date {
  if (!(value instanceof Date)) {
    const parts = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value) : null;
    if (!parts) throw new ValidationError(`${field} needs an explicit UTC or offset timestamp`);
    const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59 || (parts[7] !== "Z" && (Number(parts[9]) > 23 || Number(parts[10]) > 59))) {
      throw new ValidationError(`${field} must be a valid calendar timestamp`);
    }
  }
  const result = new Date(value as Date | string);
  if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() < 1 || result.getUTCFullYear() > 9999) throw new ValidationError(`${field} must be a valid timestamp`);
  return result;
}
export function normalizeDecisionApplicability(value: DecisionApplicabilityInput | null | undefined): DecisionApplicability | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["repositoryId", "branch", "validFrom", "validUntil"].includes(key))) throw new ValidationError("Invalid decision applicability");
  const validFrom = decisionDate(value.validFrom, "validFrom");
  const validUntil = value.validUntil == null ? null : decisionDate(value.validUntil, "validUntil");
  if (validUntil !== null && validUntil.getTime() <= validFrom.getTime()) throw new ValidationError("validUntil must follow validFrom (exclusive end)");
  return { repositoryId: requireGithubId(value.repositoryId, "repositoryId"), branch: requireDecisionBranch(value.branch), validFrom, validUntil };
}
function applicabilityJson(value: DecisionApplicability | null): string | null { return value === null ? null : JSON.stringify(value); }
function sameApplicability(a: DecisionApplicability | null, b: DecisionApplicability | null): boolean { return applicabilityJson(a) === applicabilityJson(b); }
export async function requireDecisionApplicabilityAccess(q: Queryable, ctx: MemoryNetContext, caller: Principal, projectId: string, applicability: DecisionApplicability | null): Promise<string | null> {
  if (applicability === null) return null;
  const row = (await q.query<{ id: string }>("SELECT id FROM repository_connections WHERE project_id=$1 AND provider='github' AND external_repository_id=$2 AND disconnected_at IS NULL", [projectId, applicability.repositoryId])).rows[0];
  if (!row || !(await hasFreshRepositoryAccess(q, caller.id, "github", applicability.repositoryId, accessFreshSince(ctx)))) throw new NotFoundError("Applicability repository not found");
  return row.id;
}

/** new: a new memory. revise: a new version of a memory. replace: a new memory that replaces one. restore: an earlier version brought back. */
export const CHANGE_KINDS = ["new", "revise", "replace", "restore"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** manual: recorded by a person or agent. github_app: captured from a verified GitHub App event. */
export const CAPTURE_METHODS = ["manual", "github_app"] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

export interface Source {
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
  capturedAt: Date;
  flags: ContentFlag[];
}

/** A cited source as shown with a proposal or memory: its link, excerpt, revision or capture time, and flags. */
export interface Evidence {
  sourceId: string;
  reference: string;
  url: string;
  revision: string | null;
  excerpt: string;
  capturedAt: Date;
  flags: ContentFlag[];
}

/** Proposed knowledge and its review. Only human contributors and above can see it. */
export interface Proposal {
  id: string;
  projectId: string;
  type: MemoryType;
  title: string;
  content: string;
  /** The person who will be accountable for the memory once it is approved. */
  ownerId: string;
  status: ProposalStatus;
  /** The proposal version a reviewer must name. */
  revision: number;
  proposedBy: string;
  proposedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewReason: string | null;
  /** The memory this proposal published, once approved. */
  memoryId: string | null;
  /** Flags found in the proposal's own title and content. */
  flags: ContentFlag[];
  evidence: Evidence[];
  changeKind: ChangeKind;
  /** The memory a revise, replace, or restore proposal changes. */
  targetMemoryId: string | null;
  /** The memory version the change builds on; approval is refused if the memory moved on. */
  baseRevision: number | null;
  restoredFromRevision: number | null;
  applicability: DecisionApplicability | null;
  baseStatusGeneration: number | null;
}

/** Approved knowledge at its current version. The ID never changes. */
export interface Memory {
  id: string;
  projectId: string;
  ownerId: string;
  status: MemoryStatus;
  revision: number;
  type: MemoryType;
  title: string;
  content: string;
  proposalId: string;
  /** The exact proposal version the reviewer approved. */
  proposalRevision: number;
  proposedBy: string;
  approvedBy: string;
  approvedAt: Date;
  evidence: Evidence[];
  /** The memory that replaced this one, when its status is superseded. */
  supersededBy: string | null;
  statusReason: string | null;
  statusChangedBy: string | null;
  statusChangedAt: Date | null;
  applicability: DecisionApplicability | null;
  statusGeneration: number;
}

export const EXCERPT_MAX_LENGTH = 4000;
const TITLE_MAX_LENGTH = 200;
const CONTENT_MAX_LENGTH = 10_000;
const REASON_MAX_LENGTH = 500;
const MAX_EVIDENCE_SOURCES = 20;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const SCOPE_COLUMN: Readonly<Record<ScopeLevel, string>> = {
  organization: "p.organization_id",
  business_unit: "p.business_unit_id",
  project: "p.id",
};

/** Every sources column, for INSERT ... RETURNING and single-table selects. */
export const SOURCE_COLUMNS = `id, project_id, provider, external_repository_id, reference, url,
  revision, excerpt, captured_by, captured_at, capture_method, content_flags`;

/** Proposal columns for INSERT or UPDATE ... RETURNING; the caller adds the evidence. */
const PROPOSAL_RETURNING = `id, project_id, type, title, content, owner_id, status, revision,
  proposed_by, proposed_at, reviewed_by, reviewed_at, review_reason, memory_id, content_flags,
  change_kind, target_memory_id, base_revision, restored_from_revision, applicability, applicability_connection_id, base_status_generation, NULL::json AS evidence`;

// Binds $1 caller and $2 oldest acceptable repository access observation.
const READABLE_SOURCES_SQL = `
  SELECT s.id, s.project_id, s.provider, s.external_repository_id, s.reference, s.url,
         s.revision, s.excerpt, s.captured_by, s.captured_at, s.capture_method, s.content_flags
  FROM sources s
  JOIN projects p ON p.id = s.project_id
  JOIN source_read_access sra
    ON sra.source_id = s.id AND sra.principal_id = $1 AND sra.access_observed_at >= $2
  WHERE true`;

// Cited sources as a JSON array. The surrounding query already requires each one to be readable.
export const EVIDENCE_JSON = `json_agg(json_build_object(
    'sourceId', s.id, 'reference', s.reference, 'url', s.url, 'revision', s.revision,
    'excerpt', s.excerpt, 'capturedAt', s.captured_at, 'flags', s.content_flags) ORDER BY s.id)`;

// Binds $1 caller, $2 access freshness, $3 caller is human, $4 rank that may see proposals.
const READABLE_PROPOSALS_SQL = `
  SELECT mp.id, mp.project_id, mp.type, mp.title, mp.content, mp.owner_id, mp.status,
         mp.revision, mp.proposed_by, mp.proposed_at, mp.reviewed_by, mp.reviewed_at,
         mp.review_reason, mp.memory_id, mp.content_flags, mp.change_kind,
         mp.target_memory_id, mp.base_revision, mp.restored_from_revision, mp.applicability, mp.applicability_connection_id, mp.base_status_generation,
         (SELECT ${EVIDENCE_JSON} FROM proposal_evidence pe JOIN sources s ON s.id = pe.source_id
          WHERE pe.proposal_id = mp.id) AS evidence
  FROM memory_proposals mp
  JOIN projects p ON p.id = mp.project_id
  JOIN effective_project_roles epr
    ON epr.project_id = mp.project_id AND epr.principal_id = $1
  WHERE $3::boolean AND epr.rank >= $4::int
    AND (mp.applicability IS NULL OR EXISTS(SELECT 1 FROM repository_connections rc JOIN repository_access ra
      ON ra.provider=rc.provider AND ra.external_repository_id=rc.external_repository_id
      WHERE rc.id=mp.applicability_connection_id AND rc.disconnected_at IS NULL
        AND ra.principal_id=$1 AND ra.can_read AND ra.observed_at >= $2))
    AND EXISTS (SELECT 1 FROM proposal_evidence pe WHERE pe.proposal_id = mp.id)
    AND NOT EXISTS (
      SELECT 1 FROM proposal_evidence pe
      WHERE pe.proposal_id = mp.id
        AND NOT EXISTS (
          SELECT 1 FROM source_read_access sra
          WHERE sra.principal_id = $1 AND sra.source_id = pe.source_id
            AND sra.access_observed_at >= $2))`;

// Binds $1 caller and $2 access freshness. Returns each memory's current version, in any status; callers filter.
export const READABLE_MEMORIES_SQL = `
  SELECT m.id, m.project_id, m.owner_id, m.status, r.revision, r.type, r.title, r.content,
         r.proposal_id, r.proposal_revision, mp.proposed_by, r.approved_by, r.approved_at,
         m.superseded_by, m.status_reason, m.status_changed_by, m.status_changed_at, m.status_generation, r.applicability, r.applicability_connection_id,
         (SELECT ${EVIDENCE_JSON} FROM memory_evidence me JOIN sources s ON s.id = me.source_id
          WHERE me.memory_id = m.id AND me.revision = m.current_revision) AS evidence
  FROM memories m
  JOIN memory_revisions r ON r.memory_id = m.id AND r.revision = m.current_revision
  JOIN memory_proposals mp ON mp.id = r.proposal_id
  JOIN projects p ON p.id = m.project_id
  JOIN effective_project_roles epr
    ON epr.project_id = m.project_id AND epr.principal_id = $1
  WHERE EXISTS (SELECT 1 FROM memory_evidence me
                WHERE me.memory_id = m.id AND me.revision = m.current_revision)
    AND (r.applicability IS NULL OR EXISTS(SELECT 1 FROM repository_connections rc JOIN repository_access ra
      ON ra.provider=rc.provider AND ra.external_repository_id=rc.external_repository_id
      WHERE rc.id=r.applicability_connection_id AND rc.disconnected_at IS NULL
        AND ra.principal_id=$1 AND ra.can_read AND ra.observed_at >= $2))
    AND NOT EXISTS (
      SELECT 1 FROM memory_evidence me
      WHERE me.memory_id = m.id AND me.revision = m.current_revision
        AND NOT EXISTS (
          SELECT 1 FROM source_read_access sra
          WHERE sra.principal_id = $1 AND sra.source_id = me.source_id
            AND sra.access_observed_at >= $2))`;

export interface SourceRow {
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

interface EvidenceJson {
  sourceId: string;
  reference: string;
  url: string;
  revision: string | null;
  excerpt: string;
  capturedAt: string;
  flags: ContentFlag[];
}

export interface ProposalRow {
  id: string;
  project_id: string;
  type: MemoryType;
  title: string;
  content: string;
  owner_id: string;
  status: ProposalStatus;
  revision: number;
  proposed_by: string;
  proposed_at: Date;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_reason: string | null;
  memory_id: string | null;
  content_flags: ContentFlag[];
  change_kind: ChangeKind;
  target_memory_id: string | null;
  base_revision: number | null;
  restored_from_revision: number | null;
  evidence: EvidenceJson[] | null;
  applicability?: DecisionApplicabilityInput | null;
  applicability_connection_id?: string | null;
  base_status_generation?: number | null;
}

interface MemoryRow {
  id: string;
  project_id: string;
  owner_id: string;
  status: MemoryStatus;
  revision: number;
  type: MemoryType;
  title: string;
  content: string;
  proposal_id: string;
  proposal_revision: number;
  proposed_by: string;
  approved_by: string;
  approved_at: Date;
  superseded_by: string | null;
  status_reason: string | null;
  status_changed_by: string | null;
  status_changed_at: Date | null;
  evidence: EvidenceJson[] | null;
  applicability?: DecisionApplicabilityInput | null;
  applicability_connection_id?: string | null;
  status_generation?: number;
}

export function mapSource(row: SourceRow): Source {
  return {
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
    capturedAt: row.captured_at,
    flags: row.content_flags,
  };
}

export function mapEvidence(items: EvidenceJson[] | null): Evidence[] {
  return (items ?? []).map((item) => ({
    sourceId: item.sourceId,
    reference: item.reference,
    url: item.url,
    revision: item.revision,
    excerpt: item.excerpt,
    capturedAt: new Date(item.capturedAt),
    flags: item.flags,
  }));
}

export function mapProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    title: row.title,
    content: row.content,
    ownerId: row.owner_id,
    status: row.status,
    revision: row.revision,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewReason: row.review_reason,
    memoryId: row.memory_id,
    flags: row.content_flags,
    evidence: mapEvidence(row.evidence),
    changeKind: row.change_kind,
    targetMemoryId: row.target_memory_id,
    baseRevision: row.base_revision,
    restoredFromRevision: row.restored_from_revision,
    applicability: normalizeDecisionApplicability(row.applicability),
    baseStatusGeneration: row.base_status_generation ?? null,
  };
}

function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    status: row.status,
    revision: row.revision,
    type: row.type,
    title: row.title,
    content: row.content,
    proposalId: row.proposal_id,
    proposalRevision: row.proposal_revision,
    proposedBy: row.proposed_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    evidence: mapEvidence(row.evidence),
    supersededBy: row.superseded_by,
    statusReason: row.status_reason,
    statusChangedBy: row.status_changed_by,
    statusChangedAt: row.status_changed_at,
    applicability: normalizeDecisionApplicability(row.applicability),
    statusGeneration: row.status_generation ?? 0,
  };
}

export function proposalReadParams(
  ctx: MemoryNetContext,
  caller: Principal,
): unknown[] {
  return [
    caller.id,
    accessFreshSince(ctx),
    caller.kind === "human",
    ROLE_RANK[MINIMUM_ROLE.readProposals],
  ];
}

/** Appends validated filters as bound parameters; SQL text comes only from constants. A null limit returns every row. */
function withFilters(
  baseSql: string,
  params: unknown[],
  scope: ScopeRef | null,
  extra: Array<[string, unknown]>,
  orderBy: string,
  limit: number | null,
): string {
  let sql = baseSql;
  if (scope) {
    params.push(scope.id);
    sql += ` AND ${SCOPE_COLUMN[scope.level]} = $${params.length}`;
  }
  for (const [column, value] of extra) {
    params.push(value);
    sql += ` AND ${column} = $${params.length}`;
  }
  sql += ` ORDER BY ${orderBy}`;
  if (limit === null) return sql;
  params.push(limit);
  return `${sql} LIMIT $${params.length}`;
}

export async function findReadableProposal(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  proposalId: string,
): Promise<Proposal | null> {
  const { rows } = await q.query<ProposalRow>(
    `${READABLE_PROPOSALS_SQL} AND mp.id = $5`,
    [...proposalReadParams(ctx, caller), proposalId],
  );
  return rows[0] ? mapProposal(rows[0]) : null;
}

export async function findReadableMemory(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  memoryId: string,
): Promise<Memory | null> {
  const { rows } = await q.query<MemoryRow>(
    `${READABLE_MEMORIES_SQL} AND m.id = $3`,
    [caller.id, accessFreshSince(ctx), memoryId],
  );
  return rows[0] ? mapMemory(rows[0]) : null;
}

/** A memory owner must be a person with a role covering the project. */
async function isEligibleOwner(
  q: Queryable,
  principalId: string,
  projectId: string,
): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM principals pr
     JOIN effective_project_roles epr
       ON epr.principal_id = pr.id AND epr.project_id = $2
     WHERE pr.id = $1 AND pr.kind = 'human'`,
    [principalId, projectId],
  );
  return rows.length > 0;
}

/** SQL comparing two texts while ignoring letter case and runs of whitespace. Built from constants only. */
function sameTextSql(column: string, placeholder: string): string {
  return `lower(regexp_replace(${column}, '[[:space:]]+', ' ', 'g')) =
          lower(regexp_replace(${placeholder}::text, '[[:space:]]+', ' ', 'g'))`;
}

/**
 * An approved memory or pending proposal in the project with the same title and content.
 * Only records the caller may already see, plus the caller's own proposals, are compared, so nothing hidden is revealed.
 * excludeProposalId skips the proposal being edited.
 */
async function findIdenticalKnowledge(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  projectId: string,
  title: string,
  content: string,
  applicability: DecisionApplicability | null = null,
  excludeProposalId: string | null = null,
): Promise<{ kind: "memory" | "proposal"; id: string } | null> {
  const memory = await q.query<{ id: string }>(
    `${READABLE_MEMORIES_SQL} AND m.project_id = $3 AND m.status = 'approved'
       AND ${sameTextSql("r.title", "$4")} AND ${sameTextSql("r.content", "$5")} AND r.applicability IS NOT DISTINCT FROM $6::jsonb
     LIMIT 1`,
    [caller.id, accessFreshSince(ctx), projectId, title, content, applicabilityJson(applicability)],
  );
  if (memory.rows[0]) return { kind: "memory", id: memory.rows[0].id };
  const own = await q.query<{ id: string }>(
    `SELECT id FROM memory_proposals
     WHERE project_id = $1 AND proposed_by = $2 AND status = 'pending'
       AND id IS DISTINCT FROM $5::uuid
       AND applicability IS NOT DISTINCT FROM $6::jsonb
       AND ${sameTextSql("title", "$3")} AND ${sameTextSql("content", "$4")}
     LIMIT 1`,
    [projectId, caller.id, title, content, excludeProposalId, applicabilityJson(applicability)],
  );
  if (own.rows[0]) return { kind: "proposal", id: own.rows[0].id };
  const visible = await q.query<{ id: string }>(
    `${READABLE_PROPOSALS_SQL} AND mp.project_id = $5 AND mp.status = 'pending'
       AND mp.id IS DISTINCT FROM $8::uuid
       AND mp.applicability IS NOT DISTINCT FROM $9::jsonb
       AND ${sameTextSql("mp.title", "$6")} AND ${sameTextSql("mp.content", "$7")}
     LIMIT 1`,
    [
      ...proposalReadParams(ctx, caller),
      projectId,
      title,
      content,
      excludeProposalId,
      applicabilityJson(applicability),
    ],
  );
  return visible.rows[0] ? { kind: "proposal", id: visible.rows[0].id } : null;
}

/** The cited sources, which must all be in the project and readable by the caller now. */
async function readableEvidence(
  tx: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  projectId: string,
  sourceIds: readonly string[],
): Promise<Evidence[]> {
  const { rows } = await tx.query<Evidence>(
    `SELECT s.id AS "sourceId", s.reference, s.url, s.revision, s.excerpt,
            s.captured_at AS "capturedAt", s.content_flags AS flags
     FROM sources s
     JOIN source_read_access sra
       ON sra.source_id = s.id AND sra.principal_id = $1 AND sra.access_observed_at >= $2
     WHERE s.project_id = $3 AND s.id = ANY($4::uuid[])
     ORDER BY s.id`,
    [caller.id, accessFreshSince(ctx), projectId, sourceIds],
  );
  if (rows.length !== sourceIds.length) {
    throw new ValidationError(
      "Every evidence source must belong to this project and be readable by you",
    );
  }
  return rows;
}

/** Keeps a copy of one proposal version and the sources it cites. */
async function saveProposalVersion(
  tx: Queryable,
  proposal: Proposal,
  evidenceSourceIds: readonly string[],
  authorId: string,
  at: Date,
  changeNote: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO proposal_revisions (project_id, proposal_id, revision, type, title, content,
                                     owner_id, content_flags, authored_by, authored_at,
                                     change_note, applicability, applicability_connection_id, base_status_generation)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, applicability, applicability_connection_id, base_status_generation
     FROM memory_proposals WHERE id=$2`,
    [
      proposal.projectId,
      proposal.id,
      proposal.revision,
      proposal.type,
      proposal.title,
      proposal.content,
      proposal.ownerId,
      proposal.flags,
      authorId,
      at,
      changeNote,
    ],
  );
  await tx.query(
    `INSERT INTO proposal_revision_evidence (project_id, proposal_id, revision, source_id)
     SELECT $1, $2, $3, unnest($4::uuid[])`,
    [proposal.projectId, proposal.id, proposal.revision, evidenceSourceIds],
  );
}

/** True when the principal wrote any version of the proposal. */
async function isProposalAuthor(
  q: Queryable,
  proposalId: string,
  principalId: string,
): Promise<boolean> {
  const { rows } = await q.query(
    "SELECT 1 FROM proposal_revisions WHERE proposal_id = $1 AND authored_by = $2",
    [proposalId, principalId],
  );
  return rows.length > 0;
}

/**
 * Stores pull request evidence from a repository connected to the project. The caller must be able to read it.
 * Recording the same evidence again returns the first record. Text that looks like a secret is refused.
 */
export async function recordSource(
  ctx: MemoryNetContext,
  callerId: string,
  input: {
    projectId: string;
    provider: Provider;
    externalRepositoryId: string;
    reference: string;
    url: string;
    revision?: string;
    excerpt: string;
  },
): Promise<Source> {
  const projectId = requireId(input.projectId, "projectId");
  const provider = requireOneOf(input.provider, PROVIDERS, "provider");
  const externalRepositoryId = requireGithubId(
    input.externalRepositoryId,
    "externalRepositoryId",
  );
  const pullNumber = requirePullRequestReference(input.reference, "reference");
  const reference = `pull/${pullNumber}`;
  const url = requireHttpsUrl(input.url, "url");
  const revision = optionalCommitSha(input.revision, "revision");
  const excerpt = requireText(
    input.excerpt,
    "excerpt",
    EXCERPT_MAX_LENGTH,
    true,
  );
  requireNoSecrets(excerpt, "excerpt");
  const flags: ContentFlag[] = mayContainPersonalData(excerpt)
    ? ["personal_data"]
    : [];
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    const scope = await resolveScope(tx, { level: "project", id: projectId });
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.propose,
      "record sources",
    );
    const connected = await tx.query<{ full_name: string }>(
      `SELECT full_name FROM repository_connections
       WHERE project_id = $1 AND provider = $2 AND external_repository_id = $3
         AND disconnected_at IS NULL`,
      [projectId, provider, externalRepositoryId],
    );
    const connection = connected.rows[0];
    if (!connection) {
      throw new ValidationError(
        "This repository is not connected to the project",
      );
    }
    const canRead = await hasFreshRepositoryAccess(
      tx,
      caller.id,
      provider,
      externalRepositoryId,
      accessFreshSince(ctx),
    );
    if (!canRead) {
      throw new ForbiddenError(
        "You do not currently have access to this repository",
      );
    }
    if (!isPullRequestUrl(url, pullNumber, connection.full_name)) {
      throw new ValidationError(
        `url must link to ${reference} of ${connection.full_name} on github.com`,
      );
    }
    const now = ctx.now();
    const { rows } = await tx.query<SourceRow>(
      `INSERT INTO sources (project_id, provider, external_repository_id, reference, url,
                            revision, excerpt, captured_by, captured_at, capture_method,
                            content_flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', $10::text[])
       ON CONFLICT (project_id, provider, external_repository_id, reference, revision,
                    md5(excerpt))
         WHERE capture_method = 'manual' DO NOTHING
       RETURNING ${SOURCE_COLUMNS}`,
      [
        projectId,
        provider,
        externalRepositoryId,
        reference,
        url,
        revision,
        excerpt,
        caller.id,
        now,
        flags,
      ],
    );
    const inserted = rows[0];
    if (!inserted) {
      const existing = await tx.query<SourceRow>(
        `SELECT ${SOURCE_COLUMNS} FROM sources
         WHERE capture_method = 'manual' AND project_id = $1 AND provider = $2
           AND external_repository_id = $3 AND reference = $4
           AND revision IS NOT DISTINCT FROM $5::text AND excerpt = $6`,
        [
          projectId,
          provider,
          externalRepositoryId,
          reference,
          revision,
          excerpt,
        ],
      );
      return mapSource(firstRow(existing.rows));
    }
    const source = mapSource(inserted);
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "source.recorded",
      organizationId: scope.organizationId,
      projectId,
      targetType: "source",
      targetId: source.id,
      details: { reference, ...flagDetails(flags) },
    });
    return source;
  });
}

/**
 * Creates a pending proposal. Every evidence source must be in the project and readable by the caller.
 * The owner defaults to the caller when the caller is a person; agents must name one.
 * Text that looks like a secret is refused, and so is a copy of knowledge the caller can already see.
 */
export async function proposeMemory(
  ctx: MemoryNetContext,
  callerId: string,
  input: {
    projectId: string;
    type: MemoryType;
    title: string;
    content: string;
    evidenceSourceIds: string[];
    ownerId?: string;
    applicability?: DecisionApplicabilityInput | null;
  },
): Promise<Proposal> {
  const projectId = requireId(input.projectId, "projectId");
  const type = requireOneOf(input.type, MEMORY_TYPES, "type");
  const title = requireText(input.title, "title", TITLE_MAX_LENGTH);
  const content = requireText(
    input.content,
    "content",
    CONTENT_MAX_LENGTH,
    true,
  );
  requireNoSecrets(title, "title");
  requireNoSecrets(content, "content");
  const flags: ContentFlag[] = mayContainPersonalData(`${title}\n${content}`)
    ? ["personal_data"]
    : [];
  const evidenceSourceIds = requireIds(
    input.evidenceSourceIds,
    "evidenceSourceIds",
    MAX_EVIDENCE_SOURCES,
  ).sort();
  const requestedOwnerId =
    input.ownerId === undefined ? null : requireId(input.ownerId, "ownerId");
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    const scope = await resolveScope(tx, { level: "project", id: projectId });
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.propose,
      "propose memories",
    );
    const ownerId =
      requestedOwnerId ?? (caller.kind === "human" ? caller.id : null);
    if (ownerId === null) {
      throw new ValidationError("Agents must name a person as ownerId");
    }
    if (!(await isEligibleOwner(tx, ownerId, projectId))) {
      throw new ValidationError(
        "ownerId must be a person with a role in this project",
      );
    }
    return saveNewProposal(tx, ctx, caller, scope, {
      projectId,
      type,
      title,
      content,
      ownerId,
      flags,
      evidenceSourceIds,
      change: null,
      applicability: normalizeDecisionApplicability(input.applicability),
    });
  });
}

interface NewProposal {
  projectId: string;
  type: MemoryType;
  title: string;
  content: string;
  ownerId: string;
  flags: ContentFlag[];
  evidenceSourceIds: string[];
  applicability: DecisionApplicability | null;
  /** Null for a new memory; otherwise the memory it changes and the version it builds on. */
  change: {
    kind: Exclude<ChangeKind, "new">;
    targetMemoryId: string;
    baseRevision: number;
    restoredFromRevision: number | null;
    baseStatusGeneration: number;
  } | null;
}

/** The checks and writes every proposal shares: readable evidence, no copies, version 1 kept, audited. */
async function saveNewProposal(
  tx: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  scope: Scope,
  fields: NewProposal,
): Promise<Proposal> {
  const connectionId = await requireDecisionApplicabilityAccess(tx, ctx, caller, fields.projectId, fields.applicability);
  const readable = await readableEvidence(
    tx,
    ctx,
    caller,
    fields.projectId,
    fields.evidenceSourceIds,
  );
  // Lets only one proposal at a time in this project pass the duplicate check.
  await tx.query("SELECT id FROM projects WHERE id = $1 FOR NO KEY UPDATE", [
    fields.projectId,
  ]);
  const identical = await findIdenticalKnowledge(
    tx,
    ctx,
    caller,
    fields.projectId,
    fields.title,
    fields.content,
    fields.applicability,
  );
  if (identical?.kind === "memory") {
    throw new ConflictError(
      `This is already approved knowledge (memory ${identical.id})`,
    );
  }
  if (identical) {
    throw new ConflictError(
      `The same proposal is already waiting for review (proposal ${identical.id})`,
    );
  }
  const now = ctx.now();
  const change = fields.change;
  const { rows } = await tx.query<ProposalRow>(
    `INSERT INTO memory_proposals (project_id, type, title, content, owner_id, status,
                                   revision, proposed_by, proposed_at, content_flags,
                                   change_kind, target_memory_id, base_revision,
                                   restored_from_revision, applicability, applicability_connection_id, base_status_generation)
     VALUES ($1, $2, $3, $4, $5, 'pending', 1, $6, $7, $8::text[], $9, $10, $11, $12, $13::jsonb, $14, $15)
     RETURNING ${PROPOSAL_RETURNING}`,
    [
      fields.projectId,
      fields.type,
      fields.title,
      fields.content,
      fields.ownerId,
      caller.id,
      now,
      fields.flags,
      change?.kind ?? "new",
      change?.targetMemoryId ?? null,
      change?.baseRevision ?? null,
      change?.restoredFromRevision ?? null,
      applicabilityJson(fields.applicability), connectionId, change?.baseStatusGeneration ?? null,
    ],
  );
  const proposal = mapProposal(firstRow(rows));
  await tx.query(
    `INSERT INTO proposal_evidence (project_id, proposal_id, source_id)
     SELECT $1, $2, unnest($3::uuid[])`,
    [fields.projectId, proposal.id, fields.evidenceSourceIds],
  );
  await saveProposalVersion(
    tx,
    proposal,
    fields.evidenceSourceIds,
    caller.id,
    now,
    null,
  );
  await recordAudit(tx, {
    occurredAt: now,
    actorId: caller.id,
    action: change === null ? "memory.proposed" : "memory.change_proposed",
    organizationId: scope.organizationId,
    projectId: fields.projectId,
    targetType: "memory_proposal",
    targetId: proposal.id,
    details: {
      type: fields.type,
      revision: proposal.revision,
      ownerId: fields.ownerId,
      ...(change === null
        ? {}
        : {
            changeKind: change.kind,
            memoryId: change.targetMemoryId,
            baseRevision: change.baseRevision,
          }),
      ...flagDetails(fields.flags),
    },
  });
  return { ...proposal, evidence: readable };
}

/** A memory row locked for a change, so two changes to one memory cannot pass together. */
export async function lockChangeTarget(
  tx: Queryable,
  memoryId: string,
): Promise<{
  id: string;
  project_id: string;
  status: MemoryStatus;
  current_revision: number;
  owner_id: string;
  status_generation: number;
}> {
  const { rows } = await tx.query<{
    id: string;
    project_id: string;
    status: MemoryStatus;
    current_revision: number;
    owner_id: string;
    status_generation: number;
  }>(
    `SELECT id, project_id, status, current_revision, owner_id, status_generation FROM memories
     WHERE id = $1 FOR UPDATE`,
    [memoryId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Memory not found");
  return row;
}

/** Proposes changing an approved or suspended memory: a new version of it, or a new memory that replaces it. */
export async function proposeChange(
  ctx: MemoryNetContext,
  callerId: string,
  input: {
    memoryId: string;
    /** The memory version the caller saw; the change builds on it. */
    expectedRevision: number;
    kind: "revise" | "replace";
    type: MemoryType;
    title: string;
    content: string;
    evidenceSourceIds: string[];
    ownerId?: string;
    applicability?: DecisionApplicabilityInput | null;
  },
): Promise<Proposal> {
  const memoryId = requireId(input.memoryId, "memoryId");
  const expectedRevision = requirePositiveInteger(
    input.expectedRevision,
    "expectedRevision",
  );
  const kind = requireOneOf(input.kind, ["revise", "replace"] as const, "kind");
  const type = requireOneOf(input.type, MEMORY_TYPES, "type");
  const title = requireText(input.title, "title", TITLE_MAX_LENGTH);
  const content = requireText(
    input.content,
    "content",
    CONTENT_MAX_LENGTH,
    true,
  );
  requireNoSecrets(title, "title");
  requireNoSecrets(content, "content");
  const flags: ContentFlag[] = mayContainPersonalData(`${title}\n${content}`)
    ? ["personal_data"]
    : [];
  const evidenceSourceIds = requireIds(
    input.evidenceSourceIds,
    "evidenceSourceIds",
    MAX_EVIDENCE_SOURCES,
  ).sort();
  const requestedOwnerId =
    input.ownerId === undefined ? null : requireId(input.ownerId, "ownerId");
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    const memory = await findReadableMemory(tx, ctx, caller, memoryId);
    if (!memory) throw new NotFoundError("Memory not found");
    const scope = await resolveScope(tx, {
      level: "project",
      id: memory.projectId,
    });
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.propose,
      "propose changes",
    );
    requireChangeable(memory, expectedRevision);
    const applicability = input.applicability === undefined ? memory.applicability : normalizeDecisionApplicability(input.applicability);
    if (!sameApplicability(applicability, memory.applicability)) throw new ValidationError("A targeted change must preserve the exact reviewed applicability; create a new decision for another scope");
    const ownerId =
      requestedOwnerId ??
      (kind === "revise"
        ? memory.ownerId
        : caller.kind === "human"
          ? caller.id
          : memory.ownerId);
    if (!(await isEligibleOwner(tx, ownerId, memory.projectId))) {
      throw new ValidationError(
        "ownerId must be a person with a role in this project",
      );
    }
    return saveNewProposal(tx, ctx, caller, scope, {
      projectId: memory.projectId,
      type,
      title,
      content,
      ownerId,
      flags,
      evidenceSourceIds,
      applicability,
      change: {
        kind,
        targetMemoryId: memory.id,
        baseRevision: memory.revision,
        restoredFromRevision: null,
        baseStatusGeneration: memory.statusGeneration,
      },
    });
  });
}

/** Proposes bringing back an earlier version of a memory as its next version. It still needs review. */
export async function proposeRestore(
  ctx: MemoryNetContext,
  callerId: string,
  input: { memoryId: string; expectedRevision: number; fromRevision: number; applicability?: DecisionApplicabilityInput | null },
): Promise<Proposal> {
  const memoryId = requireId(input.memoryId, "memoryId");
  const expectedRevision = requirePositiveInteger(
    input.expectedRevision,
    "expectedRevision",
  );
  const fromRevision = requirePositiveInteger(
    input.fromRevision,
    "fromRevision",
  );
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    const memory = await findReadableMemory(tx, ctx, caller, memoryId);
    if (!memory) throw new NotFoundError("Memory not found");
    const scope = await resolveScope(tx, {
      level: "project",
      id: memory.projectId,
    });
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.propose,
      "propose changes",
    );
    requireChangeable(memory, expectedRevision);
    if (memory.status === "revoked") throw new ConflictError("A revoked decision needs a newly authored and reviewed change; it cannot be restored");
    if (fromRevision >= memory.revision) {
      throw new ValidationError("Choose an earlier version to restore");
    }
    const earlier = await tx.query<{
      type: MemoryType;
      title: string;
      content: string;
      source_ids: string[];
      applicability: DecisionApplicabilityInput | null;
    }>(
      `SELECT r.type, r.title, r.content, r.applicability,
              COALESCE((SELECT array_agg(me.source_id::text ORDER BY me.source_id)
                        FROM memory_evidence me
                        WHERE me.memory_id = r.memory_id AND me.revision = r.revision),
                       '{}') AS source_ids
       FROM memory_revisions r WHERE r.memory_id = $1 AND r.revision = $2`,
      [memory.id, fromRevision],
    );
    const version = earlier.rows[0];
    if (!version) throw new NotFoundError("That version does not exist");
    const applicability = input.applicability === undefined ? normalizeDecisionApplicability(version.applicability) : normalizeDecisionApplicability(input.applicability);
    if (!sameApplicability(applicability, memory.applicability)) throw new ValidationError("A restore must preserve the exact reviewed applicability");
    const ownerId = (await isEligibleOwner(
      tx,
      memory.ownerId,
      memory.projectId,
    ))
      ? memory.ownerId
      : caller.kind === "human"
        ? caller.id
        : null;
    if (ownerId === null) {
      throw new ValidationError(
        "The memory's owner no longer has a role in this project; a person must propose the restore",
      );
    }
    return saveNewProposal(tx, ctx, caller, scope, {
      projectId: memory.projectId,
      type: version.type,
      title: version.title,
      content: version.content,
      ownerId,
      flags: mayContainPersonalData(`${version.title}\n${version.content}`)
        ? ["personal_data"]
        : [],
      evidenceSourceIds: version.source_ids,
      applicability,
      change: {
        kind: "restore",
        targetMemoryId: memory.id,
        baseRevision: memory.revision,
        restoredFromRevision: fromRevision,
        baseStatusGeneration: memory.statusGeneration,
      },
    });
  });
}

function requireChangeable(memory: Memory, expectedRevision: number): void {
  if (memory.status === "superseded") {
    throw new ConflictError(
      "This memory was replaced; propose the change to the memory that replaced it",
    );
  }
  if (memory.revision !== expectedRevision) {
    throw new ConflictError(
      `The memory changed since you opened it: it is now at version ${memory.revision}. Reload and try again.`,
    );
  }
}

/** Checks shared by approval and rejection: a different person with the reviewer role, naming the exact pending revision. */
async function startReview(
  tx: Queryable,
  ctx: MemoryNetContext,
  callerId: string,
  proposalId: string,
  expectedRevision: number,
): Promise<{ caller: Principal; proposal: Proposal; scope: Scope }> {
  const caller = await requireCaller(tx, callerId);
  requireHuman(caller, "review memories");
  const proposal = await findReadableProposal(tx, ctx, caller, proposalId);
  if (!proposal) throw new NotFoundError("Proposal not found");
  const scope = await resolveScope(tx, {
    level: "project",
    id: proposal.projectId,
  });
  await requireRole(tx, caller, scope, MINIMUM_ROLE.review, "review memories");
  if (proposal.proposedBy === caller.id) {
    throw new ForbiddenError("A different person must review this proposal");
  }
  if (await isProposalAuthor(tx, proposal.id, caller.id)) {
    throw new ForbiddenError(
      "A different person must review this proposal, because you wrote one of its versions",
    );
  }
  if (proposal.status !== "pending") {
    throw new ConflictError("This proposal has already been reviewed");
  }
  if (proposal.revision !== expectedRevision) {
    throw new ConflictError(
      "The proposal has changed; review the latest revision",
    );
  }
  return { caller, proposal, scope };
}

/** Records the review on the exact pending revision. A concurrent change becomes a conflict. */
async function closeProposal(
  tx: Queryable,
  proposal: Proposal,
  review: {
    status: "approved" | "rejected";
    reviewerId: string;
    at: Date;
    reason: string | null;
    memoryId: string | null;
  },
): Promise<void> {
  const updated = await tx.query(
    `UPDATE memory_proposals
     SET status = $2, reviewed_by = $3, reviewed_at = $4, review_reason = $5, memory_id = $6
     WHERE id = $1 AND status = 'pending' AND revision = $7
     RETURNING id`,
    [
      proposal.id,
      review.status,
      review.reviewerId,
      review.at,
      review.reason,
      review.memoryId,
      proposal.revision,
    ],
  );
  if (updated.rows.length === 0) {
    throw new ConflictError("The proposal changed while you were reviewing it");
  }
}

/** Publishes the exact proposal revision the reviewer saw as approved knowledge with a new stable ID. */
export async function approveProposal(
  ctx: MemoryNetContext,
  callerId: string,
  input: { proposalId: string; expectedRevision: number; reason?: string },
): Promise<Memory> {
  const proposalId = requireId(input.proposalId, "proposalId");
  const expectedRevision = requirePositiveInteger(
    input.expectedRevision,
    "expectedRevision",
  );
  const reason = optionalText(input.reason, "reason", REASON_MAX_LENGTH);
  return ctx.db.transaction(async (tx) => {
    const { caller, proposal, scope } = await startReview(
      tx,
      ctx,
      callerId,
      proposalId,
      expectedRevision,
    );
    if (!(await isEligibleOwner(tx, proposal.ownerId, proposal.projectId))) {
      throw new ConflictError(
        "The proposed owner no longer has a role in this project; reject it and propose it again with a current owner",
      );
    }
    await requireDecisionApplicabilityAccess(tx, ctx, caller, proposal.projectId, proposal.applicability);
    const now = ctx.now();
    const target =
      proposal.targetMemoryId === null
        ? null
        : await lockChangeTarget(tx, proposal.targetMemoryId);
    if (target) requireCurrentBase(target, proposal);
    if (target) {
      const targetMemory = await findReadableMemory(tx, ctx, caller, target.id);
      if (!targetMemory || !sameApplicability(targetMemory.applicability, proposal.applicability)) throw new ConflictError("The change has different applicability than its current target");
    }
    const keepsId =
      target !== null &&
      (proposal.changeKind === "revise" || proposal.changeKind === "restore");
    let memoryId: string;
    let revision: number;
    if (target && keepsId) {
      memoryId = target.id;
      revision = target.current_revision + 1;
    } else {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO memories (project_id, owner_id, status, current_revision, created_at)
         VALUES ($1, $2, 'approved', 1, $3) RETURNING id`,
        [proposal.projectId, proposal.ownerId, now],
      );
      memoryId = firstRow(rows).id;
      revision = 1;
    }
    await closeProposal(tx, proposal, {
      status: "approved",
      reviewerId: caller.id,
      at: now,
      reason,
      memoryId,
    });
    await publishRevision(tx, proposal, memoryId, revision, caller.id, now);
    if (target && keepsId) {
      await tx.query(
        "UPDATE memories SET current_revision = $2, owner_id = $3 WHERE id = $1",
        [memoryId, revision, proposal.ownerId],
      );
      if (target.status === "suspended" || target.status === "revoked") {
        await setMemoryStatus(tx, target, "approved", caller.id, now, {
          reason: `Resolved by approving version ${revision}`,
          revision,
        });
      }
      await resolveReports(
        tx,
        memoryId,
        caller.id,
        now,
        proposal.changeKind === "restore" ? "restored" : "revised",
      );
    }
    if (target && proposal.changeKind === "replace") {
      await setMemoryStatus(tx, target, "superseded", caller.id, now, {
        reason: reason ?? "Replaced by a newer memory",
        revision: target.current_revision,
        supersededBy: memoryId,
      });
      await resolveReports(tx, target.id, caller.id, now, "replaced");
    }
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: APPROVAL_ACTION[proposal.changeKind],
      organizationId: scope.organizationId,
      projectId: proposal.projectId,
      targetType: "memory",
      targetId: memoryId,
      reason,
      details: {
        proposalId: proposal.id,
        proposalRevision: proposal.revision,
        revision,
        ...(target
          ? { changedMemoryId: target.id, baseRevision: proposal.baseRevision }
          : {}),
      },
    });
    const memory = await findReadableMemory(tx, ctx, caller, memoryId);
    if (!memory)
      throw new Error("The approver cannot read the memory they approved");
    return memory;
  });
}

const APPROVAL_ACTION: Readonly<Record<ChangeKind, string>> = {
  new: "memory.approved",
  revise: "memory.revised",
  restore: "memory.restored",
  replace: "memory.replaced",
};

/** A change must build on the memory's current version, and a replaced memory cannot change. */
function requireCurrentBase(
  target: { status: MemoryStatus; current_revision: number; status_generation: number },
  proposal: Proposal,
): void {
  if (target.status === "superseded") {
    throw new ConflictError(
      "This memory was replaced after the proposal was written; reject the proposal, or propose the change to its replacement",
    );
  }
  if (target.current_revision !== proposal.baseRevision) {
    throw new ConflictError(
      `The memory changed after this proposal was written: it is now at version ${target.current_revision}, and the proposal builds on version ${proposal.baseRevision}. Edit the proposal to build on the latest version, or reject it.`,
    );
  }
  if (target.status_generation !== proposal.baseStatusGeneration) throw new ConflictError("The target status changed since this proposal was authored; reject or explicitly rebase it for a new review");
}

/** Copies the approved proposal version into a memory version, with its evidence. */
async function publishRevision(
  tx: Queryable,
  proposal: Proposal,
  memoryId: string,
  revision: number,
  approverId: string,
  at: Date,
): Promise<void> {
  await tx.query(
    `INSERT INTO memory_revisions (project_id, memory_id, revision, type, title, content,
                                   proposal_id, proposal_revision, approved_by, approved_at, applicability, applicability_connection_id)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, applicability, applicability_connection_id
     FROM proposal_revisions WHERE proposal_id=$7 AND revision=$8`,
    [
      proposal.projectId,
      memoryId,
      revision,
      proposal.type,
      proposal.title,
      proposal.content,
      proposal.id,
      proposal.revision,
      approverId,
      at,
    ],
  );
  await tx.query(
    `INSERT INTO memory_evidence (project_id, memory_id, revision, source_id)
     SELECT project_id, $2, $3, source_id FROM proposal_evidence WHERE proposal_id = $1`,
    [proposal.id, memoryId, revision],
  );
}

/** Changes a memory's status and records who changed it, when, and why. Only people change a status. */
export async function setMemoryStatus(
  tx: Queryable,
  memory: { id: string; project_id: string; status: MemoryStatus },
  to: MemoryStatus,
  byId: string,
  at: Date,
  change: { reason: string; revision: number; supersededBy?: string },
): Promise<void> {
  await tx.query(
    `UPDATE memories
     SET status = $2, superseded_by = $3, status_changed_by = $4, status_changed_at = $5,
         status_reason = $6
     WHERE id = $1`,
    [memory.id, to, change.supersededBy ?? null, byId, at, change.reason],
  );
  await tx.query(
    `INSERT INTO memory_status_changes
       (project_id, memory_id, revision, from_status, to_status, changed_by, changed_at, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      memory.project_id,
      memory.id,
      change.revision,
      memory.status,
      to,
      byId,
      at,
      change.reason,
    ],
  );
}

export type ReportResolution =
  | "dismissed"
  | "revised"
  | "replaced"
  | "reinstated"
  | "restored";

/** Closes the open outdated-reports on a memory once a person has dealt with it. */
export async function resolveReports(
  tx: Queryable,
  memoryId: string,
  byId: string,
  at: Date,
  resolution: ReportResolution,
): Promise<void> {
  await tx.query(
    `UPDATE memory_reports SET resolved_by = $2, resolved_at = $3, resolution = $4
     WHERE memory_id = $1 AND resolved_at IS NULL`,
    [memoryId, byId, at, resolution],
  );
}

/** Rejects the exact proposal revision the reviewer saw. A reason is required. */
export async function rejectProposal(
  ctx: MemoryNetContext,
  callerId: string,
  input: { proposalId: string; expectedRevision: number; reason: string },
): Promise<Proposal> {
  const proposalId = requireId(input.proposalId, "proposalId");
  const expectedRevision = requirePositiveInteger(
    input.expectedRevision,
    "expectedRevision",
  );
  const reason = requireText(input.reason, "reason", REASON_MAX_LENGTH);
  return ctx.db.transaction(async (tx) => {
    const { caller, proposal, scope } = await startReview(
      tx,
      ctx,
      callerId,
      proposalId,
      expectedRevision,
    );
    const now = ctx.now();
    await closeProposal(tx, proposal, {
      status: "rejected",
      reviewerId: caller.id,
      at: now,
      reason,
      memoryId: null,
    });
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "memory.rejected",
      organizationId: scope.organizationId,
      projectId: proposal.projectId,
      targetType: "memory_proposal",
      targetId: proposal.id,
      reason,
      details: { revision: proposal.revision },
    });
    return {
      ...proposal,
      status: "rejected",
      reviewedBy: caller.id,
      reviewedAt: now,
      reviewReason: reason,
    };
  });
}

/** One version of a proposal, as its history shows it. */
export interface ProposalVersion {
  revision: number;
  authoredBy: string;
  authoredAt: Date;
  changeNote: string | null;
  /** False when this version cites a source the caller cannot read now; its text is then left out. */
  readable: boolean;
  type: MemoryType | null;
  title: string | null;
  content: string | null;
  ownerId: string | null;
  flags: ContentFlag[];
  evidenceSourceIds: string[];
  applicability: DecisionApplicability | null;
  baseStatusGeneration: number | null;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Saves a new version of a pending proposal. Its proposer or a reviewer may edit it, naming the version they
 * changed, so two edits at once become a visible conflict. The new version passes the same checks as a new
 * proposal. Whoever writes a version can no longer review the proposal.
 */
export async function editProposal(
  ctx: MemoryNetContext,
  callerId: string,
  input: {
    proposalId: string;
    expectedRevision: number;
    type: MemoryType;
    title: string;
    content: string;
    evidenceSourceIds: string[];
    ownerId: string;
    changeNote?: string;
    /** For a change to a memory: build on this memory version instead, which must be its current one. */
    baseRevision?: number;
    applicability?: DecisionApplicabilityInput | null;
  },
): Promise<Proposal> {
  const proposalId = requireId(input.proposalId, "proposalId");
  const expectedRevision = requirePositiveInteger(
    input.expectedRevision,
    "expectedRevision",
  );
  const baseRevision =
    input.baseRevision === undefined
      ? null
      : requirePositiveInteger(input.baseRevision, "baseRevision");
  const type = requireOneOf(input.type, MEMORY_TYPES, "type");
  const title = requireText(input.title, "title", TITLE_MAX_LENGTH);
  const content = requireText(
    input.content,
    "content",
    CONTENT_MAX_LENGTH,
    true,
  );
  const changeNote = optionalText(
    input.changeNote,
    "changeNote",
    REASON_MAX_LENGTH,
  );
  requireNoSecrets(title, "title");
  requireNoSecrets(content, "content");
  if (changeNote !== null) requireNoSecrets(changeNote, "changeNote");
  const flags: ContentFlag[] = mayContainPersonalData(`${title}\n${content}`)
    ? ["personal_data"]
    : [];
  const evidenceSourceIds = requireIds(
    input.evidenceSourceIds,
    "evidenceSourceIds",
    MAX_EVIDENCE_SOURCES,
  ).sort();
  const ownerId = requireId(input.ownerId, "ownerId");
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    requireHuman(caller, "edit proposals");
    const current = await findReadableProposal(tx, ctx, caller, proposalId);
    if (!current) throw new NotFoundError("Proposal not found");
    const scope = await resolveScope(tx, {
      level: "project",
      id: current.projectId,
    });
    const rank = await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.propose,
      "edit proposals",
    );
    if (
      current.proposedBy !== caller.id &&
      rank < ROLE_RANK[MINIMUM_ROLE.review]
    ) {
      throw new ForbiddenError(
        "Only the person who proposed it or a reviewer can edit this proposal",
      );
    }
    if (current.status !== "pending") {
      throw new ConflictError("This proposal has already been reviewed");
    }
    if (current.revision !== expectedRevision) {
      throw new ConflictError(
        `Someone changed this proposal since you opened it. Reload to see version ${current.revision}, then make your change again.`,
      );
    }
    const generated = await tx.query<{ found: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM decision_guard_publications WHERE proposal_id = $1) AS found",
      [proposalId],
    );
    if (generated.rows[0]?.found) {
      throw new ValidationError(
        "Model-generated proposals preserve their original text and source permissions. Reject with feedback and extract a new proposal instead of editing.",
      );
    }
    const applicability = input.applicability === undefined ? current.applicability : normalizeDecisionApplicability(input.applicability);
    const connectionId = await requireDecisionApplicabilityAccess(tx, ctx, caller, current.projectId, applicability);
    let baseStatusGeneration = current.baseStatusGeneration;
    if (current.targetMemoryId !== null) {
      const memory = await findReadableMemory(tx, ctx, caller, current.targetMemoryId);
      if (!memory || !sameApplicability(applicability, memory.applicability)) throw new ValidationError("A targeted change must preserve the exact reviewed applicability");
    }
    if (!(await isEligibleOwner(tx, ownerId, current.projectId))) {
      throw new ValidationError(
        "ownerId must be a person with a role in this project",
      );
    }
    if (baseRevision !== null) {
      if (current.targetMemoryId === null) {
        throw new ValidationError(
          "Only a change to a memory has a base version",
        );
      }
      const target = await lockChangeTarget(tx, current.targetMemoryId);
      if (target.current_revision !== baseRevision) {
        throw new ConflictError(
          `The memory is now at version ${target.current_revision}; build on that version`,
        );
      }
      baseStatusGeneration = target.status_generation;
    }
    const readable = await readableEvidence(
      tx,
      ctx,
      caller,
      current.projectId,
      evidenceSourceIds,
    );
    const unchanged =
      current.type === type &&
      current.title === title &&
      current.content === content &&
      current.ownerId === ownerId &&
      sameApplicability(current.applicability, applicability) && current.baseStatusGeneration === baseStatusGeneration &&
      (baseRevision === null || baseRevision === current.baseRevision) &&
      sameIds(
        current.evidence.map((item) => item.sourceId).sort(),
        evidenceSourceIds,
      );
    if (unchanged) {
      throw new ValidationError("Nothing changed, so no new version was saved");
    }
    await tx.query("SELECT id FROM projects WHERE id = $1 FOR NO KEY UPDATE", [
      current.projectId,
    ]);
    const identical = await findIdenticalKnowledge(
      tx,
      ctx,
      caller,
      current.projectId,
      title,
      content,
      applicability,
      current.id,
    );
    if (identical?.kind === "memory") {
      throw new ConflictError(
        `This is already approved knowledge (memory ${identical.id})`,
      );
    }
    if (identical) {
      throw new ConflictError(
        `The same proposal is already waiting for review (proposal ${identical.id})`,
      );
    }
    const now = ctx.now();
    const { rows } = await tx.query<ProposalRow>(
      `UPDATE memory_proposals
       SET type = $3, title = $4, content = $5, owner_id = $6, content_flags = $7::text[],
           revision = revision + 1, base_revision = COALESCE($8, base_revision),
           applicability=$9::jsonb, applicability_connection_id=$10, base_status_generation=$11
       WHERE id = $1 AND status = 'pending' AND revision = $2
       RETURNING ${PROPOSAL_RETURNING}`,
      [
        current.id,
        expectedRevision,
        type,
        title,
        content,
        ownerId,
        flags,
        baseRevision,
        applicabilityJson(applicability), connectionId, baseStatusGeneration,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new ConflictError(
        "Someone changed this proposal while you were editing it. Reload to see the latest version, then make your change again.",
      );
    }
    const proposal = mapProposal(row);
    await tx.query("DELETE FROM proposal_evidence WHERE proposal_id = $1", [
      proposal.id,
    ]);
    await tx.query(
      `INSERT INTO proposal_evidence (project_id, proposal_id, source_id)
       SELECT $1, $2, unnest($3::uuid[])`,
      [proposal.projectId, proposal.id, evidenceSourceIds],
    );
    await saveProposalVersion(
      tx,
      proposal,
      evidenceSourceIds,
      caller.id,
      now,
      changeNote,
    );
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "memory.proposal_edited",
      organizationId: scope.organizationId,
      projectId: proposal.projectId,
      targetType: "memory_proposal",
      targetId: proposal.id,
      reason: changeNote,
      details: {
        revision: proposal.revision,
        previousRevision: expectedRevision,
        ...flagDetails(flags),
      },
    });
    return { ...proposal, evidence: readable };
  });
}

/** Every version of a proposal the caller may see, oldest first. */
export async function getProposalHistory(
  ctx: MemoryNetContext,
  callerId: string,
  proposalId: string,
): Promise<ProposalVersion[]> {
  const id = requireId(proposalId, "proposalId");
  const caller = await requireCaller(ctx.db, callerId);
  if (!(await findReadableProposal(ctx.db, ctx, caller, id))) {
    throw new NotFoundError("Proposal not found");
  }
  const { rows } = await ctx.db.query<{
    revision: number;
    authored_by: string;
    authored_at: Date;
    change_note: string | null;
    type: MemoryType;
    title: string;
    content: string;
    owner_id: string;
    content_flags: ContentFlag[];
    source_ids: string[];
    readable: boolean;
    applicability: DecisionApplicabilityInput | null;
    base_status_generation: number | null;
  }>(
    `SELECT prv.revision, prv.authored_by, prv.authored_at, prv.change_note, prv.type,
            prv.title, prv.content, prv.owner_id, prv.content_flags, prv.applicability, prv.base_status_generation,
            COALESCE((SELECT array_agg(pre.source_id::text ORDER BY pre.source_id)
                      FROM proposal_revision_evidence pre
                      WHERE pre.proposal_id = prv.proposal_id AND pre.revision = prv.revision),
                     '{}') AS source_ids,
            NOT EXISTS (
              SELECT 1 FROM proposal_revision_evidence pre
              WHERE pre.proposal_id = prv.proposal_id AND pre.revision = prv.revision
                AND NOT EXISTS (
                  SELECT 1 FROM source_read_access sra
                  WHERE sra.principal_id = $2 AND sra.source_id = pre.source_id
                    AND sra.access_observed_at >= $3))
              AND (prv.applicability IS NULL OR EXISTS(SELECT 1 FROM repository_connections rc JOIN repository_access ra
                ON ra.provider=rc.provider AND ra.external_repository_id=rc.external_repository_id
                WHERE rc.id=prv.applicability_connection_id AND rc.disconnected_at IS NULL
                  AND ra.principal_id=$2 AND ra.can_read AND ra.observed_at >= $3)) AS readable
     FROM proposal_revisions prv
     WHERE prv.proposal_id = $1
     ORDER BY prv.revision`,
    [id, caller.id, accessFreshSince(ctx)],
  );
  return rows.map((row) => ({
    revision: row.revision,
    authoredBy: row.authored_by,
    authoredAt: row.authored_at,
    changeNote: row.change_note,
    readable: row.readable,
    type: row.readable ? row.type : null,
    title: row.readable ? row.title : null,
    content: row.readable ? row.content : null,
    ownerId: row.readable ? row.owner_id : null,
    flags: row.readable ? row.content_flags : [],
    evidenceSourceIds: row.readable ? row.source_ids : [],
    applicability: row.readable ? normalizeDecisionApplicability(row.applicability) : null,
    baseStatusGeneration: row.readable ? row.base_status_generation : null,
  }));
}

/** Pending proposals the caller may review now: they are a reviewer there and wrote none of the versions. Oldest first. */
export async function listReviewQueue(
  ctx: MemoryNetContext,
  callerId: string,
  filter: { limit?: number } = {},
): Promise<Proposal[]> {
  const limit = optionalLimit(filter.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const caller = await requireCaller(ctx.db, callerId);
  const { rows } = await ctx.db.query<ProposalRow>(
    `${READABLE_PROPOSALS_SQL} AND mp.status = 'pending' AND epr.rank >= $5::int
       AND NOT EXISTS (SELECT 1 FROM proposal_revisions prv
                       WHERE prv.proposal_id = mp.id AND prv.authored_by = $1)
     ORDER BY mp.proposed_at, mp.id
     LIMIT $6`,
    [...proposalReadParams(ctx, caller), ROLE_RANK[MINIMUM_ROLE.review], limit],
  );
  return rows.map(mapProposal);
}

/** One approved memory the caller may read now. Proposals are never returned here. */
export async function getMemory(
  ctx: MemoryNetContext,
  callerId: string,
  memoryId: string,
): Promise<Memory> {
  const id = requireId(memoryId, "memoryId");
  const caller = await requireCaller(ctx.db, callerId);
  const memory = await findReadableMemory(ctx.db, ctx, caller, id);
  if (!memory) throw new NotFoundError("Memory not found");
  return memory;
}

/** Memories the caller may read now in one status (current by default; null for every status), newest approval first. A null limit returns all of them. */
export async function readableMemories(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  scope: ScopeRef | null,
  limit: number | null,
  status: MemoryStatus | null = "approved",
): Promise<Memory[]> {
  const params: unknown[] = [caller.id, accessFreshSince(ctx)];
  const sql = withFilters(
    READABLE_MEMORIES_SQL,
    params,
    scope,
    status === null ? [] : [["m.status", status]],
    "r.approved_at DESC, m.id",
    limit,
  );
  const { rows } = await q.query<MemoryRow>(sql, params);
  return rows.map(mapMemory);
}

// The memory's title outranks its type and text, which outrank the evidence it cites.
// A reference such as pull/42 becomes "pull 42", so "#42" finds it too.
const SEARCH_DOCUMENT_SQL = `
  setweight(to_tsvector('english', readable.title), 'A')
  || setweight(to_tsvector('english', replace(readable.type, '_', ' ') || ' ' || readable.content), 'B')
  || setweight(to_tsvector('english', coalesce(
       (SELECT string_agg(replace(e->>'reference', '/', ' ') || ' ' || (e->>'excerpt'), ' ')
        FROM json_array_elements(readable.evidence) e), '')), 'C')`;

/**
 * Memories in one project that the caller may read now, in any status, matching any word of the search,
 * best first: at most `current` current memories and `notCurrent` others. Uses PostgreSQL's English text
 * search, so "retries" also finds "retry". `terms` is what was searched; it is empty, and nothing is
 * searched, when every word is too common to search.
 */
export async function searchReadableMemories(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  projectId: string,
  search: string,
  limits: { current: number; notCurrent: number },
  applicability?: DecisionContextScope,
): Promise<{ terms: string; matches: Memory[] }> {
  // Any word may match; more matching words rank higher. The cast keeps the words as already stemmed.
  const { rows: parsed } = await q.query<{ terms: string }>(
    "SELECT replace(plainto_tsquery('english', $1)::text, ' & ', ' | ') AS terms",
    [search],
  );
  const terms = parsed[0]?.terms ?? "";
  if (terms === "") return { terms, matches: [] };
  const { rows } = await q.query<MemoryRow>(
    `WITH readable AS (${READABLE_MEMORIES_SQL} AND m.project_id = $3
       ${applicability ? "AND r.applicability->>'repositoryId'=$7 AND r.applicability->>'branch'=$8 AND (r.applicability->>'validFrom')::timestamptz <= $9 AND (r.applicability->>'validUntil' IS NULL OR $9 < (r.applicability->>'validUntil')::timestamptz)" : ""}),
     matched AS (
       SELECT readable.*, ts_rank(${SEARCH_DOCUMENT_SQL}, $4::tsquery) AS rank
       FROM readable
       WHERE ${SEARCH_DOCUMENT_SQL} @@ $4::tsquery),
     numbered AS (
       SELECT matched.*, row_number() OVER (
         PARTITION BY matched.status = 'approved'
         ORDER BY matched.rank DESC, matched.approved_at DESC, matched.id) AS place
       FROM matched)
     SELECT id, project_id, owner_id, status, revision, type, title, content, proposal_id,
            proposal_revision, proposed_by, approved_by, approved_at, superseded_by,
            status_reason, status_changed_by, status_changed_at, status_generation, applicability, applicability_connection_id, evidence
     FROM numbered
     WHERE place <= CASE WHEN status = 'approved' THEN $5::int ELSE $6::int END
     ORDER BY status = 'approved' DESC, place`,
    [
      caller.id,
      accessFreshSince(ctx),
      projectId,
      terms,
      limits.current,
      limits.notCurrent,
      ...(applicability ? [applicability.repositoryId, applicability.branch, applicability.at] : []),
    ],
  );
  return { terms, matches: rows.map(mapMemory) };
}

/**
 * Per project in one organization: current memories the caller may read, the sources they cite,
 * and how many of those memories the caller owns. Counts only, under the same read rule as readableMemories.
 * Pass projectIds to count only those projects.
 */
export async function readableKnowledgeCounts(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  organizationId: string,
  projectIds?: readonly string[],
): Promise<Map<string, { memories: number; sources: number; owned: number }>> {
  const { rows } = await q.query<{
    project_id: string;
    memories: number;
    sources: number;
    owned: number;
  }>(
    `WITH readable AS (${READABLE_MEMORIES_SQL}
       AND m.status = 'approved' AND p.organization_id = $3
       ${projectIds === undefined ? "" : "AND m.project_id = ANY($4::uuid[])"})
     SELECT readable.project_id,
            count(DISTINCT readable.id)::int AS memories,
            count(DISTINCT me.source_id)::int AS sources,
            (count(DISTINCT readable.id) FILTER (WHERE readable.owner_id = $1))::int AS owned
     FROM readable
     LEFT JOIN memory_evidence me
       ON me.memory_id = readable.id AND me.revision = readable.revision
     GROUP BY readable.project_id`,
    projectIds === undefined
      ? [caller.id, accessFreshSince(ctx), organizationId]
      : [caller.id, accessFreshSince(ctx), organizationId, [...projectIds]],
  );
  return new Map(
    rows.map((row) => [
      row.project_id,
      { memories: row.memories, sources: row.sources, owned: row.owned },
    ]),
  );
}

/** Knowledge the caller may read now, optionally within one scope. Current memories unless a status is named; proposals are listed separately. */
export async function listMemories(
  ctx: MemoryNetContext,
  callerId: string,
  filter: { scope?: ScopeRef; status?: MemoryStatus; limit?: number } = {},
): Promise<Memory[]> {
  const scope =
    filter.scope === undefined ? null : requireScopeRef(filter.scope);
  const status =
    filter.status === undefined
      ? "approved"
      : requireOneOf(filter.status, MEMORY_STATUSES, "status");
  const limit = optionalLimit(filter.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const caller = await requireCaller(ctx.db, callerId);
  return readableMemories(ctx.db, ctx, caller, scope, limit, status);
}

/** One proposal. Only human contributors and above who can read all of its evidence may see it. */
export async function getProposal(
  ctx: MemoryNetContext,
  callerId: string,
  proposalId: string,
): Promise<Proposal> {
  const id = requireId(proposalId, "proposalId");
  const caller = await requireCaller(ctx.db, callerId);
  const proposal = await findReadableProposal(ctx.db, ctx, caller, id);
  if (!proposal) throw new NotFoundError("Proposal not found");
  return proposal;
}

/** Proposals the caller may see, newest first. Readers and agents get none. */
export async function listProposals(
  ctx: MemoryNetContext,
  callerId: string,
  filter: { scope?: ScopeRef; status?: ProposalStatus; limit?: number } = {},
): Promise<Proposal[]> {
  const scope =
    filter.scope === undefined ? null : requireScopeRef(filter.scope);
  const status =
    filter.status === undefined
      ? null
      : requireOneOf(filter.status, PROPOSAL_STATUSES, "status");
  const limit = optionalLimit(filter.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const caller = await requireCaller(ctx.db, callerId);
  const params = proposalReadParams(ctx, caller);
  const sql = withFilters(
    READABLE_PROPOSALS_SQL,
    params,
    scope,
    status === null ? [] : [["mp.status", status]],
    "mp.proposed_at DESC, mp.id",
    limit,
  );
  const { rows } = await ctx.db.query<ProposalRow>(sql, params);
  return rows.map(mapProposal);
}

export async function getSource(
  ctx: MemoryNetContext,
  callerId: string,
  sourceId: string,
): Promise<Source> {
  const id = requireId(sourceId, "sourceId");
  const caller = await requireCaller(ctx.db, callerId);
  const { rows } = await ctx.db.query<SourceRow>(
    `${READABLE_SOURCES_SQL} AND s.id = $3`,
    [caller.id, accessFreshSince(ctx), id],
  );
  if (!rows[0]) throw new NotFoundError("Source not found");
  return mapSource(rows[0]);
}

/** Sources the caller may read now, newest first, optionally within one scope. */
export async function listSources(
  ctx: MemoryNetContext,
  callerId: string,
  filter: { scope?: ScopeRef; limit?: number } = {},
): Promise<Source[]> {
  const scope =
    filter.scope === undefined ? null : requireScopeRef(filter.scope);
  const limit = optionalLimit(filter.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const caller = await requireCaller(ctx.db, callerId);
  const params: unknown[] = [caller.id, accessFreshSince(ctx)];
  const sql = withFilters(
    READABLE_SOURCES_SQL,
    params,
    scope,
    [],
    "s.captured_at DESC, s.id",
    limit,
  );
  const { rows } = await ctx.db.query<SourceRow>(sql, params);
  return rows.map(mapSource);
}
