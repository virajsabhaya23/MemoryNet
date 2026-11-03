// "Your network": the viewer at the center of the places they can see, each place's knowledge loaded only
// when it is opened. Every count and item comes from the same read rules as the rest of MemoryNet.
import { requireCaller, type Principal } from "../access.ts";
import type { MemoryNetContext } from "../context.ts";
import { readableDefinitions, type Definition } from "../definitions.ts";
import { NotFoundError } from "../errors.ts";
import {
  readableKnowledgeCounts,
  readableMemories,
  type Memory,
} from "../knowledge.ts";
import { describePrincipals } from "../members.ts";
import {
  getOrganizationTree,
  type OrganizationTree,
} from "../organizations.ts";
import { ROLE_RANK, type Role } from "../roles.ts";
import {
  OPEN_BUDGET,
  PLACE_BUDGET,
  UNIT_BUDGET,
} from "./assets/my-network-view.js";

/** direct: the viewer's role starts here. covered: a role above covers it. inside: no role, but the viewer works inside it. */
export type Access = "direct" | "covered" | "inside";
export type Family = "work" | "know" | "evidence";
type Level = "organization" | "business_unit" | "project";
type ItemKind =
  | "rule"
  | "instruction"
  | "skill"
  | "agent"
  | "memory"
  | "source";

const KIND_LABEL: Readonly<Record<ItemKind, string>> = {
  rule: "Rule",
  instruction: "Instruction",
  skill: "Skill",
  agent: "Agent",
  memory: "Memory",
  source: "Evidence",
};
const KIND_ORDER: readonly ItemKind[] = [
  "rule",
  "instruction",
  "skill",
  "agent",
];
const LEVEL_WORD: Readonly<Record<Level, string>> = {
  organization: "organization",
  business_unit: "business unit",
  project: "project",
};

/** What each role adds, from the role rules in the requirements. */
export const ROLE_MEANING: Readonly<Record<Role, string>> = {
  reader: "read approved memories and their sources",
  contributor: "also record sources, propose memories, and see proposals",
  reviewer: "also approve or reject other people's proposals",
  administrator:
    "also create business units and projects, connect repositories, and manage access",
  owner: "also manage administrators and owners",
};

export interface PlaceCounts {
  work: number;
  know: number;
  evidence: number;
  owned: number;
}

interface PlaceBase {
  /** Such as "project:<uuid>", the same IDs as the full network. */
  id: string;
  recordId: string;
  level: Level;
  name: string;
  parentId: string | null;
  role: Role | null;
  access: Access;
  /** The place the viewer's role comes from; null without a role. */
  roleFrom: string | null;
  why: string;
}

export interface MyPlace extends PlaceBase {
  counts: PlaceCounts;
  /** Projects inside a business unit. */
  children: number;
  /** Drawn at first; false when it waits until its business unit is opened. */
  drawn: boolean;
}

export interface MyOverview {
  viewer: { id: string; name: string; kind: "human" | "agent" };
  organization: { id: string; name: string };
  places: MyPlace[];
  /** True when there are too many projects to draw at once: only yours show until their unit is opened. */
  folded: boolean;
  /** Drawn business units in order, then "more:units" when some are only listed. */
  tops: string[];
  /** Projects drawn under each business unit at first, in order. */
  kids: Record<string, string[]>;
  /** Business units past UNIT_BUDGET: listed under the "more" node instead of drawn. */
  listed: MyPlace[];
  totals: PlaceCounts & { places: number };
}

export interface MyItem {
  id: string;
  kind: ItemKind;
  kindLabel: string;
  family: Family;
  label: string;
  href: string;
  owned: boolean;
  why: string;
  facts: string[];
}

export interface MyPlaceContents {
  place: string;
  items: MyItem[];
  /** Projects of a business unit, when projects are folded; the ones you have a role in come first. */
  children: MyPlace[];
  links: Array<{ from: string; to: string; relation: string }>;
  /** Items or projects that are not drawn, to be found on the place's own page. */
  more: number;
}

function article(role: Role): string {
  return role === "administrator" || role === "owner" ? "an" : "a";
}

function clusterId(level: Level, id: string): string {
  return `${level}:${id}`;
}

function emptyCounts(): PlaceCounts {
  return { work: 0, know: 0, evidence: 0, owned: 0 };
}

interface Visible {
  caller: Principal;
  tree: OrganizationTree;
  places: Map<string, PlaceBase>;
}

/** The places the caller can see, with how they reach each one. Hidden places read as missing. */
async function visiblePlaces(
  ctx: MemoryNetContext,
  callerId: string,
  organizationId: string,
): Promise<Visible> {
  const caller = await requireCaller(ctx.db, callerId);
  const tree = await getOrganizationTree(ctx, caller.id, organizationId);
  const places = new Map<string, PlaceBase>();
  const add = (
    level: Level,
    recordId: string,
    name: string,
    parentId: string | null,
    role: Role | null,
  ): string => {
    const parent = parentId === null ? undefined : places.get(parentId);
    const id = clusterId(level, recordId);
    if (role === null) {
      places.set(id, {
        id,
        recordId,
        level,
        name,
        parentId,
        role,
        access: "inside",
        roleFrom: null,
        why: "You have no role here. You see it because you work inside it, and the guidance it shares reaches you.",
      });
      return id;
    }
    const covered =
      parent?.role != null && ROLE_RANK[parent.role] >= ROLE_RANK[role];
    const roleFrom = covered ? (parent?.roleFrom ?? name) : name;
    const can = `As ${article(role)} ${role} you can ${ROLE_MEANING[role]}.`;
    places.set(id, {
      id,
      recordId,
      level,
      name,
      parentId,
      role,
      access: covered ? "covered" : "direct",
      roleFrom,
      why: covered
        ? `You are ${article(role)} ${role} of ${roleFrom}, which covers everything inside it. ${can}`
        : `You are ${article(role)} ${role} here. ${can}`,
    });
    return id;
  };
  const orgId = add(
    "organization",
    tree.organization.id,
    tree.organization.name,
    null,
    tree.role,
  );
  for (const unit of tree.businessUnits) {
    const unitId = add("business_unit", unit.id, unit.name, orgId, unit.role);
    for (const project of unit.projects) {
      add("project", project.id, project.name, unitId, project.role);
    }
  }
  return { caller, tree, places };
}

function scopeOf(definition: Definition): string {
  return clusterId(definition.scope.level, definition.scope.id);
}

/** How much each place holds that the caller may read; all projects, or only `projects` (record IDs). */
async function placeCounts(
  ctx: MemoryNetContext,
  visible: Visible,
  projects?: readonly string[],
): Promise<Map<string, PlaceCounts>> {
  const { caller, tree, places } = visible;
  const [knowledge, definitions] = await Promise.all([
    readableKnowledgeCounts(
      ctx.db,
      ctx,
      caller,
      tree.organization.id,
      projects,
    ),
    readableDefinitions(ctx.db, caller, tree.organization.id, new Set()),
  ]);
  const counts = new Map<string, PlaceCounts>();
  for (const id of places.keys()) counts.set(id, emptyCounts());
  for (const [projectId, count] of knowledge) {
    const entry = counts.get(clusterId("project", projectId));
    if (!entry) continue;
    entry.know = count.memories;
    entry.evidence = count.sources;
    entry.owned += count.owned;
  }
  for (const definition of definitions) {
    if (definition.status !== "active") continue;
    const entry = counts.get(scopeOf(definition));
    if (!entry) continue;
    entry.work += 1;
    if (definition.ownerId === caller.id) entry.owned += 1;
  }
  return counts;
}

interface DrawPlan {
  units: string[];
  listed: string[];
  folded: boolean;
  kids: Map<string, string[]>;
}

/**
 * What is drawn at first, within the budgets: business units (the ones holding your roles first when there
 * are too many), and their projects, or only the projects you have a role in when there are too many.
 */
function drawPlan(visible: Visible): DrawPlan {
  const { tree, places } = visible;
  const direct = (id: string) => places.get(id)?.access === "direct";
  const units = tree.businessUnits.map((unit) => ({
    id: clusterId("business_unit", unit.id),
    projects: unit.projects.map((project) => clusterId("project", project.id)),
  }));
  const yours = (unit: (typeof units)[number]) =>
    direct(unit.id) || unit.projects.some(direct);
  let shown = units;
  if (units.length > UNIT_BUDGET) {
    const keep = new Set(
      [...units]
        .sort(
          (a, b) =>
            Number(yours(b)) - Number(yours(a)) ||
            b.projects.length - a.projects.length,
        )
        .slice(0, UNIT_BUDGET - 1)
        .map((unit) => unit.id),
    );
    shown = units.filter((unit) => keep.has(unit.id));
  }
  const listed = units
    .filter((unit) => !shown.includes(unit))
    .map((unit) => unit.id);
  const projectCount = shown.reduce(
    (sum, unit) => sum + unit.projects.length,
    0,
  );
  const folded = projectCount > PLACE_BUDGET;
  const kids = new Map<string, string[]>();
  let room = PLACE_BUDGET;
  for (const unit of shown) {
    const drawn = (folded ? unit.projects.filter(direct) : unit.projects).slice(
      0,
      Math.max(0, room),
    );
    room -= drawn.length;
    kids.set(unit.id, drawn);
  }
  return { units: shown.map((unit) => unit.id), listed, folded, kids };
}

/** Everything the page draws at first: you, the places you can see, and how much each holds. */
export async function getMyOverview(
  ctx: MemoryNetContext,
  callerId: string,
  organizationId: string,
): Promise<MyOverview> {
  const visible = await visiblePlaces(ctx, callerId, organizationId);
  const { caller, tree, places } = visible;
  const counts = await placeCounts(ctx, visible);
  const plan = drawPlan(visible);
  const tops = [...plan.units];
  if (plan.listed.length > 0) tops.push("more:units");
  const drawn = new Set([
    ...plan.units,
    ...[...plan.kids.values()].flat(),
  ]);
  const childCount = new Map(
    tree.businessUnits.map((unit) => [
      clusterId("business_unit", unit.id),
      unit.projects.length,
    ]),
  );
  const out: MyPlace[] = [];
  for (const place of places.values()) {
    out.push({
      ...place,
      counts: counts.get(place.id) ?? emptyCounts(),
      children: childCount.get(place.id) ?? 0,
      drawn: place.level === "organization" || drawn.has(place.id),
    });
  }
  const totals = { places: out.length, ...emptyCounts() };
  for (const place of out) {
    totals.work += place.counts.work;
    totals.know += place.counts.know;
    totals.evidence += place.counts.evidence;
    totals.owned += place.counts.owned;
  }
  const byId = new Map(out.map((place) => [place.id, place]));
  return {
    viewer: { id: caller.id, name: caller.displayName, kind: caller.kind },
    organization: { id: tree.organization.id, name: tree.organization.name },
    places: out,
    folded: plan.folded,
    tops,
    kids: Object.fromEntries(plan.kids),
    listed: plan.listed.flatMap((id) => byId.get(id) ?? []),
    totals,
  };
}

function itemWhy(place: PlaceBase, kind: ItemKind): string {
  const where = `${place.name} (${LEVEL_WORD[place.level]})`;
  const role = place.role;
  if (kind === "memory") {
    return role === null
      ? `It belongs to ${where}.`
      : `You are ${article(role)} ${role} of ${where}, and you can read the GitHub repository its evidence comes from.`;
  }
  if (kind === "source") {
    return `You have a role in ${where}, and GitHub reports that you can read its repository.`;
  }
  return role === null
    ? `It is defined for ${where}. Guidance reaches every part inside a level, including where you work.`
    : `It is defined for ${where}, where you are ${article(role)} ${role}.`;
}

function sourceLabel(url: string, reference: string): string {
  const match = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url);
  return match ? `${match[1]} #${match[2]}` : reference;
}

/**
 * One opened place: its knowledge and, when projects are folded, a business unit's projects, at most
 * OPEN_BUDGET of each, with the links among them. Only places and records the caller may see.
 */
export async function getMyPlace(
  ctx: MemoryNetContext,
  callerId: string,
  organizationId: string,
  placeId: string,
): Promise<MyPlaceContents> {
  const visible = await visiblePlaces(ctx, callerId, organizationId);
  const { caller, tree, places } = visible;
  const place = places.get(placeId);
  if (!place) throw new NotFoundError("Place not found");
  const memories: Memory[] =
    place.level === "project"
      ? await readableMemories(
          ctx.db,
          ctx,
          caller,
          { level: "project", id: place.recordId },
          OPEN_BUDGET,
          "approved",
        )
      : [];
  const definitions = (
    await readableDefinitions(
      ctx.db,
      caller,
      tree.organization.id,
      new Set(memories.map((memory) => memory.id)),
    )
  )
    .filter(
      (definition) =>
        definition.status === "active" && scopeOf(definition) === placeId,
    )
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.name.localeCompare(b.name),
    );
  const names = await describePrincipals(ctx.db, [
    ...memories.map((memory) => memory.ownerId),
    ...definitions.map((definition) => definition.ownerId),
  ]);
  const nameOf = (id: string) => names.get(id)?.displayName ?? "Unknown";

  const items: MyItem[] = [];
  const links: MyPlaceContents["links"] = [];
  let total = definitions.length;
  for (const definition of definitions.slice(0, OPEN_BUDGET)) {
    items.push({
      id: `definition:${definition.id}`,
      kind: definition.kind,
      kindLabel: KIND_LABEL[definition.kind],
      family: "work",
      label: definition.name,
      href: `/definitions/${definition.id}`,
      owned: definition.ownerId === caller.id,
      why: itemWhy(place, definition.kind),
      facts: [
        `Version ${definition.revision}`,
        `Owner: ${nameOf(definition.ownerId)}`,
        definition.purpose,
      ],
    });
  }
  if (place.level === "project") {
    const counts = await placeCounts(ctx, visible, [place.recordId]);
    const count = counts.get(placeId);
    total += (count?.know ?? 0) + (count?.evidence ?? 0);
    // Room is shared between memories and their evidence, so each shown memory brings its sources.
    for (const memory of memories) {
      const sources = memory.evidence.filter(
        (evidence) =>
          !items.some((item) => item.id === `source:${evidence.sourceId}`),
      );
      if (items.length + 1 + sources.length > OPEN_BUDGET) break;
      items.push({
        id: `memory:${memory.id}`,
        kind: "memory",
        kindLabel: KIND_LABEL.memory,
        family: "know",
        label: memory.title,
        href: `/memories/${memory.id}`,
        owned: memory.ownerId === caller.id,
        why: itemWhy(place, "memory"),
        facts: [
          `${memory.type.replaceAll("_", " ")}, version ${memory.revision}`,
          `Owner: ${nameOf(memory.ownerId)}`,
        ],
      });
      for (const evidence of sources) {
        items.push({
          id: `source:${evidence.sourceId}`,
          kind: "source",
          kindLabel: KIND_LABEL.source,
          family: "evidence",
          label: sourceLabel(evidence.url, evidence.reference),
          href: `/sources/${evidence.sourceId}`,
          owned: false,
          why: itemWhy(place, "source"),
          facts: [evidence.url],
        });
      }
      for (const evidence of memory.evidence) {
        links.push({
          from: `memory:${memory.id}`,
          to: `source:${evidence.sourceId}`,
          relation: "cites",
        });
      }
    }
  }
  const drawn = new Set(items.map((item) => item.id));
  for (const definition of definitions) {
    for (const link of definition.links) {
      const to =
        link.relation === "based_on"
          ? `memory:${link.targetId}`
          : `definition:${link.targetId}`;
      links.push({
        from: `definition:${definition.id}`,
        to,
        relation: link.relation,
      });
    }
  }

  let children: MyPlace[] = [];
  if (place.level === "business_unit" && drawPlan(visible).folded) {
    const projects = [...places.values()]
      .filter((one) => one.parentId === placeId)
      .sort(
        (a, b) => Number(b.access === "direct") - Number(a.access === "direct"),
      );
    total += projects.length;
    const shown = projects.slice(0, OPEN_BUDGET);
    const shownCounts = await placeCounts(
      ctx,
      visible,
      shown.map((project) => project.recordId),
    );
    children = shown.map((project) => ({
      ...project,
      counts: shownCounts.get(project.id) ?? emptyCounts(),
      children: 0,
      drawn: false,
    }));
  }
  return {
    place: placeId,
    items,
    children,
    links: links.filter((link) => drawn.has(link.from) && drawn.has(link.to)),
    more: Math.max(0, total - items.length - children.length),
  };
}
