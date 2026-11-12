import {
  requireCaller,
  requireHuman,
  requireRole,
  resolveScope,
  scopeNotFound,
  type Principal,
  type ScopeRef,
} from "./access.ts";
import type { MemoryNetContext } from "./context.ts";
import { basedOnChanges, type BasedOnChange } from "./definition-freshness.ts";
import { readableDefinitions, type Definition } from "./definitions.ts";
import { ValidationError } from "./errors.ts";
import {
  listMemories,
  listProposals,
  listReviewQueue,
  readableMemories,
  type DecisionApplicability,
  type Memory,
  type Proposal,
} from "./knowledge.ts";
import { describePrincipals } from "./members.ts";
import { getContext, type ContextMemory } from "./retrieval.ts";
import { getNetwork, type NetworkNode } from "./network.ts";
import { getOrganizationTree } from "./organizations.ts";
import { MINIMUM_ROLE, ROLE_RANK } from "./roles.ts";
import { optionalLimit, requireId } from "./validation.ts";
import { listWork } from "./work.ts";

export type BrainFindingKind =
  | "stale_work"
  | "warning_nodes"
  | "flagged_nodes"
  | "uncited_sources"
  | "expired_applicability"
  | "pending_reviews"
  | "outdated_definitions"
  | "recurring_reports"
  | "rejected_agent_attempts"
  | "conflicting_decisions";

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
  const recommendations = await scanRecommendations(ctx, callerId, input).catch(() => []);
  findings.push(...recommendationFindings(organizationId, recommendations));
  return findings;
}

export type BrainRecommendationKind =
  | "definition_outdated"
  | "recurring_reports"
  | "rejected_agent_attempts"
  | "conflicting_decisions";

/** A change a person may want to propose. It changes nothing itself; its actions open existing pages and forms. */
export interface BrainRecommendation {
  kind: BrainRecommendationKind;
  /** Null for organization- or business-unit-level definitions. */
  projectId: string | null;
  projectName: string | null;
  subject: { kind: "definition" | "memory"; id: string; title: string };
  /** One plain sentence built from record titles and counts. */
  reason: string;
  related: Array<{ kind: "memory" | "definition"; id: string; title: string }>;
  /** Links (GET) to existing pages and forms only. */
  actions: Array<{ label: string; href: string }>;
  /** When the triggering change happened. */
  at: Date | null;
}

const DEFAULT_RECOMMENDATION_LIMIT = 50;
const MAX_RECOMMENDATION_LIMIT = 200;
/** How often the same signal must recur before it is worth a person's look. */
const REPEATED = 2;
const REJECTION_WINDOW_DAYS = 180;
const REJECTION_WINDOW_MS = REJECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const PROPOSAL_SCAN_LIMIT = 200;

const CHANGE_WORDS: Readonly<Record<BasedOnChange["change"], string>> = {
  revised: "which was revised",
  suspended: "which was suspended",
  superseded: "which was replaced",
  revoked: "which was revoked",
};

const KIND_ORDER: Readonly<Record<BrainRecommendationKind, number>> = {
  definition_outdated: 0,
  recurring_reports: 1,
  rejected_agent_attempts: 2,
  conflicting_decisions: 3,
};

const FINDING_KIND: Readonly<Record<BrainRecommendationKind, BrainFindingKind>> = {
  definition_outdated: "outdated_definitions",
  recurring_reports: "recurring_reports",
  rejected_agent_attempts: "rejected_agent_attempts",
  conflicting_decisions: "conflicting_decisions",
};

const FINDING_LABEL: Readonly<Record<BrainRecommendationKind, (count: number) => string>> = {
  definition_outdated: (count) => `${count} ${count === 1 ? "definition is" : "definitions are"} based on decisions that changed`,
  recurring_reports: (count) => `${count} ${count === 1 ? "decision has" : "decisions have"} repeated outdated reports`,
  rejected_agent_attempts: (count) => `${count} ${count === 1 ? "decision draws" : "decisions draw"} repeatedly rejected agent proposals`,
  conflicting_decisions: (count) => `${count} ${count === 1 ? "pair" : "pairs"} of current decisions linked as conflicting`,
};

interface ScannedProject {
  id: string;
  name: string;
  businessUnitId: string;
  rank: number;
}

function memoryRef(memory: Memory): { kind: "memory"; id: string; title: string } {
  return { kind: "memory", id: memory.id, title: memory.title };
}

function latest(dates: ReadonlyArray<Date | null>): Date | null {
  let result: Date | null = null;
  for (const date of dates) {
    if (date !== null && (result === null || date.getTime() > result.getTime())) result = date;
  }
  return result;
}

function newestApproval(a: Memory, b: Memory): number {
  return b.approvedAt.getTime() - a.approvedAt.getTime() || a.id.localeCompare(b.id);
}

function mayPropose(rank: number): boolean {
  return rank >= ROLE_RANK[MINIMUM_ROLE.propose];
}

/** No applicability means always and everywhere; validUntil is exclusive. */
function appliesAt(applicability: DecisionApplicability | null, at: Date): boolean {
  return applicability === null || (applicability.validFrom.getTime() <= at.getTime() &&
    (applicability.validUntil === null || at.getTime() < applicability.validUntil.getTime()));
}

/** Two decisions can apply together unless they name another repository or branch, or one does not apply now. */
function canOverlap(a: DecisionApplicability | null, b: DecisionApplicability | null, now: Date): boolean {
  if (a !== null && b !== null && (a.repositoryId !== b.repositoryId || a.branch !== b.branch)) return false;
  return appliesAt(a, now) && appliesAt(b, now);
}

function newestFirst(a: BrainRecommendation, b: BrainRecommendation): number {
  const left = a.at?.getTime() ?? Number.NEGATIVE_INFINITY;
  const right = b.at?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (left !== right) return right > left ? 1 : -1;
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.subject.id.localeCompare(b.subject.id) ||
    (a.related[0]?.id ?? "").localeCompare(b.related[0]?.id ?? "");
}

/** Active definitions whose current version is based on a decision that changed after that version was approved. */
function outdatedDefinitions(
  definitions: readonly Definition[],
  readable: ReadonlyMap<string, Memory>,
  projects: ReadonlyMap<string, ScannedProject>,
  projectId: string | undefined,
): BrainRecommendation[] {
  const found: BrainRecommendation[] = [];
  for (const definition of definitions) {
    const own = definition.scope.level === "project" ? definition.scope.id : null;
    // Scoped to a project, `readable` holds only that project's memories, so a definition from a higher level
    // shows up only when a decision in this project changed.
    if (projectId !== undefined && own !== null && own !== projectId) continue;
    const changes = basedOnChanges(definition, readable);
    if (changes.length === 0) continue;
    const newest = changes.reduce((best, change) =>
      (change.changedAt?.getTime() ?? Number.NEGATIVE_INFINITY) > (best.changedAt?.getTime() ?? Number.NEGATIVE_INFINITY) ? change : best);
    found.push({
      kind: "definition_outdated",
      projectId: own,
      projectName: own === null ? null : projects.get(own)?.name ?? null,
      subject: { kind: "definition", id: definition.id, title: definition.name },
      reason: changes.length === 1
        ? `“${definition.name}” is based on “${newest.title}”, ${CHANGE_WORDS[newest.change]} after this definition was approved.`
        : `“${definition.name}” is based on ${changes.length} decisions that changed after this definition was approved.`,
      related: changes.map((change) => ({ kind: "memory", id: change.memoryId, title: change.title })),
      actions: [
        { label: "Open the definition", href: `/definitions/${definition.id}` },
        ...(mayPropose(definition.callerRank)
          ? [{ label: "Propose a change", href: `/definitions/${definition.id}#propose-change` }]
          : []),
        {
          label: changes.length === 1 ? "Open the changed decision" : "Open the latest changed decision",
          href: `/memories/${newest.memoryId}`,
        },
      ],
      at: newest.changedAt,
    });
  }
  return found;
}

/** Current decisions with repeated open outdated reports. */
async function recurringReports(
  ctx: MemoryNetContext,
  current: readonly Memory[],
  projects: ReadonlyMap<string, ScannedProject>,
): Promise<BrainRecommendation[]> {
  if (current.length === 0) return [];
  // Anyone who may read a memory sees its reports (getMemoryHistory), so counting reports of readable memories reveals nothing more.
  const { rows } = await ctx.db.query<{ memory_id: string; open: number; latest: Date }>(
    `SELECT memory_id, count(*)::int AS open, max(reported_at) AS latest
     FROM memory_reports
     WHERE resolved_at IS NULL AND memory_id = ANY($1::uuid[])
     GROUP BY memory_id
     HAVING count(*) >= $2
     ORDER BY max(reported_at) DESC, memory_id`,
    [current.map((memory) => memory.id), REPEATED],
  );
  const byId = new Map(current.map((memory) => [memory.id, memory]));
  return rows.flatMap((row): BrainRecommendation[] => {
    const memory = byId.get(row.memory_id);
    if (!memory) return [];
    const project = projects.get(memory.projectId);
    return [{
      kind: "recurring_reports",
      projectId: memory.projectId,
      projectName: project?.name ?? null,
      subject: memoryRef(memory),
      reason: `“${memory.title}” has ${row.open} open reports that it may be outdated.`,
      related: [],
      actions: [
        { label: "Open the decision", href: `/memories/${memory.id}` },
        ...(mayPropose(project?.rank ?? 0)
          ? [{ label: "Propose a revision", href: `/memories/${memory.id}#propose-change` }]
          : []),
      ],
      at: row.latest,
    }];
  });
}

/** The caller's readable agent definition that runs as this agent, the one closest to the project first. */
function agentDefinitionFor(
  definitions: readonly Definition[],
  agentId: string,
  project: ScannedProject,
): Definition | undefined {
  const distance = (definition: Definition): number => {
    if (definition.scope.level === "project") return definition.scope.id === project.id ? 0 : 3;
    if (definition.scope.level === "business_unit") return definition.scope.id === project.businessUnitId ? 1 : 3;
    return 2;
  };
  return definitions
    .filter((definition) => definition.kind === "agent" && definition.runsAs === agentId)
    .sort((a, b) => distance(a) - distance(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
}

/**
 * Current decisions that agents keep proposing to revise, replace or contradict, and reviewers keep rejecting.
 * Built from proposals the caller may see, so readers and agents never get this kind.
 */
async function rejectedAgentAttempts(
  ctx: MemoryNetContext,
  caller: Principal,
  current: readonly Memory[],
  definitions: readonly Definition[],
  projects: ReadonlyMap<string, ScannedProject>,
  now: Date,
): Promise<BrainRecommendation[]> {
  if (caller.kind !== "human") return [];
  const decisions = new Map(current.map((memory) => [memory.id, memory]));
  const scanned = [...new Set(current.map((memory) => memory.projectId))].filter(
    (id) => (projects.get(id)?.rank ?? 0) >= ROLE_RANK[MINIMUM_ROLE.readProposals],
  );
  const rejected: Proposal[] = [];
  for (const projectId of scanned) {
    rejected.push(...(await listProposals(ctx, caller.id, {
      scope: { level: "project", id: projectId },
      status: "rejected",
      limit: PROPOSAL_SCAN_LIMIT,
    })));
  }
  if (rejected.length === 0) return [];
  const principals = await describePrincipals(ctx.db, rejected.map((proposal) => proposal.proposedBy));
  const since = now.getTime() - REJECTION_WINDOW_MS;
  const attempts = new Map<string, { count: number; agents: Set<string>; at: Date | null }>();
  for (const proposal of rejected) {
    if (principals.get(proposal.proposedBy)?.kind !== "agent") continue;
    if (proposal.reviewedAt === null || proposal.reviewedAt.getTime() < since) continue;
    const targets = new Set(
      proposal.relations.links.filter((link) => link.relation === "conflicts_with").map((link) => link.memoryId),
    );
    if ((proposal.changeKind === "revise" || proposal.changeKind === "replace") && proposal.targetMemoryId !== null) {
      targets.add(proposal.targetMemoryId);
    }
    for (const target of targets) {
      if (!decisions.has(target)) continue;
      const entry = attempts.get(target) ?? { count: 0, agents: new Set<string>(), at: null };
      entry.count += 1;
      entry.agents.add(proposal.proposedBy);
      entry.at = latest([entry.at, proposal.reviewedAt]);
      attempts.set(target, entry);
    }
  }
  const found: BrainRecommendation[] = [];
  for (const [memoryId, entry] of attempts) {
    if (entry.count < REPEATED) continue;
    const memory = decisions.get(memoryId)!;
    const project = projects.get(memory.projectId)!;
    const agents = [...entry.agents].sort();
    const single = agents.length === 1;
    const agentDefinitions = agents.flatMap((agentId) => agentDefinitionFor(definitions, agentId, project) ?? []);
    const actions = [{ label: "Open the decision", href: `/memories/${memory.id}` }];
    for (const definition of agentDefinitions) {
      actions.push({
        label: single ? "Update the agent's instructions" : `Update the instructions of “${definition.name}”`,
        href: mayPropose(definition.callerRank)
          ? `/definitions/${definition.id}#propose-change`
          : `/definitions/${definition.id}`,
      });
    }
    if (agentDefinitions.length < agents.length) {
      actions.push({
        label: single ? "Update the agent's instructions" : "Open the project's definitions",
        href: `/scopes/project/${project.id}/definitions`,
      });
    }
    found.push({
      kind: "rejected_agent_attempts",
      projectId: memory.projectId,
      projectName: project.name,
      subject: memoryRef(memory),
      reason: `Reviewers rejected ${entry.count} agent proposals in the last ${REJECTION_WINDOW_DAYS} days that would change or contradict “${memory.title}”.`,
      related: agentDefinitions.map((definition) => ({ kind: "definition", id: definition.id, title: definition.name })),
      actions,
      at: entry.at,
    });
  }
  return found;
}

/** Pairs of current decisions in one project linked as conflicting that can apply at the same time, once per pair. */
function conflictingDecisions(
  current: readonly Memory[],
  projects: ReadonlyMap<string, ScannedProject>,
  now: Date,
): BrainRecommendation[] {
  const byId = new Map(current.map((memory) => [memory.id, memory]));
  const pairs = new Map<string, { declared: Memory[]; members: readonly [Memory, Memory] }>();
  for (const memory of current) {
    for (const link of memory.relations.links) {
      if (link.relation !== "conflicts_with") continue;
      const other = byId.get(link.memoryId);
      if (!other || other.id === memory.id || other.projectId !== memory.projectId) continue;
      if (!canOverlap(memory.applicability, other.applicability, now)) continue;
      const key = [memory.id, other.id].sort().join(" ");
      const pair = pairs.get(key) ?? { declared: [], members: [memory, other] as const };
      pair.declared.push(memory);
      pairs.set(key, pair);
    }
  }
  return [...pairs.values()].map(({ declared, members }): BrainRecommendation => {
    const subject = [...declared].sort(newestApproval)[0]!;
    const other = members[0].id === subject.id ? members[1] : members[0];
    return {
      kind: "conflicting_decisions",
      projectId: subject.projectId,
      projectName: projects.get(subject.projectId)?.name ?? null,
      subject: memoryRef(subject),
      reason: `“${subject.title}” and “${other.title}” are linked as conflicting, and both can apply now.`,
      related: [memoryRef(other)],
      actions: [
        { label: "Open the decision", href: `/memories/${subject.id}` },
        { label: "Open the conflicting decision", href: `/memories/${other.id}` },
      ],
      at: latest([subject.approvedAt, other.approvedAt]),
    };
  });
}

/** Every recommendation for the caller, unsorted and uncapped, from records the caller may read now. */
async function scanRecommendations(
  ctx: MemoryNetContext,
  callerId: string,
  input: { organizationId: string; projectId?: string },
): Promise<BrainRecommendation[]> {
  const organizationId = requireId(input.organizationId, "organizationId");
  const projectId = input.projectId === undefined ? undefined : requireId(input.projectId, "projectId");
  const caller = await requireCaller(ctx.db, callerId);
  const tree = await getOrganizationTree(ctx, caller.id, organizationId);
  const projects = new Map<string, ScannedProject>(
    tree.businessUnits.flatMap((unit) => unit.projects.map(
      (project) => [project.id, { id: project.id, name: project.name, businessUnitId: unit.id, rank: ROLE_RANK[project.role] }] as const,
    )),
  );
  if (projectId !== undefined && !projects.has(projectId)) throw scopeNotFound("project");
  const scope: ScopeRef = projectId === undefined
    ? { level: "organization", id: organizationId }
    : { level: "project", id: projectId };
  const now = ctx.now();
  const memories = await readableMemories(ctx.db, ctx, caller, scope, null, null);
  const readable = new Map(memories.map((memory) => [memory.id, memory]));
  const current = memories.filter((memory) => memory.status === "approved");
  const definitions = (await readableDefinitions(ctx.db, caller, organizationId, new Set(readable.keys())))
    .filter((definition) => definition.status === "active");
  return [
    ...outdatedDefinitions(definitions, readable, projects, projectId),
    ...(await recurringReports(ctx, current, projects)),
    ...(await rejectedAgentAttempts(ctx, caller, current, definitions, projects, now)),
    ...conflictingDecisions(current, projects, now),
  ];
}

/** Health findings that count recommendations per project; organization- and business-unit-level definitions have no project. */
function recommendationFindings(
  organizationId: string,
  recommendations: readonly BrainRecommendation[],
): BrainFinding[] {
  const groups = new Map<string, BrainRecommendation[]>();
  for (const recommendation of [...recommendations].sort(newestFirst)) {
    const key = `${recommendation.kind} ${recommendation.projectId ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(recommendation);
    else groups.set(key, [recommendation]);
  }
  return [...groups.values()].map((group): BrainFinding => {
    const first = group[0]!;
    const count = group.length;
    return {
      kind: FINDING_KIND[first.kind],
      projectId: first.projectId,
      projectName: first.projectName,
      count,
      href: first.projectId !== null
        ? `/projects/${first.projectId}#brain-recommendations`
        : count === 1
          ? `/definitions/${first.subject.id}`
          : `/scopes/organization/${organizationId}/definitions`,
      label: first.projectId === null
        ? `${count} organization or business-unit ${count === 1 ? "definition is" : "definitions are"} based on decisions that changed`
        : `${FINDING_LABEL[first.kind](count)} in ${first.projectName ?? "a project"}`,
    };
  });
}

/**
 * What a person may want to change, suggested only from records the caller may already read: definitions based on
 * decisions that changed, decisions reported as outdated more than once, decisions agents keep proposing to change
 * while reviewers keep rejecting, and current decisions linked as conflicting. Deterministic: no model is involved
 * and nothing is changed. Newest first.
 */
export async function listBrainRecommendations(
  ctx: MemoryNetContext,
  callerId: string,
  input: { organizationId: string; projectId?: string; limit?: number },
): Promise<BrainRecommendation[]> {
  const limit = optionalLimit(input.limit, DEFAULT_RECOMMENDATION_LIMIT, MAX_RECOMMENDATION_LIMIT);
  const recommendations = await scanRecommendations(ctx, callerId, input);
  return recommendations.sort(newestFirst).slice(0, limit);
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

export interface BrainAnswer {
  question: string;
  answer: string;
  citations: string[];
  retrievalId: string;
  model: string;
}

/** Approved knowledge an Ask may draw on. The retrieval is logged like every search. */
export async function buildAskContext(
  ctx: MemoryNetContext,
  callerId: string,
  projectId: string,
  question: string,
): Promise<{ projectId: string; question: string; retrievalId: string; memories: ContextMemory[] }> {
  const caller = await requireCaller(ctx.db, callerId);
  requireHuman(caller, "ask the brain");
  const id = requireId(projectId, "projectId");
  const scope = await resolveScope(ctx.db, { level: "project", id });
  await requireRole(ctx.db, caller, scope, "reader", "ask the brain");
  const trimmed = question.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    throw new ValidationError("Ask a question of up to 500 characters");
  }
  const response = await getContext(ctx, caller.id, { projectId: id, query: trimmed });
  return { projectId: id, question: trimmed, retrievalId: response.retrievalId, memories: response.current };
}

export interface BrainActivityEvent {
  at: Date;
  label: string;
  href: string;
  projectName: string | null;
}

/**
 * The brain's recent activity in one organization, assembled only from
 * append-only records the caller may already read. Newest first.
 */
export async function listBrainActivity(
  ctx: MemoryNetContext,
  callerId: string,
  organizationId: string,
  limit = 15,
): Promise<BrainActivityEvent[]> {
  const graph = await getNetwork(ctx, callerId, organizationId, { includeUncitedSources: false });
  const projects = graph.clusters.filter((cluster) => cluster.level === "project");
  const events: BrainActivityEvent[] = [];
  for (const cluster of projects) {
    const recordId = cluster.recordId;
    const briefs = await listBrainBriefs(ctx, callerId, recordId).catch(() => []);
    for (const brief of briefs) {
      events.push({ at: brief.createdAt, label: `Brain brief generated in ${cluster.name}`, href: `/projects/${recordId}#brain`, projectName: cluster.name });
    }
    const memories = await listMemories(ctx, callerId, { scope: { level: "project", id: recordId }, limit: 20 }).catch(() => []);
    for (const memory of memories) {
      events.push({ at: memory.approvedAt, label: `Approved: ${memory.title}`, href: `/memories/${memory.id}`, projectName: cluster.name });
    }
    const runs = await ctx.db.query<{ id: string; created_at: Date }>(
      "SELECT id, created_at FROM decision_guard_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 5",
      [recordId],
    ).catch(() => ({ rows: [] as { id: string; created_at: Date }[] }));
    for (const run of runs.rows) {
      events.push({ at: run.created_at, label: `Decision Guard run in ${cluster.name}`, href: `/decision-guard/runs/${run.id}`, projectName: cluster.name });
    }
  }
  events.sort((a, b) => b.at.getTime() - a.at.getTime());
  return events.slice(0, limit);
}
