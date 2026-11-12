import { resolveScope, type Scope, type ScopeRef } from "../../access.ts";
import {
  approveDefinitionProposal,
  DEFINITION_KINDS,
  DEFINITION_RELATIONS,
  getDefinition,
  getDefinitionProposal,
  LINK_RULES,
  listDefinitionProposals,
  listDefinitions,
  listScopePrincipals,
  proposeDefinition,
  proposeDefinitionChange,
  proposeDefinitionRetirement,
  rejectDefinitionProposal,
  type Definition,
  type DefinitionContent,
  type DefinitionKind,
  type DefinitionLink,
  type DefinitionProposal,
  type DefinitionRelation,
  type DefinitionVersion,
} from "../../definitions.ts";
import { NotFoundError } from "../../errors.ts";
import { listMemories, MEMORY_STATUSES, type Memory } from "../../knowledge.ts";
import {
  getOrganizationTree,
  type OrganizationTree,
} from "../../organizations.ts";
import { ROLE_RANK, type Role } from "../../roles.ts";
import { diffItems, diffLines, type DiffLine } from "../../text-diff.ts";
import { badge, html, options, recordHead, table, type SafeHtml } from "../html.ts";
import {
  formValue,
  page,
  postForm,
  redirect,
  requireUser,
  type RequestContext,
  type Route,
  type WebResponse,
} from "../kit.ts";
import { KIND_INFO, LEVEL_INFO, RELATION_INFO } from "../labels.ts";
import {
  flagBadges,
  memoryStatusBadge,
  nameOf,
  namesFor,
  notFoundAs,
  rankOf,
  roleBadge,
  routeScope,
  typeLabel,
  type Names,
} from "../views.ts";

type Crumbs = Array<readonly [string, string]>;

interface ScopeView {
  ref: ScopeRef;
  scope: Scope;
  tree: OrganizationTree;
  name: string;
  /** The signed-in person's role at this level, including roles from above. */
  role: Role | null;
  crumbs: Crumbs;
}

/** A level the signed-in person can see, with its name and breadcrumbs. Hidden levels read as missing. */
export async function loadScopeView(
  rc: RequestContext,
  ref: ScopeRef,
): Promise<ScopeView> {
  const user = requireUser(rc);
  const missing = `${LEVEL_INFO[ref.level].label} not found`;
  const scope = await resolveScope(rc.ctx.db, ref);
  const tree = await getOrganizationTree(
    rc.ctx,
    user.id,
    scope.organizationId,
  ).catch(notFoundAs(missing));
  const organization = tree.organization;
  const crumbs: Crumbs = [[organization.name, `/orgs/${organization.id}`]];
  if (ref.level === "organization") {
    return {
      ref,
      scope,
      tree,
      name: organization.name,
      role: tree.role,
      crumbs,
    };
  }
  const unit = tree.businessUnits.find(
    (item) => item.id === scope.businessUnitId,
  );
  if (!unit) throw new NotFoundError(missing);
  crumbs.push([unit.name, `/business-units/${unit.id}`]);
  if (ref.level === "business_unit") {
    return { ref, scope, tree, name: unit.name, role: unit.role, crumbs };
  }
  const project = unit.projects.find((item) => item.id === ref.id);
  if (!project) throw new NotFoundError(missing);
  crumbs.push([project.name, `/projects/${project.id}`]);
  return { ref, scope, tree, name: project.name, role: project.role, crumbs };
}

export function definitionsPath(scope: ScopeRef): string {
  return `/scopes/${scope.level}/${scope.id}/definitions`;
}

export function networkPath(
  organizationId: string,
  options: { focus?: ScopeRef; node?: string } = {},
): string {
  const query = new URLSearchParams();
  if (options.focus)
    query.set("focus", `${options.focus.level}:${options.focus.id}`);
  if (options.node) query.set("node", options.node);
  const text = query.toString();
  return `/orgs/${organizationId}/network${text === "" ? "" : `?${text}`}`;
}

function scopeNames(tree: OrganizationTree): Map<string, string> {
  const names = new Map<string, string>([
    [tree.organization.id, tree.organization.name],
  ]);
  for (const unit of tree.businessUnits) {
    names.set(unit.id, unit.name);
    for (const project of unit.projects) names.set(project.id, project.name);
  }
  return names;
}

function scopeLabel(
  scope: ScopeRef,
  names: ReadonlyMap<string, string>,
): string {
  return `${names.get(scope.id) ?? "Unknown"} (${LEVEL_INFO[scope.level].label.toLowerCase()})`;
}

/** True when a definition at `at` applies at `target`: the same level or one above it. */
function appliesAt(at: ScopeRef, target: Scope): boolean {
  if (at.level === "organization") return at.id === target.organizationId;
  if (at.level === "business_unit") {
    return target.level !== "organization" && target.businessUnitId === at.id;
  }
  return target.level === "project" && target.projectId === at.id;
}

function sameScope(a: ScopeRef, b: ScopeRef): boolean {
  return a.level === b.level && a.id === b.id;
}

export function kindBadge(kind: DefinitionKind): SafeHtml {
  return badge(KIND_INFO[kind].label.toLowerCase(), `kind-${kind}`);
}

export function statusBadge(status: Definition["status"]): SafeHtml {
  return status === "active"
    ? badge("active", "ok")
    : badge("retired", "muted");
}

const PROPOSAL_VARIANT: Readonly<Record<DefinitionProposal["status"], string>> =
  {
    pending: "warn",
    approved: "ok",
    rejected: "danger",
  };

const ACTION_LABEL: Readonly<Record<DefinitionProposal["action"], string>> = {
  create: "new",
  change: "change",
  retire: "retire",
};

function linkValue(link: DefinitionLink): string {
  return `${link.relation}:${link.targetId}`;
}

function formLines(rc: RequestContext, name: string): string[] {
  return (formValue(rc, name) ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function formLinks(rc: RequestContext): DefinitionLink[] {
  return rc.form.getAll("links").map((value) => {
    const [relation = "", targetId = ""] = value.split(":");
    return { relation: relation as DefinitionRelation, targetId };
  });
}

function formContent(rc: RequestContext) {
  const appliesTo = formValue(rc, "appliesTo");
  const runsAs = formValue(rc, "runsAs");
  const ownerId = formValue(rc, "ownerId");
  const changeNote = formValue(rc, "changeNote");
  return {
    name: formValue(rc, "name") ?? "",
    purpose: formValue(rc, "purpose") ?? "",
    responsibilities: formLines(rc, "responsibilities"),
    boundaries: formLines(rc, "boundaries"),
    instructions: formValue(rc, "instructions") ?? "",
    links: formLinks(rc),
    ...(appliesTo === undefined ? {} : { appliesTo }),
    ...(runsAs === undefined ? {} : { runsAs }),
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(changeNote === undefined ? {} : { changeNote }),
  };
}

interface FormChoices {
  owners: Array<{ id: string; displayName: string; role: Role }>;
  agents: Array<{ id: string; displayName: string; role: Role }>;
  definitions: Definition[];
  memories: Memory[];
  scopeNames: ReadonlyMap<string, string>;
}

/** Owners, agent accounts, and link targets someone proposing at this level may choose from. */
async function loadChoices(
  rc: RequestContext,
  view: ScopeView,
  exceptId: string | null,
): Promise<FormChoices> {
  const user = requireUser(rc);
  const [owners, agents, all, memories] = await Promise.all([
    listScopePrincipals(rc.ctx, user.id, view.ref, "human"),
    listScopePrincipals(rc.ctx, user.id, view.ref, "agent"),
    listDefinitions(rc.ctx, user.id, {
      organizationId: view.scope.organizationId,
    }),
    listMemories(rc.ctx, user.id, { scope: view.ref, limit: 200 }),
  ]);
  return {
    owners,
    agents,
    definitions: all.filter(
      (definition) =>
        definition.status === "active" &&
        definition.id !== exceptId &&
        appliesAt(definition.scope, view.scope),
    ),
    memories,
    scopeNames: scopeNames(view.tree),
  };
}

const RELATION_HINT: Readonly<Record<DefinitionRelation, string>> = {
  uses: "Skills it calls on (agents and skills only)",
  follows: "Rules and instructions it must obey",
  hands_off_to: "Agents it passes work to (agents only)",
  based_on: "Approved knowledge its guidance comes from",
};

function linkChoices(
  relation: DefinitionRelation,
  choices: FormChoices,
  selected: ReadonlySet<string>,
): SafeHtml {
  const targets = LINK_RULES[relation].to;
  const items =
    relation === "based_on"
      ? choices.memories.map((memory) => ({
          value: `${relation}:${memory.id}`,
          label: html`<strong>${memory.title}</strong> ${badge(
              typeLabel(memory.type),
              "type",
            )}
            ${notCurrentBadge(memory)}`,
        }))
      : choices.definitions
          .filter((definition) => targets.includes(definition.kind))
          .map((definition) => ({
            value: `${relation}:${definition.id}`,
            label: html`<strong>${definition.name}</strong> ${kindBadge(
                definition.kind,
              )}
              <span class="muted"
                >${scopeLabel(definition.scope, choices.scopeNames)}</span
              >`,
          }));
  return html`<fieldset>
    <legend>
      ${RELATION_INFO[relation].label} — ${RELATION_HINT[relation]}
    </legend>
    ${items.length === 0
      ? html`<p class="empty">Nothing to choose here yet.</p>`
      : items.map(
          (item) =>
            html`<label class="choice">
              <input
                type="checkbox"
                name="links"
                value="${item.value}"
                ${selected.has(item.value) ? html`checked` : ""}
              />
              ${item.label}
            </label>`,
        )}
  </fieldset>`;
}

/** The fields of a definition. A null kind shows a kind picker, for new definitions. */
function contentFields(
  rc: RequestContext,
  kind: DefinitionKind | null,
  values: DefinitionContent | null,
  choices: FormChoices,
  noteLabel: string,
): SafeHtml {
  const user = requireUser(rc);
  const selected = new Set((values?.links ?? []).map(linkValue));
  const relations = DEFINITION_RELATIONS.filter(
    (relation) => kind === null || LINK_RULES[relation].from.includes(kind),
  );
  const info = kind === null ? null : KIND_INFO[kind];
  return html`${kind === null
      ? html`<label
          >Kind
          <select name="kind" required>
            ${options(
              DEFINITION_KINDS.map((item) => ({
                value: item,
                label: `${KIND_INFO[item].label}: ${KIND_INFO[item].meaning}`,
              })),
            )}
          </select></label
        >`
      : ""}
    <label
      >Name
      <input name="name" required maxlength="120" value="${values?.name ?? ""}"
    /></label>
    <label
      >Purpose, in one sentence
      <input
        name="purpose"
        required
        maxlength="300"
        value="${values?.purpose ?? ""}"
    /></label>
    <label
      >${info?.duties ?? "Responsibilities"} (one per line, at least one)
      <textarea name="responsibilities" required>
${(values?.responsibilities ?? []).join("\n")}</textarea
      >
    </label>
    <label
      >${info?.limits ??
      "Limits: what it must not do, is not for, or does not cover"}
      (one per line, optional)
      <textarea name="boundaries">
${(values?.boundaries ?? []).join("\n")}</textarea
      >
    </label>
    <label
      >Applies to (optional), such as "every pull request in checkout-service"
      <input
        name="appliesTo"
        maxlength="300"
        value="${values?.appliesTo ?? ""}"
    /></label>
    <label
      >Instructions (optional): the full guidance text. MemoryNet stores it and
      never runs it.
      <textarea name="instructions" maxlength="20000">
${values?.instructions ?? ""}</textarea
      >
    </label>
    ${kind === null || kind === "agent"
      ? html`<label
          >Runs as (agents only): the agent account whose roles limit it
          <select name="runsAs">
            <option value="">No agent account</option>
            ${values?.runsAs &&
            !choices.agents.some((agent) => agent.id === values.runsAs)
              ? html`<option value="${values.runsAs}" selected>
                  Current agent account (it no longer has a role here)
                </option>`
              : ""}
            ${options(
              choices.agents.map((agent) => ({
                value: agent.id,
                label: `${agent.displayName} (${agent.role})`,
              })),
              values?.runsAs ?? undefined,
            )}
          </select></label
        >`
      : ""}
    <label
      >Owner, the person accountable for keeping it correct
      <select
        name="ownerId"
        ${user.kind === "agent" || values !== null ? html`required` : ""}
      >
        ${user.kind === "human" && values === null
          ? html`<option value="">Me</option>`
          : ""}
        ${values !== null &&
        !choices.owners.some((owner) => owner.id === values.ownerId)
          ? html`<option value="" selected>
              Choose a new owner: the current one no longer has a role here
            </option>`
          : ""}
        ${options(
          choices.owners.map((owner) => ({
            value: owner.id,
            label: `${owner.displayName} (${owner.role})`,
          })),
          values?.ownerId,
        )}
      </select></label
    >
    ${relations.map((relation) => linkChoices(relation, choices, selected))}
    <label>${noteLabel} <input name="changeNote" maxlength="500" /></label>`;
}

function itemList(items: readonly string[], empty: string): SafeHtml {
  if (items.length === 0) return html`<p class="empty">${empty}</p>`;
  return html`<ul>
    ${items.map((item) => html`<li>${item}</li>`)}
  </ul>`;
}

/** What a definition says, with the headings its kind uses. */
function contentView(
  kind: DefinitionKind,
  content: DefinitionContent,
): SafeHtml {
  const info = KIND_INFO[kind];
  return html`<section>
      <h2>Purpose</h2>
      <p>${content.purpose}</p>
      <h3>${info.duties}</h3>
      ${itemList(content.responsibilities, "None listed.")}
      <h3>${info.limits}</h3>
      ${itemList(content.boundaries, "None listed.")}
      <h3>Applies to</h3>
      <p>
        ${content.appliesTo ??
        html`<span class="muted">Everywhere at this level.</span>`}
      </p>
    </section>
    <section>
      <h2>Instructions</h2>
      ${content.instructions === ""
        ? html`<p class="empty">No further instructions.</p>`
        : html`<p class="content">${content.instructions}</p>`}
    </section>`;
}

interface LinkNames {
  definitions: ReadonlyMap<string, Definition>;
  memories: ReadonlyMap<string, Memory>;
}

function notCurrentBadge(memory: Memory): SafeHtml | "" {
  return memory.status === "approved" ? "" : memoryStatusBadge(memory.status);
}

function linkTarget(link: DefinitionLink, targets: LinkNames): SafeHtml {
  if (link.relation === "based_on") {
    const memory = targets.memories.get(link.targetId);
    return memory
      ? html`<a href="/memories/${memory.id}">${memory.title}</a> ${badge(
            typeLabel(memory.type),
            "type",
          )}
          ${notCurrentBadge(memory)}`
      : html`<span class="muted">Unknown memory</span>`;
  }
  const definition = targets.definitions.get(link.targetId);
  return definition
    ? html`<a href="/definitions/${definition.id}">${definition.name}</a>
        ${kindBadge(definition.kind)}
        ${definition.status === "retired" ? statusBadge("retired") : ""}`
    : html`<span class="muted">Unknown definition</span>`;
}

function linksView(
  links: readonly DefinitionLink[],
  targets: LinkNames,
): SafeHtml {
  if (links.length === 0) return html`<p class="empty">No links.</p>`;
  return html`<dl class="facts">
    ${DEFINITION_RELATIONS.filter((relation) =>
      links.some((link) => link.relation === relation),
    ).map(
      (relation) =>
        html`<dt>${RELATION_INFO[relation].label}</dt>
          <dd>
            <ul class="plain">
              ${links
                .filter((link) => link.relation === relation)
                .map((link) => html`<li>${linkTarget(link, targets)}</li>`)}
            </ul>
          </dd>`,
    )}
  </dl>`;
}

function definitionRows(
  definitions: readonly Definition[],
  names: Names,
  scopeNamesById: ReadonlyMap<string, string>,
): SafeHtml[][] {
  return definitions.map((definition) => [
    html`<a href="/definitions/${definition.id}">${definition.name}</a>
      ${flagBadges(definition.flags)}`,
    kindBadge(definition.kind),
    statusBadge(definition.status),
    html`${scopeLabel(definition.scope, scopeNamesById)}`,
    html`${nameOf(names, definition.ownerId)}`,
    html`${definition.revision}`,
  ]);
}

const DEFINITION_HEADERS = [
  "Name",
  "Kind",
  "Status",
  "Level",
  "Owner",
  "Version",
];

function proposalRows(
  proposals: readonly DefinitionProposal[],
  names: Names,
): SafeHtml[][] {
  return proposals.map((proposal) => [
    html`<a href="/definition-proposals/${proposal.id}">${proposal.name}</a>
      ${flagBadges(proposal.flags)}`,
    kindBadge(proposal.kind),
    badge(ACTION_LABEL[proposal.action], "neutral"),
    badge(proposal.status, PROPOSAL_VARIANT[proposal.status]),
    html`${nameOf(names, proposal.proposedBy)}`,
    html`${proposal.proposedAt}`,
  ]);
}

const PROPOSAL_HEADERS = [
  "Name",
  "Kind",
  "Action",
  "Status",
  "Proposed by",
  "Proposed",
];

/** A short section for organization, business unit, and project pages. */
export async function definitionsSummary(
  rc: RequestContext,
  scope: ScopeRef,
  organizationId: string,
): Promise<SafeHtml> {
  const user = requireUser(rc);
  const resolved = await resolveScope(rc.ctx.db, scope);
  const all = await listDefinitions(rc.ctx, user.id, { organizationId });
  const active = all.filter((definition) => definition.status === "active");
  const here = active.filter((definition) =>
    sameScope(definition.scope, scope),
  ).length;
  const above = active.filter(
    (definition) =>
      !sameScope(definition.scope, scope) &&
      appliesAt(definition.scope, resolved),
  ).length;
  return html`<section>
    <h2>Agents, skills, instructions, and rules</h2>
    <p>
      ${here} active
      here${scope.level === "organization"
        ? ""
        : html`, ${above} from above that apply here too`}.
      Each one says what it is responsible for, is owned by a person, and
      changes only through review.
    </p>
    <p class="link-row">
      <a href="${definitionsPath(scope)}">See and propose definitions</a>
      <a href="${networkPath(organizationId, { focus: scope })}"
        >Open the network</a
      >
    </p>
  </section>`;
}

async function scopeDefinitionsPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const view = await loadScopeView(rc, routeScope(rc));
  const all = await listDefinitions(rc.ctx, user.id, {
    organizationId: view.scope.organizationId,
  });
  const here = all.filter((definition) =>
    sameScope(definition.scope, view.ref),
  );
  const above = all.filter(
    (definition) =>
      !sameScope(definition.scope, view.ref) &&
      appliesAt(definition.scope, view.scope),
  );
  const projectUnit = new Map(
    view.tree.businessUnits.flatMap((unit) =>
      unit.projects.map((item) => [item.id, unit.id] as const),
    ),
  );
  const inside = all.filter((definition) => {
    if (
      sameScope(definition.scope, view.ref) ||
      appliesAt(definition.scope, view.scope)
    )
      return false;
    if (view.ref.level === "organization") return true;
    if (view.ref.level === "business_unit") {
      return (
        definition.scope.level === "project" &&
        projectUnit.get(definition.scope.id) === view.ref.id
      );
    }
    return false;
  });
  const rank = rankOf(view.role);
  const canPropose = rank >= ROLE_RANK.contributor;
  const pending =
    user.kind === "human" && canPropose
      ? (
          await listDefinitionProposals(rc.ctx, user.id, {
            organizationId: view.scope.organizationId,
            status: "pending",
          })
        ).filter((proposal) => sameScope(proposal.scope, view.ref))
      : null;
  const names = await namesFor(rc, [
    ...all.map((definition) => definition.ownerId),
    ...(pending ?? []).map((proposal) => proposal.proposedBy),
  ]);
  const scopeNamesById = scopeNames(view.tree);
  const choices = canPropose ? await loadChoices(rc, view, null) : null;
  return page(rc, {
    title: `Agents, skills, instructions, and rules`,
    crumbs: [...view.crumbs, ["Definitions", definitionsPath(view.ref)]],
    body: html`<p>
        ${LEVEL_INFO[view.ref.level].label}: <strong>${view.name}</strong> ·
        your role here: ${roleBadge(view.role)} ·
        <a href="${networkPath(view.scope.organizationId, { focus: view.ref })}"
          >Open the network</a
        >
      </p>
      <p class="hint">
        A definition describes a job, never runs it.
        ${LEVEL_INFO[view.ref.level].meaning}
      </p>
      <section>
        <h2>Defined here</h2>
        ${table(
          DEFINITION_HEADERS,
          definitionRows(here, names, scopeNamesById),
          "Nothing is defined at this level yet.",
        )}
      </section>
      ${view.ref.level === "organization"
        ? ""
        : html`<section>
            <h2>From above, applying here too</h2>
            ${table(
              DEFINITION_HEADERS,
              definitionRows(above, names, scopeNamesById),
              "Nothing from above applies here.",
            )}
          </section>`}
      ${view.ref.level === "project"
        ? ""
        : html`<section>
            <h2>
              Defined inside this
              ${LEVEL_INFO[view.ref.level].label.toLowerCase()}
            </h2>
            <p class="hint">Only the parts you have a role in are listed.</p>
            ${table(
              DEFINITION_HEADERS,
              definitionRows(inside, names, scopeNamesById),
              "Nothing you can see is defined inside.",
            )}
          </section>`}
      ${pending === null
        ? ""
        : html`<section>
            <h2>Waiting for review here</h2>
            ${table(
              PROPOSAL_HEADERS,
              proposalRows(pending, names),
              "Nothing is waiting for review.",
            )}
          </section>`}
      ${choices
        ? html`<section>
            <h2>Describe a new agent, skill, instruction, or rule</h2>
            <p class="hint">
              It becomes guidance only after a different reviewer approves it.
              Text that looks like a secret is refused.
            </p>
            ${postForm(
              rc,
              definitionsPath(view.ref),
              contentFields(
                rc,
                null,
                null,
                choices,
                "Note for the reviewer (optional)",
              ),
              "Propose",
              "stacked",
            )}
          </section>`
        : html`<p class="hint">
            Contributors and above at this level can propose definitions.
          </p>`}`,
  });
}

/** Plain text of the current version, to paste into an AI tool's instructions by hand. */
function plainText(
  definition: Definition,
  targets: LinkNames,
  names: Names,
): string {
  const info = KIND_INFO[definition.kind];
  const list = (items: readonly string[]) =>
    items.map((item) => `- ${item}`).join("\n");
  const lines = [
    `${info.label}: ${definition.name}`,
    `Purpose: ${definition.purpose}`,
    "",
    `${info.duties}:`,
    list(definition.responsibilities),
  ];
  if (definition.boundaries.length > 0)
    lines.push("", `${info.limits}:`, list(definition.boundaries));
  if (definition.appliesTo !== null)
    lines.push("", `Applies to: ${definition.appliesTo}`);
  if (definition.instructions !== "")
    lines.push("", "Instructions:", definition.instructions);
  for (const relation of DEFINITION_RELATIONS) {
    const named = definition.links
      .filter((link) => link.relation === relation)
      .map((link) => {
        if (relation !== "based_on") {
          return `${targets.definitions.get(link.targetId)?.name ?? "Unknown"} (definition ${link.targetId})`;
        }
        const memory = targets.memories.get(link.targetId);
        const status =
          memory && memory.status !== "approved"
            ? `, ${memory.status === "suspended" ? "suspended" : "replaced"}`
            : "";
        return `${memory?.title ?? "Unknown"} (memory ${link.targetId}${status})`;
      });
    if (named.length > 0)
      lines.push("", `${RELATION_INFO[relation].label}:`, list(named));
  }
  lines.push(
    "",
    `Source: MemoryNet definition ${definition.id}, version ${definition.revision}, approved by ${nameOf(names, definition.approvedBy)} on ${definition.approvedAt.toISOString().slice(0, 10)}. Owner: ${nameOf(names, definition.ownerId)}.`,
  );
  return lines.join("\n");
}

async function definitionPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const data = await getDefinition(rc.ctx, user.id, rc.params.id ?? "");
  const { definition } = data;
  const view = await loadScopeView(rc, definition.scope);
  const names = await namesFor(rc, [
    definition.ownerId,
    definition.proposedBy,
    definition.approvedBy,
    definition.runsAs,
    ...data.history.map((version) => version.approvedBy),
    ...(data.pending ?? []).map((proposal) => proposal.proposedBy),
  ]);
  const targets: LinkNames = {
    definitions: new Map(data.linkedDefinitions.map((item) => [item.id, item])),
    memories: new Map(data.linkedMemories.map((item) => [item.id, item])),
  };
  const canPropose = definition.callerRank >= ROLE_RANK.contributor;
  const loaded = canPropose ? await loadChoices(rc, view, definition.id) : null;
  // A change may keep links to knowledge that is no longer current, so the form lists them too.
  const choices = loaded && {
    ...loaded,
    memories: [
      ...loaded.memories,
      ...data.linkedMemories.filter((memory) => memory.status !== "approved"),
    ],
  };
  const base = html`<input
    type="hidden"
    name="baseRevision"
    value="${definition.revision}"
  />`;
  const info = KIND_INFO[definition.kind];
  return page(rc, {
    title: definition.name,
    crumbs: [...view.crumbs, ["Definitions", definitionsPath(view.ref)]],
    body: html`${recordHead({
        kind: kindBadge(definition.kind),
        title: definition.name,
        status: html`${statusBadge(definition.status)} ${flagBadges(definition.flags)}`,
        meta: html`Version ${definition.revision} · ${LEVEL_INFO[view.ref.level].label}: ${view.name} · Owner ${nameOf(names, definition.ownerId)}`,
        actions: html`<a class="key" href="${networkPath(definition.organizationId, { node: `definition:${definition.id}` })}">Show in the network</a> <a class="key" href="/definitions/${definition.id}/prompt">See its prompt anatomy</a>`,
      })}
      <p class="hint">${info.meaning}</p>
      ${definition.status === "retired"
        ? html`<p class="warning">
            Retired: kept for its history. Nothing should rely on it now.
            Propose a change to bring it back.
          </p>`
        : ""}
      ${contentView(definition.kind, definition)}
      <section>
        <h2>Connections</h2>
        ${linksView(definition.links, targets)}
        <h3>Used by</h3>
        ${data.usedBy.length === 0
          ? html`<p class="empty">Nothing you can see links to it.</p>`
          : html`<ul class="plain">
              ${data.usedBy.map(
                (use) =>
                  html`<li>
                    <a href="/definitions/${use.definition.id}"
                      >${use.definition.name}</a
                    >
                    ${kindBadge(use.definition.kind)}
                    ${RELATION_INFO[use.relation].label} it
                  </li>`,
              )}
            </ul>`}
      </section>
      <section>
        <h2>Record</h2>
        <dl class="facts">
          <dt>Definition ID</dt>
          <dd><code>${definition.id}</code> (never changes)</dd>
          <dt>Level</dt>
          <dd>${LEVEL_INFO[view.ref.level].label}: ${view.name}</dd>
          <dt>Owner</dt>
          <dd>${nameOf(names, definition.ownerId)}</dd>
          ${definition.kind === "agent"
            ? html`<dt>Runs as</dt>
                <dd>
                  ${definition.runsAs === null
                    ? html`<span class="muted">No agent account</span>`
                    : html`${nameOf(names, definition.runsAs)}
                        <small
                          >Agent accounts can only read and propose, never
                          approve.</small
                        >`}
                </dd>`
            : ""}
          <dt>This version</dt>
          <dd>
            proposed by ${nameOf(names, definition.proposedBy)}, approved by
            ${nameOf(names, definition.approvedBy)} on ${definition.approvedAt}
            ${definition.changeNote === null
              ? ""
              : html`<br />Note: ${definition.changeNote}`}
          </dd>
        </dl>
      </section>
      <section>
        <h2>History</h2>
        ${table(
          ["Version", "Status", "Note", "Approved by", "Approved"],
          data.history.map((version) => [
            html`<a
                href="/definitions/${definition.id}/versions/${version.revision}"
                >version ${version.revision}</a
              >
              ${version.revision === definition.revision
                ? badge("current", "ok")
                : ""}`,
            statusBadge(version.status),
            html`${version.changeNote ?? ""}`,
            html`${nameOf(names, version.approvedBy)}`,
            html`${version.approvedAt}`,
          ]),
          "No versions.",
        )}
      </section>
      ${data.pending === null
        ? ""
        : html`<section>
            <h2>Waiting for review</h2>
            ${table(
              PROPOSAL_HEADERS,
              proposalRows(data.pending, names),
              "No changes are waiting.",
            )}
          </section>`}
      <section>
        <h2>Use it in an AI tool</h2>
        <p class="hint">
          Plain text of this version with its ID, to paste into your tool's
          instruction file by hand. It is a copy: MemoryNet stays the source of
          truth. To see it built into a prompt block by block, with estimated
          size and checks, open its
          <a href="/definitions/${definition.id}/prompt">prompt anatomy</a>.
        </p>
        <textarea
          class="copy"
          readonly
          rows="12"
          aria-label="Plain text of this definition"
        >
${plainText(definition, targets, names)}</textarea
        >
      </section>
      ${choices
        ? html`<section id="propose-change">
              <h2>Propose a change</h2>
              <p class="hint">
                Written against version ${definition.revision}. If someone
                else's change is approved first, yours is refused rather than
                overwriting it.
              </p>
              ${postForm(
                rc,
                `/definitions/${definition.id}/changes`,
                html`${base}
                ${contentFields(
                  rc,
                  definition.kind,
                  definition,
                  choices,
                  "What changed and why (optional)",
                )}`,
                definition.status === "retired"
                  ? "Propose bringing it back"
                  : "Propose change",
                "stacked",
              )}
            </section>
            ${definition.status === "active"
              ? html`<section>
                  <h2>Propose retiring it</h2>
                  ${postForm(
                    rc,
                    `/definitions/${definition.id}/retire`,
                    html`${base}
                      <label
                        >Reason <input name="reason" required maxlength="500"
                      /></label>`,
                    "Propose retiring",
                    "stacked",
                  )}
                </section>`
              : ""}`
        : html`<p class="hint">
            Contributors and above at this definition's level can propose
            changes.
          </p>`}`,
  });
}

async function versionPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const data = await getDefinition(rc.ctx, user.id, rc.params.id ?? "");
  const revision = Number(rc.params.revision);
  const version = data.history.find((item) => item.revision === revision);
  if (!version) throw new NotFoundError("Version not found");
  const { definition } = data;
  const view = await loadScopeView(rc, definition.scope);
  const names = await namesFor(rc, [
    version.approvedBy,
    version.proposedBy,
    version.ownerId,
  ]);
  const canPropose = definition.callerRank >= ROLE_RANK.contributor;
  const isCurrent = version.revision === definition.revision;
  const choices =
    canPropose && !isCurrent
      ? await loadChoices(rc, view, definition.id)
      : null;
  const all = await listDefinitions(rc.ctx, user.id, {
    organizationId: definition.organizationId,
  });
  const memories = (
    await Promise.all(
      MEMORY_STATUSES.map((status) =>
        listMemories(rc.ctx, user.id, { scope: view.ref, status, limit: 200 }),
      ),
    )
  ).flat();
  const targets: LinkNames = {
    definitions: new Map(all.map((item) => [item.id, item])),
    memories: new Map(memories.map((item) => [item.id, item])),
  };
  return page(rc, {
    title: `${version.name}, version ${version.revision}`,
    crumbs: [
      ...view.crumbs,
      ["Definitions", definitionsPath(view.ref)],
      [definition.name, `/definitions/${definition.id}`],
    ],
    body: html`<p>
        ${kindBadge(definition.kind)} ${statusBadge(version.status)}
        ${isCurrent
          ? badge("current", "ok")
          : badge(`current is version ${definition.revision}`, "muted")}
      </p>
      <p class="hint">
        Approved by ${nameOf(names, version.approvedBy)} on
        ${version.approvedAt}; owner ${nameOf(names, version.ownerId)}.
        ${version.changeNote === null ? "" : html`Note: ${version.changeNote}`}
      </p>
      ${contentView(definition.kind, version)}
      <section>
        <h2>Connections in this version</h2>
        ${linksView(version.links, targets)}
      </section>
      ${choices
        ? html`<section>
            <h2>Restore this version</h2>
            <p class="hint">
              Restoring proposes this content as a new version. A different
              reviewer must approve it.
            </p>
            ${postForm(
              rc,
              `/definitions/${definition.id}/changes`,
              html`<input
                  type="hidden"
                  name="baseRevision"
                  value="${definition.revision}"
                />
                ${contentFields(
                  rc,
                  definition.kind,
                  { ...version, links: version.links },
                  choices,
                  "Note for the reviewer",
                )}`,
              "Propose restoring this version",
              "stacked",
            )}
          </section>`
        : ""}`,
  });
}

function diffView(lines: readonly DiffLine[]): SafeHtml {
  return html`<pre class="diff">
${lines.map(
      (line) =>
        html`<span class="diff-${line.kind}"
          >${line.kind === "added"
            ? "+ "
            : line.kind === "removed"
              ? "− "
              : "  "}${line.text}</span
        >`,
    )}</pre
  >`;
}

function changeRows(
  kind: DefinitionKind,
  before: DefinitionVersion,
  after: DefinitionContent & { status: Definition["status"] },
  names: Names,
  targets: LinkNames,
): { changed: SafeHtml[][]; unchanged: string[] } {
  const info = KIND_INFO[kind];
  const linkLabel = (link: DefinitionLink) => {
    const target =
      link.relation === "based_on"
        ? targets.memories.get(link.targetId)?.title
        : targets.definitions.get(link.targetId)?.name;
    return `${RELATION_INFO[link.relation].label} ${target ?? "Unknown"}`;
  };
  const fields: Array<[string, DiffLine[]]> = [
    ["Status", diffItems([before.status], [after.status])],
    ["Name", diffItems([before.name], [after.name])],
    ["Purpose", diffItems([before.purpose], [after.purpose])],
    [info.duties, diffItems(before.responsibilities, after.responsibilities)],
    [info.limits, diffItems(before.boundaries, after.boundaries)],
    [
      "Applies to",
      diffItems(
        before.appliesTo === null ? [] : [before.appliesTo],
        after.appliesTo === null ? [] : [after.appliesTo],
      ),
    ],
    ["Instructions", diffLines(before.instructions, after.instructions)],
    [
      "Owner",
      diffItems(
        [nameOf(names, before.ownerId)],
        [nameOf(names, after.ownerId)],
      ),
    ],
    [
      "Runs as",
      diffItems(
        before.runsAs === null ? [] : [nameOf(names, before.runsAs)],
        after.runsAs === null ? [] : [nameOf(names, after.runsAs)],
      ),
    ],
    [
      "Links",
      diffItems(
        before.links.map(linkLabel).sort(),
        after.links.map(linkLabel).sort(),
      ),
    ],
  ];
  const changed = fields.filter(([, lines]) =>
    lines.some((line) => line.kind !== "same"),
  );
  return {
    changed: changed.map(([label, lines]) => [html`${label}`, diffView(lines)]),
    unchanged: fields
      .filter(([, lines]) => lines.every((line) => line.kind === "same"))
      .map(([label]) => label),
  };
}

async function proposalPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const data = await getDefinitionProposal(rc.ctx, user.id, rc.params.id ?? "");
  const { proposal, base, current } = data;
  const view = await loadScopeView(rc, proposal.scope);
  const names = await namesFor(rc, [
    proposal.ownerId,
    proposal.proposedBy,
    proposal.reviewedBy,
    proposal.runsAs,
    base?.ownerId ?? null,
    base?.runsAs ?? null,
  ]);
  const targets: LinkNames = {
    definitions: new Map(data.linkedDefinitions.map((item) => [item.id, item])),
    memories: new Map(data.linkedMemories.map((item) => [item.id, item])),
  };
  const pending = proposal.status === "pending";
  const stale =
    pending &&
    current !== null &&
    proposal.baseRevision !== null &&
    current.revision !== proposal.baseRevision;
  const isReviewer = proposal.callerRank >= ROLE_RANK.reviewer;
  const own = proposal.proposedBy === user.id;
  const revision = html`<input
    type="hidden"
    name="expectedRevision"
    value="${proposal.revision}"
  />`;
  const after = {
    ...proposal,
    status:
      proposal.action === "retire" ? ("retired" as const) : ("active" as const),
  };
  const changes =
    base === null
      ? null
      : changeRows(proposal.kind, base, after, names, targets);
  const review =
    pending && isReviewer && !own
      ? html`<section>
          <h2>Review</h2>
          <p class="hint">
            You are reviewing proposal version ${proposal.revision}. If it
            changes before you submit, your review is refused.
          </p>
          ${postForm(
            rc,
            `/definition-proposals/${proposal.id}/approve`,
            html`${revision}
              <label
                >Reason (optional) <input name="reason" maxlength="500"
              /></label>`,
            "Approve",
            "stacked",
          )}
          ${postForm(
            rc,
            `/definition-proposals/${proposal.id}/reject`,
            html`${revision}
              <label
                >Reason <input name="reason" required maxlength="500"
              /></label>`,
            "Reject",
            "stacked",
          )}
        </section>`
      : pending
        ? html`<p class="hint">
            ${own
              ? "You proposed this, so a different reviewer must decide."
              : "A reviewer at this level decides on this proposal."}
          </p>`
        : "";
  return page(rc, {
    title: proposal.name,
    crumbs: [
      ...view.crumbs,
      ["Definitions", definitionsPath(view.ref)],
      ["Proposal", `/definition-proposals/${proposal.id}`],
    ],
    body: html`${recordHead({
        kind: kindBadge(proposal.kind),
        title: proposal.name,
        status: html`${badge(proposal.status, PROPOSAL_VARIANT[proposal.status])} ${badge(ACTION_LABEL[proposal.action], "neutral")} ${flagBadges(proposal.flags)}`,
        meta: html`Proposal version ${proposal.revision} · ${LEVEL_INFO[view.ref.level].label}: ${view.name} · Owner ${nameOf(names, proposal.ownerId)}`,
      })}
      <p class="hint">
        A proposal is not guidance until a different reviewer approves it.
      </p>
      ${stale
        ? html`<p class="error" role="alert">
            The definition is now at version ${current?.revision}, but this
            proposal was written against version ${proposal.baseRevision}.
            Approving it is refused; reject it and propose the change again from
            the current version.
          </p>`
        : ""}
      ${proposal.changeNote === null
        ? ""
        : html`<p>
            <strong
              >${proposal.action === "retire" ? "Reason" : "Note"}:</strong
            >
            ${proposal.changeNote}
          </p>`}
      ${changes === null
        ? html`${contentView(proposal.kind, proposal)}
            <section>
              <h2>Connections</h2>
              ${linksView(proposal.links, targets)}
            </section>`
        : html`<section>
            <h2>What changes from version ${proposal.baseRevision}</h2>
            ${table(["Field", "Change"], changes.changed, "Nothing changes.")}
            ${changes.unchanged.length > 0
              ? html`<p class="hint">
                  Unchanged: ${changes.unchanged.join(", ")}.
                </p>`
              : ""}
          </section>`}
      <section>
        <h2>Record</h2>
        <dl class="facts">
          <dt>Proposal ID</dt>
          <dd><code>${proposal.id}</code></dd>
          <dt>Level</dt>
          <dd>${LEVEL_INFO[view.ref.level].label}: ${view.name}</dd>
          <dt>Owner once approved</dt>
          <dd>${nameOf(names, proposal.ownerId)}</dd>
          <dt>Proposed by</dt>
          <dd>
            ${nameOf(names, proposal.proposedBy)} on ${proposal.proposedAt}
          </dd>
          <dt>Reviewed by</dt>
          <dd>
            ${proposal.reviewedBy === null
              ? html`<span class="muted">not reviewed yet</span>`
              : html`${nameOf(names, proposal.reviewedBy)} on
                ${proposal.reviewedAt}`}
          </dd>
          ${proposal.reviewReason === null
            ? ""
            : html`<dt>Review reason</dt>
                <dd>${proposal.reviewReason}</dd>`}
          ${proposal.definitionId === null
            ? ""
            : html`<dt>Definition</dt>
                <dd>
                  <a href="/definitions/${proposal.definitionId}"
                    >${current?.name ?? "definition"}</a
                  >
                  ${proposal.approvedRevision === null
                    ? ""
                    : html`, became version ${proposal.approvedRevision}`}
                </dd>`}
        </dl>
      </section>
      ${review}`,
  });
}

async function proposeAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const scope = routeScope(rc);
  const proposal = await proposeDefinition(rc.ctx, user.id, {
    scope,
    kind: (formValue(rc, "kind") ?? "") as DefinitionKind,
    ...formContent(rc),
  });
  return user.kind === "agent"
    ? redirect(definitionsPath(scope), "definition-proposed-by-agent")
    : redirect(`/definition-proposals/${proposal.id}`, "definition-proposed");
}

function baseRevision(rc: RequestContext): number {
  return Number(formValue(rc, "baseRevision") ?? "");
}

async function changeAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const definitionId = rc.params.id ?? "";
  await proposeDefinitionChange(rc.ctx, user.id, {
    definitionId,
    baseRevision: baseRevision(rc),
    ...formContent(rc),
  });
  return redirect(
    `/definitions/${definitionId}`,
    user.kind === "agent"
      ? "definition-proposed-by-agent"
      : "definition-change-proposed",
  );
}

async function retireAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const definitionId = rc.params.id ?? "";
  await proposeDefinitionRetirement(rc.ctx, user.id, {
    definitionId,
    baseRevision: baseRevision(rc),
    reason: formValue(rc, "reason") ?? "",
  });
  return redirect(
    `/definitions/${definitionId}`,
    user.kind === "agent"
      ? "definition-proposed-by-agent"
      : "definition-change-proposed",
  );
}

function expectedRevision(rc: RequestContext): number {
  return Number(formValue(rc, "expectedRevision") ?? "");
}

async function approveAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const reason = formValue(rc, "reason");
  const definition = await approveDefinitionProposal(rc.ctx, user.id, {
    proposalId: rc.params.id ?? "",
    expectedRevision: expectedRevision(rc),
    ...(reason === undefined ? {} : { reason }),
  });
  return redirect(`/definitions/${definition.id}`, "definition-approved");
}

async function rejectAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const proposal = await rejectDefinitionProposal(rc.ctx, user.id, {
    proposalId: rc.params.id ?? "",
    expectedRevision: expectedRevision(rc),
    reason: formValue(rc, "reason") ?? "",
  });
  return redirect(
    `/definition-proposals/${proposal.id}`,
    "definition-rejected",
  );
}

const ID = "(?<id>[^/]+)";
const LEVEL = "(?<level>organization|business_unit|project)";

export const definitionRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: new RegExp(`^/scopes/${LEVEL}/${ID}/definitions$`),
    access: "user",
    handle: scopeDefinitionsPage,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/scopes/${LEVEL}/${ID}/definitions$`),
    access: "user",
    handle: proposeAction,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/definitions/${ID}$`),
    access: "user",
    handle: definitionPage,
  },
  {
    method: "GET",
    pattern: new RegExp(
      `^/definitions/${ID}/versions/(?<revision>[1-9][0-9]{0,8})$`,
    ),
    access: "user",
    handle: versionPage,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/definitions/${ID}/changes$`),
    access: "user",
    handle: changeAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/definitions/${ID}/retire$`),
    access: "user",
    handle: retireAction,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/definition-proposals/${ID}$`),
    access: "user",
    handle: proposalPage,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/definition-proposals/${ID}/approve$`),
    access: "user",
    handle: approveAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/definition-proposals/${ID}/reject$`),
    access: "user",
    handle: rejectAction,
  },
];
