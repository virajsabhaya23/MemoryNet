import {
  effectiveRank,
  findPrincipal,
  requireCaller,
  requireHuman,
  requireRole,
  requireScopeRef,
  resolveScope,
  scopeTargetId,
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
import type { MemoryNetContext } from "./context.ts";
import { firstRow, type Queryable } from "./db.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./errors.ts";
import { readableMemories, readableMemoriesByIds, type Memory } from "./knowledge.ts";
import { MINIMUM_ROLE, ROLE_RANK, roleForRank, type Role } from "./roles.ts";
import {
  optionalText,
  requireId,
  requireOneOf,
  requirePositiveInteger,
  requireText,
} from "./validation.ts";

/** Agents and skills describe AI work; instructions and rules guide people and AI alike. */
export const DEFINITION_KINDS = [
  "agent",
  "skill",
  "instruction",
  "rule",
] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

export const DEFINITION_STATUSES = ["active", "retired"] as const;
export type DefinitionStatus = (typeof DEFINITION_STATUSES)[number];

/** create: a new definition. change: a new version, which also restores older content. retire: stop using it. */
export const DEFINITION_ACTIONS = ["create", "change", "retire"] as const;
export type DefinitionAction = (typeof DEFINITION_ACTIONS)[number];

export const DEFINITION_PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;
export type DefinitionProposalStatus =
  (typeof DEFINITION_PROPOSAL_STATUSES)[number];

export const DEFINITION_RELATIONS = [
  "uses",
  "follows",
  "hands_off_to",
  "based_on",
] as const;
export type DefinitionRelation = (typeof DEFINITION_RELATIONS)[number];

/** Which kinds may make each link, and what it may point to. based_on points to an approved memory. */
export const LINK_RULES: Readonly<
  Record<
    DefinitionRelation,
    {
      from: readonly DefinitionKind[];
      to: ReadonlyArray<DefinitionKind | "memory">;
    }
  >
> = {
  uses: { from: ["agent", "skill"], to: ["skill"] },
  follows: { from: DEFINITION_KINDS, to: ["rule", "instruction"] },
  hands_off_to: { from: ["agent"], to: ["agent"] },
  based_on: { from: DEFINITION_KINDS, to: ["memory"] },
};

export interface DefinitionLink {
  relation: DefinitionRelation;
  /** A definition ID, or a memory ID when the relation is based_on. */
  targetId: string;
}

/** What a definition says. Proposals and approved versions share it. */
export interface DefinitionContent {
  name: string;
  /** One sentence: what it is for. */
  purpose: string;
  /** What it is responsible for (agents), does (skills), asks for (instructions), or requires (rules). */
  responsibilities: string[];
  /** What it must not do, is not for, does not cover, or does not apply to. */
  boundaries: string[];
  /** The full guidance text. Stored as data; MemoryNet never runs it. */
  instructions: string;
  /** When or where it applies, such as "every pull request in checkout-service". */
  appliesTo: string | null;
  /** The agent account an agent definition acts as. Agents only. */
  runsAs: string | null;
  /** The person accountable for keeping it correct. */
  ownerId: string;
  links: DefinitionLink[];
}

/** One approved version. */
export interface DefinitionVersion extends DefinitionContent {
  revision: number;
  status: DefinitionStatus;
  changeNote: string | null;
  flags: ContentFlag[];
  proposalId: string;
  proposedBy: string;
  approvedBy: string;
  approvedAt: Date;
}

/** A definition at its current approved version. The ID and kind never change. */
export interface Definition extends DefinitionVersion {
  id: string;
  kind: DefinitionKind;
  organizationId: string;
  scope: ScopeRef;
  createdAt: Date;
  /** The caller's role rank at the definition's own level; 0 when the caller only works inside it. */
  callerRank: number;
}

export interface DefinitionProposal extends DefinitionContent {
  id: string;
  organizationId: string;
  scope: ScopeRef;
  action: DefinitionAction;
  kind: DefinitionKind;
  /** Empty for a new definition until it is approved. */
  definitionId: string | null;
  /** The approved version a change was written against. */
  baseRevision: number | null;
  changeNote: string | null;
  flags: ContentFlag[];
  status: DefinitionProposalStatus;
  /** The proposal version a reviewer must name. */
  revision: number;
  proposedBy: string;
  proposedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewReason: string | null;
  /** The definition version this proposal became, once approved. */
  approvedRevision: number | null;
  callerRank: number;
}

/** Everything a definition page shows, limited to what the caller may see. */
export interface DefinitionView {
  definition: Definition;
  /** Every approved version, newest first. */
  history: DefinitionVersion[];
  /** Definitions the current version links to. */
  linkedDefinitions: Definition[];
  /** Approved memories the current version is based on. */
  linkedMemories: Memory[];
  /** Active definitions whose current version links to this one. */
  usedBy: Array<{ relation: DefinitionRelation; definition: Definition }>;
  /** Pending proposals for this definition; null when the caller may not see proposals. */
  pending: DefinitionProposal[] | null;
}

export interface DefinitionContentInput {
  name: string;
  purpose: string;
  responsibilities: string[];
  boundaries?: string[];
  instructions?: string;
  appliesTo?: string;
  runsAs?: string;
  ownerId?: string;
  links?: DefinitionLink[];
}

const NAME_MAX_LENGTH = 120;
const PURPOSE_MAX_LENGTH = 300;
const ITEM_MAX_LENGTH = 300;
const MAX_ITEMS = 20;
const INSTRUCTIONS_MAX_LENGTH = 20_000;
const APPLIES_TO_MAX_LENGTH = 300;
const NOTE_MAX_LENGTH = 500;
const MAX_LINKS = 30;

const KIND_ARTICLE: Readonly<Record<DefinitionKind, string>> = {
  agent: "An agent",
  skill: "A skill",
  instruction: "An instruction",
  rule: "A rule",
};

const RELATION_WORDS: Readonly<Record<DefinitionRelation, string>> = {
  uses: "uses",
  follows: "follows",
  hands_off_to: "hands off to",
  based_on: "is based on",
};

const TARGET_WORDS: Readonly<Record<DefinitionRelation, string>> = {
  uses: "a skill",
  follows: "a rule or an instruction",
  hands_off_to: "an agent",
  based_on: "an approved memory",
};

const SCOPE_TABLE: Readonly<Record<ScopeLevel, string>> = {
  organization: "organizations",
  business_unit: "business_units",
  project: "projects",
};

// The caller's rank at the row's own level, from the role views. Binds $1 caller.
function callerRankSql(alias: string): string {
  return `COALESCE(CASE
    WHEN ${alias}.project_id IS NOT NULL THEN
      (SELECT rank FROM effective_project_roles WHERE principal_id = $1 AND project_id = ${alias}.project_id)
    WHEN ${alias}.business_unit_id IS NOT NULL THEN
      (SELECT rank FROM effective_business_unit_roles WHERE principal_id = $1 AND business_unit_id = ${alias}.business_unit_id)
    ELSE
      (SELECT rank FROM effective_organization_roles WHERE principal_id = $1 AND organization_id = ${alias}.organization_id)
    END, 0)::int`;
}

function linksJson(table: string, where: string): string {
  return `COALESCE((SELECT json_agg(json_build_object('relation', l.relation,
      'targetId', COALESCE(l.target_definition_id, l.target_memory_id))
      ORDER BY l.relation, COALESCE(l.target_definition_id, l.target_memory_id))
    FROM ${table} l WHERE ${where}), '[]'::json) AS links`;
}

const VERSION_COLUMNS = `d.id, d.organization_id, d.business_unit_id, d.project_id, d.kind, d.created_at,
  r.revision, r.status, r.name, r.purpose, r.responsibilities, r.boundaries, r.instructions,
  r.applies_to, r.runs_as, r.owner_id, r.change_note, r.content_flags, r.proposal_id,
  dp.proposed_by, r.approved_by, r.approved_at,
  ${linksJson("definition_links", "l.definition_id = r.definition_id AND l.revision = r.revision")},
  ${callerRankSql("d")} AS caller_rank`;

// Binds $1 caller. Current versions of the definitions the caller may see.
const VISIBLE_DEFINITIONS_SQL = `
  SELECT ${VERSION_COLUMNS}
  FROM definitions d
  JOIN definition_revisions r ON r.definition_id = d.id AND r.revision = d.current_revision
  JOIN definition_proposals dp ON dp.id = r.proposal_id
  WHERE EXISTS (SELECT 1 FROM definition_read_access dra
                WHERE dra.definition_id = d.id AND dra.principal_id = $1)`;

// Binds $1 caller and $2 definition. Every approved version, newest first.
const VISIBLE_HISTORY_SQL = `
  SELECT ${VERSION_COLUMNS}
  FROM definitions d
  JOIN definition_revisions r ON r.definition_id = d.id
  JOIN definition_proposals dp ON dp.id = r.proposal_id
  WHERE d.id = $2
    AND EXISTS (SELECT 1 FROM definition_read_access dra
                WHERE dra.definition_id = d.id AND dra.principal_id = $1)
  ORDER BY r.revision DESC`;

// Binds $1 caller.
const PROPOSAL_SQL = `
  SELECT dp.id, dp.organization_id, dp.business_unit_id, dp.project_id, dp.action, dp.definition_id,
         dp.base_revision, dp.kind, dp.name, dp.purpose, dp.responsibilities, dp.boundaries,
         dp.instructions, dp.applies_to, dp.runs_as, dp.owner_id, dp.change_note, dp.content_flags,
         dp.status, dp.revision, dp.proposed_by, dp.proposed_at, dp.reviewed_by, dp.reviewed_at,
         dp.review_reason, dp.approved_revision,
         ${linksJson("definition_proposal_links", "l.proposal_id = dp.id")},
         ${callerRankSql("dp")} AS caller_rank
  FROM definition_proposals dp
  WHERE true`;

interface ScopeColumns {
  organization_id: string;
  business_unit_id: string | null;
  project_id: string | null;
}

interface ContentRow {
  name: string;
  purpose: string;
  responsibilities: string[];
  boundaries: string[];
  instructions: string;
  applies_to: string | null;
  runs_as: string | null;
  owner_id: string;
  change_note: string | null;
  content_flags: ContentFlag[];
  links: DefinitionLink[];
  caller_rank: number;
}

interface DefinitionRow extends ScopeColumns, ContentRow {
  id: string;
  kind: DefinitionKind;
  created_at: Date;
  revision: number;
  status: DefinitionStatus;
  proposal_id: string;
  proposed_by: string;
  approved_by: string;
  approved_at: Date;
}

interface ProposalRow extends ScopeColumns, ContentRow {
  id: string;
  action: DefinitionAction;
  definition_id: string | null;
  base_revision: number | null;
  kind: DefinitionKind;
  status: DefinitionProposalStatus;
  revision: number;
  proposed_by: string;
  proposed_at: Date;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_reason: string | null;
  approved_revision: number | null;
}

/** The scope stored in scope columns. A project row leaves business_unit_id empty. */
export function scopeRefOf(row: ScopeColumns): ScopeRef {
  if (row.project_id) return { level: "project", id: row.project_id };
  if (row.business_unit_id) {
    return { level: "business_unit", id: row.business_unit_id };
  }
  return { level: "organization", id: row.organization_id };
}

function scopeColumns(scope: Scope): [string, string | null, string | null] {
  if (scope.level === "organization") return [scope.organizationId, null, null];
  if (scope.level === "business_unit") {
    return [scope.organizationId, scope.businessUnitId, null];
  }
  return [scope.organizationId, null, scope.projectId];
}

function scopeRefFrom(scope: Scope): ScopeRef {
  return { level: scope.level, id: scopeTargetId(scope) };
}

function mapContent(row: ContentRow): DefinitionContent {
  return {
    name: row.name,
    purpose: row.purpose,
    responsibilities: row.responsibilities,
    boundaries: row.boundaries,
    instructions: row.instructions,
    appliesTo: row.applies_to,
    runsAs: row.runs_as,
    ownerId: row.owner_id,
    links: row.links,
  };
}

function mapDefinition(row: DefinitionRow): Definition {
  return {
    ...mapContent(row),
    id: row.id,
    kind: row.kind,
    organizationId: row.organization_id,
    scope: scopeRefOf(row),
    createdAt: row.created_at,
    revision: row.revision,
    status: row.status,
    changeNote: row.change_note,
    flags: row.content_flags,
    proposalId: row.proposal_id,
    proposedBy: row.proposed_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    callerRank: row.caller_rank,
  };
}

function toVersion(definition: Definition): DefinitionVersion {
  return {
    name: definition.name,
    purpose: definition.purpose,
    responsibilities: definition.responsibilities,
    boundaries: definition.boundaries,
    instructions: definition.instructions,
    appliesTo: definition.appliesTo,
    runsAs: definition.runsAs,
    ownerId: definition.ownerId,
    links: definition.links,
    revision: definition.revision,
    status: definition.status,
    changeNote: definition.changeNote,
    flags: definition.flags,
    proposalId: definition.proposalId,
    proposedBy: definition.proposedBy,
    approvedBy: definition.approvedBy,
    approvedAt: definition.approvedAt,
  };
}

function mapProposal(row: ProposalRow): DefinitionProposal {
  return {
    ...mapContent(row),
    id: row.id,
    organizationId: row.organization_id,
    scope: scopeRefOf(row),
    action: row.action,
    kind: row.kind,
    definitionId: row.definition_id,
    baseRevision: row.base_revision,
    changeNote: row.change_note,
    flags: row.content_flags,
    status: row.status,
    revision: row.revision,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewReason: row.review_reason,
    approvedRevision: row.approved_revision,
    callerRank: row.caller_rank,
  };
}

/** Keeps links whose target the caller may see. Hidden links are left out without a trace. */
function visibleLinks(
  links: readonly DefinitionLink[],
  definitionIds: ReadonlySet<string>,
  memoryIds: ReadonlySet<string>,
): DefinitionLink[] {
  return links.filter((link) =>
    link.relation === "based_on"
      ? memoryIds.has(link.targetId)
      : definitionIds.has(link.targetId),
  );
}

function linkKey(link: DefinitionLink): string {
  return `${link.relation}:${link.targetId}`;
}

function sortLinks(links: readonly DefinitionLink[]): DefinitionLink[] {
  return [...links].sort((a, b) => linkKey(a).localeCompare(linkKey(b)));
}

function optionalBody(
  value: unknown,
  field: string,
  maxLength: number,
  multiline: boolean,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return requireText(value, field, maxLength, multiline);
}

function requireItems(
  value: unknown,
  field: string,
  minimum: number,
): string[] {
  if (!Array.isArray(value))
    throw new ValidationError(`${field} must be a list`);
  const items = value.map((item) => requireText(item, field, ITEM_MAX_LENGTH));
  if (items.length < minimum) {
    throw new ValidationError(`${field} needs at least ${minimum} item`);
  }
  if (items.length > MAX_ITEMS) {
    throw new ValidationError(`${field} can have at most ${MAX_ITEMS} items`);
  }
  if (new Set(items.map((item) => item.toLowerCase())).size !== items.length) {
    throw new ValidationError(`${field} must not repeat an item`);
  }
  return items;
}

function requireLinks(value: unknown, kind: DefinitionKind): DefinitionLink[] {
  if (!Array.isArray(value)) throw new ValidationError("links must be a list");
  if (value.length > MAX_LINKS) {
    throw new ValidationError(`links can have at most ${MAX_LINKS} items`);
  }
  const links = value.map((item): DefinitionLink => {
    if (typeof item !== "object" || item === null) {
      throw new ValidationError("Each link needs a relation and a targetId");
    }
    const { relation, targetId } = item as {
      relation?: unknown;
      targetId?: unknown;
    };
    const checked = requireOneOf(
      relation,
      DEFINITION_RELATIONS,
      "links.relation",
    );
    if (!LINK_RULES[checked].from.includes(kind)) {
      throw new ValidationError(
        `${KIND_ARTICLE[kind]} cannot have a "${RELATION_WORDS[checked]}" link`,
      );
    }
    return {
      relation: checked,
      targetId: requireId(targetId, "links.targetId"),
    };
  });
  if (new Set(links.map(linkKey)).size !== links.length) {
    throw new ValidationError("links must not repeat a link");
  }
  return sortLinks(links);
}

interface CheckedContent {
  name: string;
  purpose: string;
  responsibilities: string[];
  boundaries: string[];
  instructions: string;
  appliesTo: string | null;
  runsAs: string | null;
  ownerId: string | null;
  links: DefinitionLink[];
}

/** Validates shape and length, and refuses text that looks like a secret. */
function checkContent(
  input: DefinitionContentInput,
  kind: DefinitionKind,
): CheckedContent {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError("The definition content is missing");
  }
  const name = requireText(input.name, "name", NAME_MAX_LENGTH);
  const purpose = requireText(input.purpose, "purpose", PURPOSE_MAX_LENGTH);
  const responsibilities = requireItems(
    input.responsibilities,
    "responsibilities",
    1,
  );
  const boundaries = requireItems(input.boundaries ?? [], "boundaries", 0);
  const instructions =
    optionalBody(
      input.instructions,
      "instructions",
      INSTRUCTIONS_MAX_LENGTH,
      true,
    ) ?? "";
  const appliesTo = optionalBody(
    input.appliesTo,
    "appliesTo",
    APPLIES_TO_MAX_LENGTH,
    false,
  );
  const runsAs =
    input.runsAs === undefined ? null : requireId(input.runsAs, "runsAs");
  if (runsAs !== null && kind !== "agent") {
    throw new ValidationError("Only an agent can run as an agent account");
  }
  const ownerId =
    input.ownerId === undefined ? null : requireId(input.ownerId, "ownerId");
  const links = requireLinks(input.links ?? [], kind);
  requireNoSecrets(name, "name");
  requireNoSecrets(purpose, "purpose");
  responsibilities.forEach((item) =>
    requireNoSecrets(item, "responsibilities"),
  );
  boundaries.forEach((item) => requireNoSecrets(item, "boundaries"));
  requireNoSecrets(instructions, "instructions");
  if (appliesTo !== null) requireNoSecrets(appliesTo, "appliesTo");
  return {
    name,
    purpose,
    responsibilities,
    boundaries,
    instructions,
    appliesTo,
    runsAs,
    ownerId,
    links,
  };
}

function checkNote(
  value: unknown,
  field: string,
  required: boolean,
): string | null {
  const note = required
    ? requireText(value, field, NOTE_MAX_LENGTH)
    : optionalText(
        typeof value === "string" && value.trim() === "" ? undefined : value,
        field,
        NOTE_MAX_LENGTH,
      );
  if (note !== null) requireNoSecrets(note, field);
  return note;
}

function flagsFor(
  content: DefinitionContent,
  note: string | null,
): ContentFlag[] {
  const text = [
    content.name,
    content.purpose,
    ...content.responsibilities,
    ...content.boundaries,
    content.instructions,
    content.appliesTo ?? "",
    note ?? "",
  ].join("\n");
  return mayContainPersonalData(text) ? ["personal_data"] : [];
}

/** IDs of the memories the caller may read now inside the scope. Suspended and replaced ones stay readable, so they count. */
async function readableMemoryIds(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  scope: ScopeRef,
): Promise<Set<string>> {
  const memories = await readableMemories(q, ctx, caller, scope, null, null);
  return new Set(memories.map((memory) => memory.id));
}

async function requireEligibleOwner(
  q: Queryable,
  ownerId: string,
  scope: Scope,
): Promise<void> {
  const owner = await findPrincipal(q, ownerId);
  if (
    !owner ||
    owner.kind !== "human" ||
    (await effectiveRank(q, owner, scope)) === 0
  ) {
    throw new ValidationError(
      "ownerId must be a person with a role covering this level",
    );
  }
}

async function requireAgentAccount(
  q: Queryable,
  agentId: string,
  scope: Scope,
): Promise<void> {
  const agent = await findPrincipal(q, agentId);
  if (
    !agent ||
    agent.kind !== "agent" ||
    (await effectiveRank(q, agent, scope)) === 0
  ) {
    throw new ValidationError(
      "runsAs must be an agent account with a role covering this level",
    );
  }
}

/**
 * Links to definitions must point to active definitions of a fitting kind at this level or one
 * above it. Links to memories must point to approved knowledge the caller can read inside this level;
 * a change may keep a memory link its base version has, even if that memory is no longer current.
 */
async function requireLinkTargets(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  scope: Scope,
  links: readonly DefinitionLink[],
  selfId: string | null,
  baseLinks: readonly DefinitionLink[],
): Promise<void> {
  const definitionLinks = links.filter((link) => link.relation !== "based_on");
  if (
    selfId !== null &&
    definitionLinks.some((link) => link.targetId === selfId)
  ) {
    throw new ValidationError("A definition cannot link to itself");
  }
  if (definitionLinks.length > 0) {
    const { rows } = await q.query<{
      id: string;
      kind: DefinitionKind;
      status: DefinitionStatus;
    }>(
      `SELECT d.id, d.kind, r.status FROM definitions d
       JOIN definition_revisions r ON r.definition_id = d.id AND r.revision = d.current_revision
       WHERE d.id = ANY($1::uuid[]) AND d.organization_id = $2
         AND (d.business_unit_id IS NULL OR d.business_unit_id = $3::uuid)
         AND (d.project_id IS NULL OR d.project_id = $4::uuid)`,
      [
        definitionLinks.map((link) => link.targetId),
        scope.organizationId,
        scope.businessUnitId,
        scope.projectId,
      ],
    );
    const found = new Map(rows.map((row) => [row.id, row]));
    for (const link of definitionLinks) {
      const target = found.get(link.targetId);
      if (!target || target.status !== "active") {
        throw new ValidationError(
          "Linked definitions must be active and at this level or one above it",
        );
      }
      if (!LINK_RULES[link.relation].to.includes(target.kind)) {
        throw new ValidationError(
          `"${RELATION_WORDS[link.relation]}" must point to ${TARGET_WORDS[link.relation]}`,
        );
      }
    }
  }
  const memoryLinks = links.filter((link) => link.relation === "based_on");
  if (memoryLinks.length > 0) {
    const readable = await readableMemories(
      q,
      ctx,
      caller,
      scopeRefFrom(scope),
      null,
      null,
    );
    const statusOf = new Map(
      readable.map((memory) => [memory.id, memory.status]),
    );
    const kept = new Set(
      baseLinks
        .filter((link) => link.relation === "based_on")
        .map((link) => link.targetId),
    );
    const allowed = (id: string) => {
      const status = statusOf.get(id);
      return status === "approved" || (status !== undefined && kept.has(id));
    };
    if (!memoryLinks.every((link) => allowed(link.targetId))) {
      throw new ValidationError(
        "Linked memories must be approved knowledge you can read, inside this level",
      );
    }
  }
}

/** Lets only one change at a time at this level pass the duplicate-name check. */
async function lockScope(q: Queryable, scope: Scope): Promise<void> {
  await q.query(
    `SELECT id FROM ${SCOPE_TABLE[scope.level]} WHERE id = $1 FOR NO KEY UPDATE`,
    [scopeTargetId(scope)],
  );
}

/** Refuses a second active definition, or pending new one, of the same kind and name at the same level. */
async function requireUniqueName(
  q: Queryable,
  caller: Principal,
  scope: Scope,
  kind: DefinitionKind,
  name: string,
  exceptDefinitionId: string | null,
): Promise<void> {
  const columns = scopeColumns(scope);
  const active = await q.query<{ id: string }>(
    `SELECT d.id FROM definitions d
     JOIN definition_revisions r ON r.definition_id = d.id AND r.revision = d.current_revision
     WHERE d.organization_id = $1 AND d.business_unit_id IS NOT DISTINCT FROM $2::uuid
       AND d.project_id IS NOT DISTINCT FROM $3::uuid AND d.kind = $4 AND r.status = 'active'
       AND lower(r.name) = lower($5) AND d.id IS DISTINCT FROM $6::uuid
     LIMIT 1`,
    [...columns, kind, name, exceptDefinitionId],
  );
  if (active.rows[0]) {
    throw new ConflictError(
      `An active ${kind} with this name already exists here (definition ${active.rows[0].id})`,
    );
  }
  // Only proposals the caller could see, or wrote, are compared, so a refusal reveals nothing hidden.
  const pending = await q.query<{ id: string }>(
    `SELECT id FROM definition_proposals
     WHERE organization_id = $1 AND business_unit_id IS NOT DISTINCT FROM $2::uuid
       AND project_id IS NOT DISTINCT FROM $3::uuid AND kind = $4 AND action = 'create'
       AND status = 'pending' AND lower(name) = lower($5)
       AND ($6::boolean OR proposed_by = $7)
     LIMIT 1`,
    [...columns, kind, name, caller.kind === "human", caller.id],
  );
  if (pending.rows[0]) {
    throw new ConflictError(
      `A new ${kind} with this name is already waiting for review (proposal ${pending.rows[0].id})`,
    );
  }
}

async function loadCurrentDefinition(
  q: Queryable,
  caller: Principal,
  definitionId: string,
): Promise<Definition | null> {
  const { rows } = await q.query<DefinitionRow>(
    `${VISIBLE_DEFINITIONS_SQL} AND d.id = $2`,
    [caller.id, definitionId],
  );
  return rows[0] ? mapDefinition(rows[0]) : null;
}

async function loadProposal(
  q: Queryable,
  caller: Principal,
  proposalId: string,
): Promise<DefinitionProposal | null> {
  const { rows } = await q.query<ProposalRow>(
    `${PROPOSAL_SQL} AND dp.id = $2`,
    [caller.id, proposalId],
  );
  return rows[0] ? mapProposal(rows[0]) : null;
}

function mayReadProposals(caller: Principal, rank: number): boolean {
  return (
    caller.kind === "human" && rank >= ROLE_RANK[MINIMUM_ROLE.readProposals]
  );
}

/** Human contributors and above at its level see a proposal, if they can read every memory it links. */
function proposalVisible(
  caller: Principal,
  proposal: DefinitionProposal,
  memoryIds: ReadonlySet<string>,
): boolean {
  return (
    mayReadProposals(caller, proposal.callerRank) &&
    proposal.links.every(
      (link) => link.relation !== "based_on" || memoryIds.has(link.targetId),
    )
  );
}

async function requireProposerRank(
  q: Queryable,
  caller: Principal,
  scope: Scope,
): Promise<number> {
  const rank = await effectiveRank(q, caller, scope);
  if (rank < ROLE_RANK[MINIMUM_ROLE.propose]) {
    throw new ForbiddenError(
      `The ${MINIMUM_ROLE.propose} role or higher at this level is required to propose agents, skills, instructions, or rules`,
    );
  }
  return rank;
}

interface NewProposal {
  scope: Scope;
  action: DefinitionAction;
  definitionId: string | null;
  baseRevision: number | null;
  kind: DefinitionKind;
  content: DefinitionContent;
  changeNote: string | null;
  proposedBy: string;
  at: Date;
}

async function insertProposal(
  q: Queryable,
  caller: Principal,
  values: NewProposal,
): Promise<DefinitionProposal> {
  const { content } = values;
  const flags = flagsFor(content, values.changeNote);
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO definition_proposals
       (organization_id, business_unit_id, project_id, action, definition_id, base_revision, kind,
        name, purpose, responsibilities, boundaries, instructions, applies_to, runs_as, owner_id,
        change_note, content_flags, status, revision, proposed_by, proposed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[], $12, $13, $14, $15,
             $16, $17::text[], 'pending', 1, $18, $19)
     RETURNING id`,
    [
      ...scopeColumns(values.scope),
      values.action,
      values.definitionId,
      values.baseRevision,
      values.kind,
      content.name,
      content.purpose,
      content.responsibilities,
      content.boundaries,
      content.instructions,
      content.appliesTo,
      content.runsAs,
      content.ownerId,
      values.changeNote,
      flags,
      values.proposedBy,
      values.at,
    ],
  );
  const id = firstRow(rows).id;
  if (content.links.length > 0) {
    await q.query(
      `INSERT INTO definition_proposal_links
         (proposal_id, relation, target_definition_id, target_memory_id)
       SELECT $3::uuid, t.relation,
              CASE WHEN t.relation = 'based_on' THEN NULL ELSE t.target END,
              CASE WHEN t.relation = 'based_on' THEN t.target END
       FROM unnest($1::text[], $2::uuid[]) AS t(relation, target)`,
      [...linkArrays(content.links), id],
    );
  }
  await recordAudit(q, {
    occurredAt: values.at,
    actorId: values.proposedBy,
    action: "definition.proposed",
    organizationId: values.scope.organizationId,
    projectId: values.scope.projectId,
    targetType: "definition_proposal",
    targetId: id,
    details: {
      action: values.action,
      kind: values.kind,
      scopeLevel: values.scope.level,
      scopeId: scopeTargetId(values.scope),
      definitionId: values.definitionId,
      baseRevision: values.baseRevision,
      linkCount: content.links.length,
      ...flagDetails(flags),
    },
  });
  const proposal = await loadProposal(q, caller, id);
  if (!proposal) throw new Error("A saved proposal could not be read back");
  return proposal;
}

function linkArrays(links: readonly DefinitionLink[]): [string[], string[]] {
  return [
    links.map((link) => link.relation),
    links.map((link) => link.targetId),
  ];
}

function sameContent(a: DefinitionContent, b: DefinitionContent): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((item, index) => item === y[index]);
  return (
    a.name === b.name &&
    a.purpose === b.purpose &&
    same(a.responsibilities, b.responsibilities) &&
    same(a.boundaries, b.boundaries) &&
    a.instructions === b.instructions &&
    a.appliesTo === b.appliesTo &&
    a.runsAs === b.runsAs &&
    a.ownerId === b.ownerId &&
    same(sortLinks(a.links).map(linkKey), sortLinks(b.links).map(linkKey))
  );
}

/**
 * Proposes a new agent, skill, instruction, or rule at one organization, business unit, or project.
 * Needs the contributor role there. The owner defaults to the caller when the caller is a person;
 * agents must name one. It becomes guidance only when a different reviewer approves it.
 */
export async function proposeDefinition(
  ctx: MemoryNetContext,
  callerId: string,
  input: DefinitionContentInput & {
    scope: ScopeRef;
    kind: DefinitionKind;
    changeNote?: string;
  },
): Promise<DefinitionProposal> {
  const scopeRef = requireScopeRef(input.scope);
  const kind = requireOneOf(input.kind, DEFINITION_KINDS, "kind");
  const checked = checkContent(input, kind);
  const changeNote = checkNote(input.changeNote, "changeNote", false);
  return ctx.db.transaction(async (tx) => {
    const caller = await requireCaller(tx, callerId);
    const scope = await resolveScope(tx, scopeRef);
    await requireRole(
      tx,
      caller,
      scope,
      MINIMUM_ROLE.propose,
      "propose agents, skills, instructions, or rules",
    );
    const ownerId =
      checked.ownerId ?? (caller.kind === "human" ? caller.id : null);
    if (ownerId === null) {
      throw new ValidationError("Agents must name a person as ownerId");
    }
    await requireEligibleOwner(tx, ownerId, scope);
    if (checked.runsAs !== null)
      await requireAgentAccount(tx, checked.runsAs, scope);
    await requireLinkTargets(tx, ctx, caller, scope, checked.links, null, []);
    await lockScope(tx, scope);
    await requireUniqueName(tx, caller, scope, kind, checked.name, null);
    return insertProposal(tx, caller, {
      scope,
      action: "create",
      definitionId: null,
      baseRevision: null,
      kind,
      content: { ...checked, ownerId },
      changeNote,
      proposedBy: caller.id,
      at: ctx.now(),
    });
  });
}

/** Loads a definition the caller may change, and checks they are changing its current version. */
async function startChange(
  tx: Queryable,
  callerId: string,
  definitionId: string,
  baseRevision: number,
): Promise<{ caller: Principal; current: Definition; scope: Scope }> {
  const caller = await requireCaller(tx, callerId);
  const current = await loadCurrentDefinition(tx, caller, definitionId);
  if (!current) throw new NotFoundError("Definition not found");
  const scope = await resolveScope(tx, current.scope);
  await requireProposerRank(tx, caller, scope);
  if (current.revision !== baseRevision) {
    throw new ConflictError(
      `Someone changed this definition since you opened it. Reload to see version ${current.revision}, then make your change again.`,
    );
  }
  return { caller, current, scope };
}

/**
 * Proposes a new version of a definition, written against its current version. Proposing older
 * content restores it, and changing a retired definition makes it active again. Links to memories
 * the caller cannot read are kept as they are, since the caller can neither see nor remove them.
 */
export async function proposeDefinitionChange(
  ctx: MemoryNetContext,
  callerId: string,
  input: DefinitionContentInput & {
    definitionId: string;
    baseRevision: number;
    changeNote?: string;
  },
): Promise<DefinitionProposal> {
  const definitionId = requireId(input.definitionId, "definitionId");
  const baseRevision = requirePositiveInteger(
    input.baseRevision,
    "baseRevision",
  );
  const changeNote = checkNote(input.changeNote, "changeNote", false);
  return ctx.db.transaction(async (tx) => {
    const { caller, current, scope } = await startChange(
      tx,
      callerId,
      definitionId,
      baseRevision,
    );
    const checked = checkContent(input, current.kind);
    const ownerId = checked.ownerId ?? current.ownerId;
    await requireEligibleOwner(tx, ownerId, scope);
    if (checked.runsAs !== null && checked.runsAs !== current.runsAs) {
      await requireAgentAccount(tx, checked.runsAs, scope);
    }
    await requireLinkTargets(
      tx,
      ctx,
      caller,
      scope,
      checked.links,
      current.id,
      current.links,
    );
    const readable = await readableMemoryIds(
      tx,
      ctx,
      caller,
      scopeRefFrom(scope),
    );
    // current.links is the stored list here, including links the caller cannot see.
    const hidden = current.links.filter(
      (link) => link.relation === "based_on" && !readable.has(link.targetId),
    );
    const content: DefinitionContent = {
      ...checked,
      ownerId,
      links: sortLinks([...checked.links, ...hidden]),
    };
    if (current.status === "active" && sameContent(content, current)) {
      throw new ValidationError(
        "Nothing changed, so there is nothing to review",
      );
    }
    if (
      content.name.toLowerCase() !== current.name.toLowerCase() ||
      current.status === "retired"
    ) {
      await lockScope(tx, scope);
      await requireUniqueName(
        tx,
        caller,
        scope,
        current.kind,
        content.name,
        current.id,
      );
    }
    return insertProposal(tx, caller, {
      scope,
      action: "change",
      definitionId: current.id,
      baseRevision: current.revision,
      kind: current.kind,
      content,
      changeNote,
      proposedBy: caller.id,
      at: ctx.now(),
    });
  });
}

/** Proposes to stop using an active definition. Its content and history stay, so it can be restored. */
export async function proposeDefinitionRetirement(
  ctx: MemoryNetContext,
  callerId: string,
  input: { definitionId: string; baseRevision: number; reason: string },
): Promise<DefinitionProposal> {
  const definitionId = requireId(input.definitionId, "definitionId");
  const baseRevision = requirePositiveInteger(
    input.baseRevision,
    "baseRevision",
  );
  const reason = checkNote(input.reason, "reason", true);
  return ctx.db.transaction(async (tx) => {
    const { caller, current, scope } = await startChange(
      tx,
      callerId,
      definitionId,
      baseRevision,
    );
    if (current.status !== "active") {
      throw new ConflictError("This definition is already retired");
    }
    return insertProposal(tx, caller, {
      scope,
      action: "retire",
      definitionId: current.id,
      baseRevision: current.revision,
      kind: current.kind,
      content: current,
      changeNote: reason,
      proposedBy: caller.id,
      at: ctx.now(),
    });
  });
}

/** Checks shared by approval and rejection: a different person with the reviewer role, naming the exact pending version. */
async function startReview(
  tx: Queryable,
  ctx: MemoryNetContext,
  callerId: string,
  proposalId: string,
  expectedRevision: number,
): Promise<{ caller: Principal; proposal: DefinitionProposal; scope: Scope }> {
  const caller = await requireCaller(tx, callerId);
  requireHuman(caller, "review agents, skills, instructions, or rules");
  const proposal = await loadProposal(tx, caller, proposalId);
  if (!proposal) throw new NotFoundError("Proposal not found");
  const scope = await resolveScope(tx, proposal.scope);
  const readable = await readableMemoryIds(tx, ctx, caller, proposal.scope);
  if (!proposalVisible(caller, proposal, readable)) {
    throw new NotFoundError("Proposal not found");
  }
  if (proposal.callerRank < ROLE_RANK[MINIMUM_ROLE.review]) {
    throw new ForbiddenError(
      `The ${MINIMUM_ROLE.review} role or higher at this level is required to review this proposal`,
    );
  }
  if (proposal.proposedBy === caller.id) {
    throw new ForbiddenError("A different person must review this proposal");
  }
  if (proposal.status !== "pending") {
    throw new ConflictError("This proposal has already been reviewed");
  }
  if (proposal.revision !== expectedRevision) {
    throw new ConflictError(
      "The proposal has changed; review the latest version",
    );
  }
  return { caller, proposal, scope };
}

async function closeProposal(
  tx: Queryable,
  proposal: DefinitionProposal,
  review: {
    status: "approved" | "rejected";
    reviewerId: string;
    at: Date;
    reason: string | null;
    definitionId: string | null;
    approvedRevision: number | null;
  },
): Promise<void> {
  const updated = await tx.query(
    `UPDATE definition_proposals
     SET status = $2, reviewed_by = $3, reviewed_at = $4, review_reason = $5,
         definition_id = COALESCE($6::uuid, definition_id), approved_revision = $7
     WHERE id = $1 AND status = 'pending' AND revision = $8
     RETURNING id`,
    [
      proposal.id,
      review.status,
      review.reviewerId,
      review.at,
      review.reason,
      review.definitionId,
      review.approvedRevision,
      proposal.revision,
    ],
  );
  if (updated.rows.length === 0) {
    throw new ConflictError("The proposal changed while you were reviewing it");
  }
}

/**
 * Approves the exact proposal version the reviewer saw. A new definition gets its stable ID; a change
 * or retirement becomes the next version, but only if nobody approved another version first.
 */
export async function approveDefinitionProposal(
  ctx: MemoryNetContext,
  callerId: string,
  input: { proposalId: string; expectedRevision: number; reason?: string },
): Promise<Definition> {
  const proposalId = requireId(input.proposalId, "proposalId");
  const expectedRevision = requirePositiveInteger(
    input.expectedRevision,
    "expectedRevision",
  );
  const reason = checkNote(input.reason, "reason", false);
  return ctx.db.transaction(async (tx) => {
    const { caller, proposal, scope } = await startReview(
      tx,
      ctx,
      callerId,
      proposalId,
      expectedRevision,
    );
    const targets = proposal.links.filter(
      (link) => link.relation !== "based_on",
    );
    if (targets.length > 0) {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT d.id FROM definitions d
         JOIN definition_revisions r ON r.definition_id = d.id AND r.revision = d.current_revision
         WHERE d.id = ANY($1::uuid[]) AND r.status = 'active'`,
        [targets.map((link) => link.targetId)],
      );
      if (rows.length !== targets.length) {
        throw new ConflictError(
          "A linked definition was retired after this proposal was written. Reject it and propose again without that link.",
        );
      }
    }
    const memoryTargets = proposal.links
      .filter((link) => link.relation === "based_on")
      .map((link) => link.targetId);
    if (memoryTargets.length > 0) {
      // Links the base version already had may stay; new ones need current knowledge.
      const { rows } = await tx.query<{ id: string }>(
        `SELECT m.id FROM memories m
         WHERE m.id = ANY($1::uuid[]) AND m.status <> 'approved'
           AND NOT EXISTS (
             SELECT 1 FROM definition_links l
             WHERE l.definition_id = $2::uuid AND l.revision = $3::int
               AND l.target_memory_id = m.id)`,
        [memoryTargets, proposal.definitionId, proposal.baseRevision],
      );
      if (rows.length > 0) {
        throw new ConflictError(
          "A linked memory was suspended or replaced after this proposal was written. Reject it and propose again without that link.",
        );
      }
    }
    const owner = await findPrincipal(tx, proposal.ownerId);
    if (!owner || (await effectiveRank(tx, owner, scope)) === 0) {
      throw new ConflictError(
        "The proposed owner no longer has a role covering this level; reject it and propose it again with a current owner",
      );
    }
    const now = ctx.now();
    let definitionId: string;
    let revision: number;
    if (proposal.action === "create") {
      await lockScope(tx, scope);
      const clash = await tx.query<{ id: string }>(
        `SELECT d.id FROM definitions d
         JOIN definition_revisions r ON r.definition_id = d.id AND r.revision = d.current_revision
         WHERE d.organization_id = $1 AND d.business_unit_id IS NOT DISTINCT FROM $2::uuid
           AND d.project_id IS NOT DISTINCT FROM $3::uuid AND d.kind = $4
           AND r.status = 'active' AND lower(r.name) = lower($5)
         LIMIT 1`,
        [...scopeColumns(scope), proposal.kind, proposal.name],
      );
      if (clash.rows[0]) {
        throw new ConflictError(
          `An active ${proposal.kind} with this name was approved first (definition ${clash.rows[0].id}). Reject this proposal or rename it in a new one.`,
        );
      }
      const created = await tx.query<{ id: string }>(
        `INSERT INTO definitions (organization_id, business_unit_id, project_id, kind,
                                  current_revision, created_at)
         VALUES ($1, $2, $3, $4, 1, $5) RETURNING id`,
        [...scopeColumns(scope), proposal.kind, now],
      );
      definitionId = firstRow(created.rows).id;
      revision = 1;
    } else {
      definitionId = proposal.definitionId ?? "";
      const locked = await tx.query<{ current_revision: number }>(
        "SELECT current_revision FROM definitions WHERE id = $1 FOR UPDATE",
        [definitionId],
      );
      const currentRevision = firstRow(locked.rows).current_revision;
      if (currentRevision !== proposal.baseRevision) {
        throw new ConflictError(
          `This definition changed after the proposal was written; it is now at version ${currentRevision}. Reject this proposal and propose the change again from the current version.`,
        );
      }
      revision = currentRevision + 1;
    }
    await closeProposal(tx, proposal, {
      status: "approved",
      reviewerId: caller.id,
      at: now,
      reason,
      definitionId,
      approvedRevision: revision,
    });
    await tx.query(
      `INSERT INTO definition_revisions
         (organization_id, definition_id, revision, status, name, purpose, responsibilities,
          boundaries, instructions, applies_to, runs_as, owner_id, change_note, content_flags,
          proposal_id, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text[], $9, $10, $11, $12, $13,
               $14::text[], $15, $16, $17)`,
      [
        scope.organizationId,
        definitionId,
        revision,
        proposal.action === "retire" ? "retired" : "active",
        proposal.name,
        proposal.purpose,
        proposal.responsibilities,
        proposal.boundaries,
        proposal.instructions,
        proposal.appliesTo,
        proposal.runsAs,
        proposal.ownerId,
        proposal.changeNote,
        proposal.flags,
        proposal.id,
        caller.id,
        now,
      ],
    );
    if (proposal.links.length > 0) {
      await tx.query(
        `INSERT INTO definition_links
           (organization_id, definition_id, revision, relation, target_definition_id,
            target_memory_id)
         SELECT $3::uuid, $4::uuid, $5::int, t.relation,
                CASE WHEN t.relation = 'based_on' THEN NULL ELSE t.target END,
                CASE WHEN t.relation = 'based_on' THEN t.target END
         FROM unnest($1::text[], $2::uuid[]) AS t(relation, target)`,
        [
          ...linkArrays(proposal.links),
          scope.organizationId,
          definitionId,
          revision,
        ],
      );
    }
    await tx.query(
      "UPDATE definitions SET current_revision = $2 WHERE id = $1",
      [definitionId, revision],
    );
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "definition.approved",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      targetType: "definition",
      targetId: definitionId,
      reason,
      details: {
        proposalId: proposal.id,
        proposalRevision: proposal.revision,
        action: proposal.action,
        kind: proposal.kind,
        revision,
      },
    });
    const approved = await loadCurrentDefinition(tx, caller, definitionId);
    if (!approved)
      throw new Error("An approved definition could not be read back");
    return approved;
  });
}

/** Rejects the exact proposal version the reviewer saw. A reason is required. */
export async function rejectDefinitionProposal(
  ctx: MemoryNetContext,
  callerId: string,
  input: { proposalId: string; expectedRevision: number; reason: string },
): Promise<DefinitionProposal> {
  const proposalId = requireId(input.proposalId, "proposalId");
  const expectedRevision = requirePositiveInteger(
    input.expectedRevision,
    "expectedRevision",
  );
  const reason = checkNote(input.reason, "reason", true);
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
      definitionId: null,
      approvedRevision: null,
    });
    await recordAudit(tx, {
      occurredAt: now,
      actorId: caller.id,
      action: "definition.rejected",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      targetType: "definition_proposal",
      targetId: proposal.id,
      reason,
      details: { revision: proposal.revision, action: proposal.action },
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

/**
 * Current versions of the definitions the caller may see in one organization: those at a level where
 * the caller has a role, above it, or inside it. Links to memories the caller cannot read are left out.
 */
export async function readableDefinitions(
  q: Queryable,
  caller: Principal,
  organizationId: string,
  memoryIds: ReadonlySet<string>,
): Promise<Definition[]> {
  const { rows } = await q.query<DefinitionRow>(
    `${VISIBLE_DEFINITIONS_SQL} AND d.organization_id = $2
     ORDER BY d.kind, lower(r.name), d.id`,
    [caller.id, organizationId],
  );
  const definitions = rows.map(mapDefinition);
  const ids = new Set(definitions.map((definition) => definition.id));
  return definitions.map((definition) => ({
    ...definition,
    links: visibleLinks(definition.links, ids, memoryIds),
  }));
}

/**
 * Definitions that guide work in one project, as the caller may see them: its organization's, its business
 * unit's and the project's own, never another unit's or project's. Retired ones are included; callers filter.
 * Links follow the caller's view, and the readable memories behind based_on links come back for freshness checks.
 */
export async function readableProjectDefinitions(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  projectId: string,
): Promise<{ definitions: Definition[]; linkedMemories: Memory[] }> {
  const project = (
    await q.query<{ organization_id: string; business_unit_id: string }>(
      "SELECT organization_id, business_unit_id FROM projects WHERE id = $1",
      [projectId],
    )
  ).rows[0];
  if (!project) return { definitions: [], linkedMemories: [] };
  const { rows } = await q.query<DefinitionRow>(
    `${VISIBLE_DEFINITIONS_SQL} AND d.organization_id = $2
       AND (d.business_unit_id IS NULL OR d.business_unit_id = $3::uuid)
       AND (d.project_id IS NULL OR d.project_id = $4::uuid)
     ORDER BY d.kind, lower(r.name), d.id`,
    [caller.id, project.organization_id, project.business_unit_id, projectId],
  );
  const definitions = rows.map(mapDefinition);
  const linkedMemories = await readableMemoriesByIds(
    q,
    ctx,
    caller,
    definitions.flatMap((definition) =>
      definition.links
        .filter((link) => link.relation === "based_on")
        .map((link) => link.targetId),
    ),
  );
  const definitionIds = new Set(definitions.map((definition) => definition.id));
  const memoryIds = new Set(linkedMemories.map((memory) => memory.id));
  return {
    definitions: definitions.map((definition) => ({
      ...definition,
      links: visibleLinks(definition.links, definitionIds, memoryIds),
    })),
    linkedMemories,
  };
}

/** Proposals in one organization that the caller may see, newest first. Readers and agents get none. */
export async function readableDefinitionProposals(
  q: Queryable,
  caller: Principal,
  organizationId: string,
  memoryIds: ReadonlySet<string>,
  filter: { status?: DefinitionProposalStatus; definitionId?: string } = {},
): Promise<DefinitionProposal[]> {
  if (caller.kind !== "human") return [];
  const params: unknown[] = [caller.id, organizationId];
  let sql = `${PROPOSAL_SQL} AND dp.organization_id = $2`;
  if (filter.status !== undefined) {
    params.push(filter.status);
    sql += ` AND dp.status = $${params.length}`;
  }
  if (filter.definitionId !== undefined) {
    params.push(filter.definitionId);
    sql += ` AND dp.definition_id = $${params.length}`;
  }
  const { rows } = await q.query<ProposalRow>(
    `${sql} ORDER BY dp.proposed_at DESC, dp.id`,
    params,
  );
  return rows
    .map(mapProposal)
    .filter((proposal) => proposalVisible(caller, proposal, memoryIds));
}

async function organizationMemoryIds(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  organizationId: string,
): Promise<Set<string>> {
  return readableMemoryIds(q, ctx, caller, {
    level: "organization",
    id: organizationId,
  });
}

/** Definitions the caller may see in one organization, at their current version. */
export async function listDefinitions(
  ctx: MemoryNetContext,
  callerId: string,
  filter: { organizationId: string },
): Promise<Definition[]> {
  const organizationId = requireId(filter.organizationId, "organizationId");
  const caller = await requireCaller(ctx.db, callerId);
  const memoryIds = await organizationMemoryIds(
    ctx.db,
    ctx,
    caller,
    organizationId,
  );
  return readableDefinitions(ctx.db, caller, organizationId, memoryIds);
}

/** Definition proposals in one organization the caller may see. Readers and agents get none. */
export async function listDefinitionProposals(
  ctx: MemoryNetContext,
  callerId: string,
  filter: { organizationId: string; status?: DefinitionProposalStatus },
): Promise<DefinitionProposal[]> {
  const organizationId = requireId(filter.organizationId, "organizationId");
  const status =
    filter.status === undefined
      ? undefined
      : requireOneOf(filter.status, DEFINITION_PROPOSAL_STATUSES, "status");
  const caller = await requireCaller(ctx.db, callerId);
  const memoryIds = await organizationMemoryIds(
    ctx.db,
    ctx,
    caller,
    organizationId,
  );
  return readableDefinitionProposals(
    ctx.db,
    caller,
    organizationId,
    memoryIds,
    {
      ...(status === undefined ? {} : { status }),
    },
  );
}

/** One definition with its history, links, and the definitions that use it, as the caller may see them. */
export async function getDefinition(
  ctx: MemoryNetContext,
  callerId: string,
  definitionId: string,
): Promise<DefinitionView> {
  const id = requireId(definitionId, "definitionId");
  const caller = await requireCaller(ctx.db, callerId);
  const own = await loadCurrentDefinition(ctx.db, caller, id);
  if (!own) throw new NotFoundError("Definition not found");
  const memories = await readableMemories(
    ctx.db,
    ctx,
    caller,
    { level: "organization", id: own.organizationId },
    null,
    null,
  );
  const memoryIds = new Set(memories.map((memory) => memory.id));
  const all = await readableDefinitions(
    ctx.db,
    caller,
    own.organizationId,
    memoryIds,
  );
  const byId = new Map(all.map((definition) => [definition.id, definition]));
  const definition = byId.get(id) ?? own;
  const history = await ctx.db.query<DefinitionRow>(VISIBLE_HISTORY_SQL, [
    caller.id,
    id,
  ]);
  const visibleIds = new Set(byId.keys());
  const linkedDefinitions = definition.links
    .filter((link) => link.relation !== "based_on")
    .flatMap((link) => byId.get(link.targetId) ?? []);
  const linkedMemories = memories.filter((memory) =>
    definition.links.some(
      (link) => link.relation === "based_on" && link.targetId === memory.id,
    ),
  );
  const usedBy = all.flatMap((other) =>
    other.status === "active"
      ? other.links
          .filter(
            (link) => link.relation !== "based_on" && link.targetId === id,
          )
          .map((link) => ({ relation: link.relation, definition: other }))
      : [],
  );
  const pending = mayReadProposals(caller, definition.callerRank)
    ? await readableDefinitionProposals(
        ctx.db,
        caller,
        own.organizationId,
        memoryIds,
        {
          status: "pending",
          definitionId: id,
        },
      )
    : null;
  return {
    definition,
    history: history.rows.map((row) => {
      const version = toVersion(mapDefinition(row));
      return {
        ...version,
        links: visibleLinks(version.links, visibleIds, memoryIds),
      };
    }),
    linkedDefinitions,
    linkedMemories,
    usedBy,
    pending,
  };
}

/** A proposal with the version it changes, for reviewing the difference. */
export interface DefinitionProposalView {
  proposal: DefinitionProposal;
  /** The approved version the change was written against; null for a new definition. */
  base: DefinitionVersion | null;
  /** The definition as it is now; null for a new definition that is not approved. */
  current: Definition | null;
  /** Definitions and memories that the proposal or its base version link to, for names. */
  linkedDefinitions: Definition[];
  linkedMemories: Memory[];
}

/** One proposal. Only human contributors and above at its level who can read every memory it links may see it. */
export async function getDefinitionProposal(
  ctx: MemoryNetContext,
  callerId: string,
  proposalId: string,
): Promise<DefinitionProposalView> {
  const id = requireId(proposalId, "proposalId");
  const caller = await requireCaller(ctx.db, callerId);
  const proposal = await loadProposal(ctx.db, caller, id);
  if (!proposal) throw new NotFoundError("Proposal not found");
  const memories = await readableMemories(
    ctx.db,
    ctx,
    caller,
    { level: "organization", id: proposal.organizationId },
    null,
    null,
  );
  const memoryIds = new Set(memories.map((memory) => memory.id));
  if (!proposalVisible(caller, proposal, memoryIds)) {
    throw new NotFoundError("Proposal not found");
  }
  const all = await readableDefinitions(
    ctx.db,
    caller,
    proposal.organizationId,
    memoryIds,
  );
  const visibleIds = new Set(all.map((definition) => definition.id));
  let base: DefinitionVersion | null = null;
  let current: Definition | null = null;
  if (proposal.definitionId !== null) {
    current =
      all.find((definition) => definition.id === proposal.definitionId) ?? null;
    const history = await ctx.db.query<DefinitionRow>(VISIBLE_HISTORY_SQL, [
      caller.id,
      proposal.definitionId,
    ]);
    const row = history.rows.find(
      (item) => item.revision === proposal.baseRevision,
    );
    if (row) {
      const version = toVersion(mapDefinition(row));
      base = {
        ...version,
        links: visibleLinks(version.links, visibleIds, memoryIds),
      };
    }
  }
  const targetIds = new Set(
    [...proposal.links, ...(base?.links ?? [])].map((link) => link.targetId),
  );
  return {
    proposal: {
      ...proposal,
      links: visibleLinks(proposal.links, visibleIds, memoryIds),
    },
    base,
    current,
    linkedDefinitions: all.filter((definition) => targetIds.has(definition.id)),
    linkedMemories: memories.filter((memory) => targetIds.has(memory.id)),
  };
}

// Principals whose effective role covers this level. Binds $1 scope ID and $2 kind (null for any).
const EFFECTIVE_AT_SQL: Readonly<Record<ScopeLevel, string>> = {
  organization: `SELECT pr.id, pr.display_name, r.rank FROM effective_organization_roles r
    JOIN principals pr ON pr.id = r.principal_id
    WHERE r.organization_id = $1 AND ($2::text IS NULL OR pr.kind = $2)`,
  business_unit: `SELECT pr.id, pr.display_name, r.rank FROM effective_business_unit_roles r
    JOIN principals pr ON pr.id = r.principal_id
    WHERE r.business_unit_id = $1 AND ($2::text IS NULL OR pr.kind = $2)`,
  project: `SELECT pr.id, pr.display_name, r.rank FROM effective_project_roles r
    JOIN principals pr ON pr.id = r.principal_id
    WHERE r.project_id = $1 AND ($2::text IS NULL OR pr.kind = $2)`,
};

/**
 * People (for owners) or agent accounts (for runsAs) whose role covers the level.
 * Needs the contributor role there, like choosing a memory owner.
 */
export async function listScopePrincipals(
  ctx: MemoryNetContext,
  callerId: string,
  scopeRef: ScopeRef,
  kind: "human" | "agent",
): Promise<Array<{ id: string; displayName: string; role: Role }>> {
  const ref = requireScopeRef(scopeRef);
  const caller = await requireCaller(ctx.db, callerId);
  const scope = await resolveScope(ctx.db, ref);
  await requireRole(
    ctx.db,
    caller,
    scope,
    MINIMUM_ROLE.propose,
    "choose owners and agent accounts",
  );
  const { rows } = await ctx.db.query<{
    id: string;
    display_name: string;
    rank: number;
  }>(`${EFFECTIVE_AT_SQL[scope.level]} ORDER BY pr.display_name, pr.id`, [
    ref.id,
    kind,
  ]);
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    role: roleForRank(row.rank),
  }));
}

/** The effective role of each principal at one level, for administrators checking agent accounts. */
export async function effectiveRolesAt(
  q: Queryable,
  scope: Scope,
  principalIds: readonly string[],
): Promise<Map<string, Role>> {
  if (principalIds.length === 0) return new Map();
  const { rows } = await q.query<{ id: string; rank: number }>(
    `${EFFECTIVE_AT_SQL[scope.level]} AND pr.id = ANY($3::uuid[])`,
    [scopeTargetId(scope), null, [...new Set(principalIds)]],
  );
  return new Map(rows.map((row) => [row.id, roleForRank(row.rank)]));
}
