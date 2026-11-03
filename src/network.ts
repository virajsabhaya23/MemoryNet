import {
  requireCaller,
  resolveScope,
  type ScopeLevel,
  type ScopeRef,
} from "./access.ts";
import type { ContentFlag } from "./content-checks.ts";
import type { MemoryNetContext } from "./context.ts";
import {
  effectiveRolesAt,
  readableDefinitionProposals,
  readableDefinitions,
  type DefinitionKind,
  type DefinitionRelation,
  type DefinitionStatus,
} from "./definitions.ts";
import {
  readableMemories,
  listSources,
  type CaptureMethod,
  type MemoryStatus,
  type MemoryType,
} from "./knowledge.ts";
import { describePrincipals } from "./members.ts";
import { getOrganizationTree } from "./organizations.ts";
import { ROLE_RANK, type PrincipalKind, type Role } from "./roles.ts";

export const NODE_KINDS = [
  "rule",
  "instruction",
  "skill",
  "agent",
  "memory",
  "source",
  "person",
  "agent_account",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_RELATIONS = [
  "uses",
  "follows",
  "hands_off_to",
  "based_on",
  "runs_as",
  "cites",
  "owns",
] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

/** An organization, business unit, or project the caller can see. */
export interface NetworkCluster {
  /** Such as "project:<uuid>". */
  id: string;
  level: ScopeLevel;
  recordId: string;
  name: string;
  parentId: string | null;
  /** The caller's role at this level, including roles from above; null when they only work inside it. */
  role: Role | null;
  /** New definitions waiting for review here; null when the caller may not see proposals. */
  pendingNewDefinitions: number | null;
}

export interface MemoryNodeDetails {
  type: MemoryType;
  title: string;
  content: string;
  revision: number;
  ownerName: string;
  proposedByName: string;
  approvedByName: string;
  approvedAt: Date;
  evidenceCount: number;
}

export interface SourceNodeDetails {
  reference: string;
  url: string;
  repository: string | null;
  revision: string | null;
  excerpt: string;
  captureMethod: CaptureMethod;
  capturedByName: string | null;
  capturedAt: Date;
  flags: ContentFlag[];
}

export interface DefinitionNodeDetails {
  kind: DefinitionKind;
  status: DefinitionStatus;
  name: string;
  purpose: string;
  responsibilities: string[];
  boundaries: string[];
  instructions: string;
  appliesTo: string | null;
  revision: number;
  changeNote: string | null;
  flags: ContentFlag[];
  ownerName: string;
  proposedByName: string;
  approvedByName: string;
  approvedAt: Date;
  scopeLevel: ScopeLevel;
  scopeName: string;
  runsAsName: string | null;
  /** The agent account's role at this level. Only administrators here see it; otherwise undefined. */
  runsAsRole?: Role | null;
  /** Changes waiting for review; null when the caller may not see proposals. */
  pendingChanges: number | null;
  /** Things a reader should know, such as a link to a retired definition. */
  warnings: string[];
}

export interface PrincipalNodeDetails {
  kind: PrincipalKind;
  displayName: string;
}

export interface NetworkNode {
  /** Such as "definition:<uuid>". */
  id: string;
  kind: NodeKind;
  recordId: string;
  label: string;
  /** The innermost group it belongs to. People sit in the smallest group holding everything linked to them. */
  clusterId: string;
  status: "current" | DefinitionStatus | null;
  details:
    | MemoryNodeDetails
    | SourceNodeDetails
    | DefinitionNodeDetails
    | PrincipalNodeDetails;
}

export interface NetworkEdge {
  id: string;
  relation: EdgeRelation;
  from: string;
  to: string;
  /** Plain words saying which record this connection comes from. */
  why: string;
  /** The table holding that record. */
  table: string;
}

/** Everything the caller may see in one organization, built from the same records and read rules as every page. */
export interface NetworkGraph {
  generatedAt: Date;
  organization: { id: string; slug: string; name: string };
  viewer: { id: string; kind: PrincipalKind; displayName: string };
  clusters: NetworkCluster[];
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

const RETIRED_TARGET_WORDS: Readonly<
  Record<Exclude<DefinitionRelation, "based_on">, string>
> = {
  uses: "Uses",
  follows: "Follows",
  hands_off_to: "Hands off to",
};

const NOT_CURRENT_WORDS: Readonly<
  Record<Exclude<MemoryStatus, "approved">, string>
> = {
  suspended: "which is suspended",
  superseded: "which was replaced",
  revoked: "which was revoked",
};

export function clusterIdOf(scope: ScopeRef): string {
  return `${scope.level}:${scope.id}`;
}

function shortDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "checkout-service #11" for pull/11 of acme-synthetic/checkout-service. */
function sourceLabel(reference: string, repository: string | null): string {
  const number = reference.startsWith("pull/")
    ? `#${reference.slice(5)}`
    : reference;
  const repo = repository?.split("/")[1];
  return repo === undefined ? `PR ${number}` : `${repo} ${number}`;
}

/** The smallest group containing every given group. */
function commonCluster(
  ids: readonly string[],
  parents: ReadonlyMap<string, string | null>,
): string | null {
  const chain = (id: string): string[] => {
    const path: string[] = [];
    let at: string | null = id;
    while (at !== null) {
      path.unshift(at);
      at = parents.get(at) ?? null;
    }
    return path;
  };
  let shared: string[] | null = null;
  for (const id of ids) {
    const path = chain(id);
    if (shared === null) {
      shared = path;
      continue;
    }
    let length = 0;
    while (length < shared.length && shared[length] === path[length])
      length += 1;
    shared = shared.slice(0, length);
  }
  return shared?.at(-1) ?? null;
}

/**
 * The organization's network as the caller may see it: groups for the organization, its business units,
 * and projects; approved memories and the sources they cite; agents, skills, instructions, and rules;
 * and the people who own them. Nothing hidden from the caller appears, not even as a count.
 */
export async function getNetwork(
  ctx: MemoryNetContext,
  callerId: string,
  organizationId: string,
  options: { includeUncitedSources?: boolean } = {},
): Promise<NetworkGraph> {
  const caller = await requireCaller(ctx.db, callerId);
  const tree = await getOrganizationTree(ctx, caller.id, organizationId);
  const orgId = tree.organization.id;
  const readable = await readableMemories(
    ctx.db,
    ctx,
    caller,
    { level: "organization", id: orgId },
    null,
    null,
  );
  const memories = readable.filter((memory) => memory.status === "approved");
  const readableById = new Map(readable.map((memory) => [memory.id, memory]));
  const memoryIds = new Set(readableById.keys());
  const definitions = await readableDefinitions(
    ctx.db,
    caller,
    orgId,
    memoryIds,
  );
  const pending = await readableDefinitionProposals(
    ctx.db,
    caller,
    orgId,
    memoryIds,
    {
      status: "pending",
    },
  );

  const orgCluster = clusterIdOf({ level: "organization", id: orgId });
  const clusters: NetworkCluster[] = [
    {
      id: orgCluster,
      level: "organization",
      recordId: orgId,
      name: tree.organization.name,
      parentId: null,
      role: tree.role,
      pendingNewDefinitions: null,
    },
  ];
  for (const unit of tree.businessUnits) {
    const unitCluster = clusterIdOf({ level: "business_unit", id: unit.id });
    clusters.push({
      id: unitCluster,
      level: "business_unit",
      recordId: unit.id,
      name: unit.name,
      parentId: orgCluster,
      role: unit.role,
      pendingNewDefinitions: null,
    });
    for (const project of unit.projects) {
      clusters.push({
        id: clusterIdOf({ level: "project", id: project.id }),
        level: "project",
        recordId: project.id,
        name: project.name,
        parentId: unitCluster,
        role: project.role,
        pendingNewDefinitions: null,
      });
    }
  }
  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const seesProposals = (cluster: NetworkCluster) =>
    caller.kind === "human" &&
    cluster.role !== null &&
    ROLE_RANK[cluster.role] >= ROLE_RANK.contributor;
  for (const cluster of clusters) {
    if (!seesProposals(cluster)) continue;
    cluster.pendingNewDefinitions = pending.filter(
      (proposal) =>
        proposal.action === "create" &&
        clusterIdOf(proposal.scope) === cluster.id,
    ).length;
  }

  // Optional evidence view: source access uses the same scoped read checks as source pages.
  // Each repository is bounded to its newest 200 records; no proposal becomes approved guidance.
  const importedSources = options.includeUncitedSources
    ? (await Promise.all(clusters.filter(c => c.level === "project").map(c =>
        listSources(ctx, caller.id, { scope: {level:"project", id:c.recordId}, limit:200 })))).flat()
    : [];
  const sourceIds = [
    ...new Set(
      [...memories.flatMap((memory) => memory.evidence.map((e) => e.sourceId)), ...importedSources.map(s => s.id)],
    ),
  ];
  const sourceFacts = await ctx.db.query<{
    id: string;
    project_id: string;
    capture_method: CaptureMethod;
    captured_by: string | null;
    full_name: string | null;
  }>(
    `SELECT s.id, s.project_id, s.capture_method, s.captured_by, rc.full_name
     FROM sources s
     LEFT JOIN repository_connections rc
       ON rc.project_id = s.project_id AND rc.provider = s.provider
      AND rc.external_repository_id = s.external_repository_id AND rc.disconnected_at IS NULL
     WHERE s.id = ANY($1::uuid[])`,
    [sourceIds],
  );
  const factsById = new Map(sourceFacts.rows.map((row) => [row.id, row]));

  const names = await describePrincipals(ctx.db, [
    ...memories.flatMap((m) => [m.ownerId, m.proposedBy, m.approvedBy]),
    ...definitions.flatMap((d) => [
      d.ownerId,
      d.proposedBy,
      d.approvedBy,
      ...(d.runsAs === null ? [] : [d.runsAs]),
    ]),
    ...sourceFacts.rows.flatMap((row) =>
      row.captured_by === null ? [] : [row.captured_by],
    ),
  ]);
  const nameOf = (id: string) => names.get(id)?.displayName ?? "Unknown";

  const nodes: NetworkNode[] = [];
  const edges: NetworkEdge[] = [];
  const principalLinks = new Map<string, string[]>();
  const linkPrincipal = (principalId: string, clusterId: string) => {
    principalLinks.set(principalId, [
      ...(principalLinks.get(principalId) ?? []),
      clusterId,
    ]);
  };

  const definitionsById = new Map(definitions.map((d) => [d.id, d]));
  const adminRolesByScope = new Map<string, Map<string, Role>>();
  for (const definition of definitions) {
    if (
      definition.runsAs === null ||
      caller.kind !== "human" ||
      definition.callerRank < ROLE_RANK.administrator
    ) {
      continue;
    }
    const key = clusterIdOf(definition.scope);
    const scope = await resolveScope(ctx.db, definition.scope);
    const roles = await effectiveRolesAt(ctx.db, scope, [definition.runsAs]);
    const known = adminRolesByScope.get(key) ?? new Map<string, Role>();
    for (const [id, role] of roles) known.set(id, role);
    adminRolesByScope.set(key, known);
  }

  for (const definition of definitions) {
    const clusterId = clusterIdOf(definition.scope);
    const cluster = clusterById.get(clusterId);
    if (!cluster) continue;
    const warnings: string[] = [];
    if (definition.status === "retired") {
      warnings.push(
        "Retired: kept for its history. Nothing should rely on it now.",
      );
    }
    for (const link of definition.links) {
      if (link.relation === "based_on") {
        const memory = readableById.get(link.targetId);
        if (memory && memory.status !== "approved") {
          warnings.push(
            `Based on “${memory.title}”, ${NOT_CURRENT_WORDS[memory.status]}.`,
          );
        }
        continue;
      }
      const target = definitionsById.get(link.targetId);
      if (target?.status === "retired") {
        warnings.push(
          `${RETIRED_TARGET_WORDS[link.relation]} “${target.name}”, which is retired.`,
        );
      }
    }
    const seesRole =
      definition.runsAs !== null &&
      caller.kind === "human" &&
      definition.callerRank >= ROLE_RANK.administrator;
    const runsAsRole = seesRole
      ? (adminRolesByScope.get(clusterId)?.get(definition.runsAs ?? "") ?? null)
      : undefined;
    if (seesRole && runsAsRole === null) {
      warnings.push(
        "Its agent account has no role at this level, so it cannot read anything here.",
      );
    }
    const details: DefinitionNodeDetails = {
      kind: definition.kind,
      status: definition.status,
      name: definition.name,
      purpose: definition.purpose,
      responsibilities: definition.responsibilities,
      boundaries: definition.boundaries,
      instructions: definition.instructions,
      appliesTo: definition.appliesTo,
      revision: definition.revision,
      changeNote: definition.changeNote,
      flags: definition.flags,
      ownerName: nameOf(definition.ownerId),
      proposedByName: nameOf(definition.proposedBy),
      approvedByName: nameOf(definition.approvedBy),
      approvedAt: definition.approvedAt,
      scopeLevel: definition.scope.level,
      scopeName: cluster.name,
      runsAsName: definition.runsAs === null ? null : nameOf(definition.runsAs),
      ...(runsAsRole === undefined ? {} : { runsAsRole }),
      pendingChanges: seesProposals(cluster)
        ? pending.filter((proposal) => proposal.definitionId === definition.id)
            .length
        : null,
      warnings,
    };
    const nodeId = `definition:${definition.id}`;
    nodes.push({
      id: nodeId,
      kind: definition.kind,
      recordId: definition.id,
      label: definition.name,
      clusterId,
      status: definition.status,
      details,
    });
    const approved = `approved by ${nameOf(definition.approvedBy)} on ${shortDate(definition.approvedAt)}`;
    edges.push({
      id: `owns:${definition.ownerId}:${nodeId}`,
      relation: "owns",
      from: `principal:${definition.ownerId}`,
      to: nodeId,
      why: `Named owner in version ${definition.revision}, ${approved}.`,
      table: "definition_revisions",
    });
    linkPrincipal(definition.ownerId, clusterId);
    if (definition.runsAs !== null) {
      edges.push({
        id: `runs_as:${nodeId}:${definition.runsAs}`,
        relation: "runs_as",
        from: nodeId,
        to: `principal:${definition.runsAs}`,
        why: `Set in version ${definition.revision}, ${approved}.`,
        table: "definition_revisions",
      });
      linkPrincipal(definition.runsAs, clusterId);
    }
    for (const link of definition.links) {
      if (
        link.relation === "based_on" &&
        readableById.get(link.targetId)?.status !== "approved"
      ) {
        continue;
      }
      const to =
        link.relation === "based_on"
          ? `memory:${link.targetId}`
          : `definition:${link.targetId}`;
      edges.push({
        id: `${link.relation}:${nodeId}:${to}`,
        relation: link.relation,
        from: nodeId,
        to,
        why: `Link in version ${definition.revision}, ${approved}.`,
        table: "definition_links",
      });
    }
  }

  for (const memory of memories) {
    const clusterId = clusterIdOf({ level: "project", id: memory.projectId });
    if (!clusterById.has(clusterId)) continue;
    const nodeId = `memory:${memory.id}`;
    nodes.push({
      id: nodeId,
      kind: "memory",
      recordId: memory.id,
      label: memory.title,
      clusterId,
      status: "current",
      details: {
        type: memory.type,
        title: memory.title,
        content: memory.content,
        revision: memory.revision,
        ownerName: nameOf(memory.ownerId),
        proposedByName: nameOf(memory.proposedBy),
        approvedByName: nameOf(memory.approvedBy),
        approvedAt: memory.approvedAt,
        evidenceCount: memory.evidence.length,
      },
    });
    edges.push({
      id: `owns:${memory.ownerId}:${nodeId}`,
      relation: "owns",
      from: `principal:${memory.ownerId}`,
      to: nodeId,
      why: `Named owner of this memory, approved by ${nameOf(memory.approvedBy)} on ${shortDate(memory.approvedAt)}.`,
      table: "memories",
    });
    linkPrincipal(memory.ownerId, clusterId);
    for (const evidence of memory.evidence) {
      edges.push({
        id: `cites:${nodeId}:source:${evidence.sourceId}`,
        relation: "cites",
        from: nodeId,
        to: `source:${evidence.sourceId}`,
        why: `Version ${memory.revision} of the memory cites this pull request as evidence.`,
        table: "memory_evidence",
      });
    }
  }

  const sourcesSeen = new Set<string>();
  for (const memory of memories) {
    for (const evidence of memory.evidence) {
      if (sourcesSeen.has(evidence.sourceId)) continue;
      sourcesSeen.add(evidence.sourceId);
      const facts = factsById.get(evidence.sourceId);
      const clusterId = clusterIdOf({
        level: "project",
        id: facts?.project_id ?? memory.projectId,
      });
      nodes.push({
        id: `source:${evidence.sourceId}`,
        kind: "source",
        recordId: evidence.sourceId,
        label: sourceLabel(evidence.reference, facts?.full_name ?? null),
        clusterId,
        status: null,
        details: {
          reference: evidence.reference,
          url: evidence.url,
          repository: facts?.full_name ?? null,
          revision: evidence.revision,
          excerpt: evidence.excerpt,
          captureMethod: facts?.capture_method ?? "manual",
          capturedByName:
            facts?.captured_by === null || facts?.captured_by === undefined
              ? null
              : nameOf(facts.captured_by),
          capturedAt: evidence.capturedAt,
          flags: evidence.flags,
        },
      });
    }
  }

  for (const source of importedSources) {
    if (sourcesSeen.has(source.id)) continue;
    const facts = factsById.get(source.id);
    nodes.push({ id:`source:${source.id}`, kind:"source", recordId:source.id,
      label: sourceLabel(source.reference, facts?.full_name ?? null),
      clusterId: clusterIdOf({level:"project",id:source.projectId}), status:null,
      details:{reference:source.reference,url:source.url,repository:facts?.full_name ?? null,
        revision:source.revision,excerpt:source.excerpt,captureMethod:source.captureMethod,
        capturedByName:source.capturedBy === null ? null : nameOf(source.capturedBy),capturedAt:source.capturedAt,flags:source.flags} });
    sourcesSeen.add(source.id);
  }

  const parents = new Map(
    clusters.map((cluster) => [cluster.id, cluster.parentId]),
  );
  for (const [principalId, clusterIds] of [...principalLinks].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const entry = names.get(principalId);
    const kind: PrincipalKind = entry?.kind ?? "human";
    nodes.push({
      id: `principal:${principalId}`,
      kind: kind === "agent" ? "agent_account" : "person",
      recordId: principalId,
      label: entry?.displayName ?? "Unknown",
      clusterId: commonCluster(clusterIds, parents) ?? orgCluster,
      status: null,
      details: { kind, displayName: entry?.displayName ?? "Unknown" },
    });
  }

  const present = new Set(nodes.map((node) => node.id));
  const order = new Map(NODE_KINDS.map((kind, index) => [kind, index]));
  nodes.sort(
    (a, b) =>
      (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );
  const uniqueEdges = new Map<string, NetworkEdge>();
  for (const edge of edges) {
    if (present.has(edge.from) && present.has(edge.to))
      uniqueEdges.set(edge.id, edge);
  }
  return {
    generatedAt: ctx.now(),
    organization: {
      id: orgId,
      slug: tree.organization.slug,
      name: tree.organization.name,
    },
    viewer: {
      id: caller.id,
      kind: caller.kind,
      displayName: caller.displayName,
    },
    clusters,
    nodes,
    edges: [...uniqueEdges.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Kinds of definition nodes, for callers that need to tell them apart from memories and people. */
export function isDefinitionKind(kind: NodeKind): kind is DefinitionKind {
  return (
    kind === "agent" ||
    kind === "skill" ||
    kind === "instruction" ||
    kind === "rule"
  );
}
