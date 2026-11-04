import { resolveScope, type ScopeRef } from "../../access.ts";
import { NotFoundError } from "../../errors.ts";
import { listMemories, listReviewQueue, listSources } from "../../knowledge.ts";
import { listWork } from "../../work.ts";
import {
  assignRole,
  listOwnRoles,
  listPrincipals,
  listRoleAssignments,
  removeFromOrganization,
  revokeRole,
  type OwnRole,
} from "../../members.ts";
import {
  createBusinessUnit,
  createOrganization,
  createProject,
  getOrganizationTree,
  listOrganizations,
} from "../../organizations.ts";
import {
  connectRepository,
  disconnectRepository,
  listRepositoryConnections,
  type RepositoryConnection,
} from "../../repositories.ts";
import {
  ROLE_RANK,
  ROLES,
  roleNeededToManage,
  type Role,
} from "../../roles.ts";
import { requireId } from "../../validation.ts";
import { badge, html, ledgerRow, options, recordHead, scopeTabs, statStrip, table, type SafeHtml } from "../html.ts";
import {
  formValue,
  interfaceIcon,
  page,
  postForm,
  redirect,
  requireUser,
  type RequestContext,
  type Route,
  type WebResponse,
} from "../kit.ts";
import {
  loadProject,
  notFoundAs,
  projectCrumbs,
  rankOf,
  REASON_INPUT,
  roleBadge,
  routeScope,
  scopePath,
} from "../views.ts";
import { definitionsSummary } from "./definitions.ts";
import { brainSection } from "./brain.ts";
import { analyzeBrainHealth, listBrainActivity } from "../../brain.ts";
import { integrityLink, policySection } from "./governance.ts";
import {
  exportForm,
  memoriesSection,
  proposalsSection,
  proposeSection,
  recordSourceSection,
  sourcesSection,
} from "./knowledge.ts";
import { searchSection } from "./search.ts";
import { LEVEL_LABEL, signInPicker } from "./sign-in.ts";

function hiddenPrincipal(principalId: string): SafeHtml {
  return html`<input
    type="hidden"
    name="principalId"
    value="${principalId}"
  />`;
}

async function membersSection(
  rc: RequestContext,
  scope: ScopeRef,
  callerRole: Role | null,
): Promise<SafeHtml> {
  const user = requireUser(rc);
  const callerRank = rankOf(callerRole);
  if (user.kind !== "human" || callerRank < ROLE_RANK.administrator) {
    return html``;
  }
  const members = await listRoleAssignments(rc.ctx, user.id, scope);
  const principals = await listPrincipals(rc.ctx, user.id);
  const assignable = ROLES.filter(
    (role) =>
      callerRank >= ROLE_RANK.owner ||
      ROLE_RANK[role] < ROLE_RANK.administrator,
  ).map((role) => ({ value: role, label: role }));
  const base = `/scopes/${scope.level}/${scope.id}/roles`;
  const rows = members.map((member) => [
    html`${member.principalName}
    ${member.principalKind === "agent" ? badge("agent", "agent") : ""}`,
    roleBadge(member.role),
    html`${member.grantedAt}`,
    member.principalId === user.id
      ? html`<span class="muted">This is you</span>`
      : callerRank < ROLE_RANK[roleNeededToManage(member.role)]
        ? html`<span class="muted"
            >Only an ${roleNeededToManage(member.role)} can change this
            role</span
          >`
        : html`${postForm(
            rc,
            base,
            html`${hiddenPrincipal(member.principalId)}
              <label
                >Change to
                <select name="role">
                  ${options(assignable, member.role)}
                </select></label
              >`,
            "Save",
          )}
          ${postForm(
            rc,
            `${base}/revoke`,
            html`${hiddenPrincipal(member.principalId)} ${REASON_INPUT}`,
            "Remove role",
          )}
          ${scope.level === "organization"
            ? postForm(
                rc,
                `/orgs/${scope.id}/remove-member`,
                html`${hiddenPrincipal(member.principalId)} ${REASON_INPUT}`,
                "Remove from organization",
              )
            : ""}`,
  ]);
  return html`<section>
    <h2>Members at this level</h2>
    <p class="hint">
      A role given here also covers everything inside. Roles inherited from
      above are listed where they were given.
    </p>
    ${table(
      ["Name", "Role", "Given", "Change"],
      rows,
      "No roles are given at this level.",
    )}
    <h3>Give someone a role here</h3>
    ${postForm(
      rc,
      base,
      html`<label
          >Person or agent
          <select name="principalId" required>
            ${options(
              principals.map((principal) => ({
                value: principal.id,
                label:
                  principal.kind === "agent"
                    ? `${principal.displayName} (agent)`
                    : principal.displayName,
              })),
            )}
          </select></label
        >
        <label
          >Role
          <select name="role">
            ${options(assignable)}
          </select></label
        >
        <label
          >Reason (optional) <input name="reason" maxlength="500"
        /></label>`,
      "Give role",
      "stacked",
    )}
  </section>`;
}

function ownRoleSection(
  rc: RequestContext,
  scope: ScopeRef,
  own: readonly OwnRole[],
): SafeHtml {
  const user = requireUser(rc);
  const mine = own.find(
    (role) => role.scope.level === scope.level && role.scope.id === scope.id,
  );
  if (!mine || user.kind !== "human") return html``;
  return html`<section>
    <h2>Your role at this level</h2>
    <p>You were given ${roleBadge(mine.role)} here on ${mine.grantedAt}.</p>
    ${postForm(
      rc,
      `/scopes/${scope.level}/${scope.id}/roles/revoke`,
      html`${hiddenPrincipal(user.id)} ${REASON_INPUT}`,
      "Give up this role",
    )}
  </section>`;
}

/** A greeting that fits the local time of day. */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Two letters for an organization's mark. */
function monogram(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "");
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? words[0]?.[1] ?? ""))
    .toUpperCase()
    .slice(0, 2);
}

async function home(rc: RequestContext): Promise<WebResponse> {
  if (!rc.user) return signInPicker(rc);
  const user = rc.user;
  const organizations = await listOrganizations(rc.ctx, user.id);
  const own = await listOwnRoles(rc.ctx, user.id);
  // Only what this person can see is counted, so nothing hidden leaks through a number.
  const trees = await Promise.all(
    organizations.map((organization) =>
      getOrganizationTree(rc.ctx, user.id, organization.id).catch(() => null),
    ),
  );
  const firstName = user.displayName.split(/\s+/)[0] ?? user.displayName;
  // Needs-you: only scopes this person can already see, counted with the same
  // permission-checked reads as the pages each row links to.
  const visibleProjects = trees.flatMap((tree) =>
    tree ? tree.businessUnits.flatMap((unit) => unit.projects.map((project) => ({ project, organizationName: tree.organization.name }))) : [],
  );
  const pendingReviews = user.kind === "human"
    ? (await listReviewQueue(rc.ctx, user.id, { limit: 200 }).catch(() => [])).length
    : 0;
  const workRows: SafeHtml[] = [];
  const suspendedRows: SafeHtml[] = [];
  const activity: Array<{ at: Date; row: SafeHtml }> = [];
  for (const { project } of visibleProjects) {
    const work = await listWork(rc.ctx, user.id, project.id).catch(() => []);
    const stale = work.filter((item) => item.contextStatus === "review_needed").length;
    if (stale > 0) {
      workRows.push(ledgerRow({
        href: `/projects/${project.id}/work`,
        title: `${stale} work ${stale === 1 ? "item needs" : "items need"} review in ${project.name}`,
        meta: "Context is no longer current",
        trailing: html`<span class="badge" data-state="warning">Stale</span>`,
      }));
    }
    const suspended = await listMemories(rc.ctx, user.id, { scope: { level: "project", id: project.id }, status: "suspended", limit: 200 }).catch(() => []);
    if (suspended.length > 0) {
      suspendedRows.push(ledgerRow({
        href: `/projects/${project.id}#current-knowledge`,
        title: `${suspended.length} suspended ${suspended.length === 1 ? "memory is" : "memories are"} not current guidance in ${project.name}`,
        meta: "Suspended knowledge",
        trailing: html`<span class="badge" data-state="flagged">Suspended</span>`,
      }));
    }
    const approved = await listMemories(rc.ctx, user.id, { scope: { level: "project", id: project.id }, limit: 20 }).catch(() => []);
    for (const memory of approved) {
      activity.push({ at: memory.approvedAt, row: ledgerRow({
        href: `/memories/${memory.id}`,
        title: memory.title,
        meta: html`Approved in ${project.name} · ${memory.approvedAt}`,
        trailing: html`<span class="badge" data-kind="knowledge">Approved</span>`,
      }) });
    }
    const sources = await listSources(rc.ctx, user.id, { scope: { level: "project", id: project.id }, limit: 20 }).catch(() => []);
    for (const source of sources) {
      activity.push({ at: source.capturedAt, row: ledgerRow({
        href: `/sources/${source.id}`,
        title: source.reference,
        meta: html`Captured in ${project.name} · ${source.capturedAt}`,
        trailing: html`<span class="badge" data-kind="evidence">Captured</span>`,
      }) });
    }
  }
  activity.sort((a, b) => b.at.getTime() - a.at.getTime());
  const recentActivity = activity.slice(0, 6).map((item) => item.row);
  const brainActivity = organizations[0]
    ? (await listBrainActivity(rc.ctx, user.id, organizations[0].id, 8).catch(() => [])).map((event) => ledgerRow({
        href: event.href,
        title: event.label,
        meta: html`Brain activity · ${event.at}`,
        trailing: html`<span class="badge" data-kind="guidance">Brain</span>`,
      }))
    : [];
  const needsYou: SafeHtml[] = [
    ...(pendingReviews > 0 ? [ledgerRow({ href: "/review", title: `${pendingReviews} ${pendingReviews === 1 ? "proposal" : "proposals"} waiting for your review`, meta: "Review queue", trailing: html`<span class="badge" data-state="pending">Review</span>` })] : []),
    ...workRows,
    ...suspendedRows,
  ];
  for (const organization of organizations) {
    const brain = await analyzeBrainHealth(rc.ctx, user.id, { organizationId: organization.id }).catch(() => []);
    for (const finding of brain) {
      if (finding.kind !== "warning_nodes" && finding.kind !== "flagged_nodes" && finding.kind !== "uncited_sources") continue;
      needsYou.push(ledgerRow({
        href: finding.href,
        title: finding.label,
        meta: "Brain health",
        trailing: html`<span class="badge" data-kind="guidance">Brain</span>`,
      }));
    }
  }
  return page(rc, {
    title: "Organizations",
    workspace: true,
    body: html`<div class="dash">
      <header class="dash-head">
        <h1>${greeting()}, ${firstName}.</h1>
        <p class="dash-lede">
          ${rc.prototype ? "Explore original source, inspect imported pull requests, and review engineering knowledge before publishing it." : "Your organizations' shared memory: the decisions, lessons, and rules your teams and AI tools rely on, each with its source, owner, and history."}
        </p>
        <div class="dash-actions">
          ${organizations[0]
            ? html`<a
                  class="key key-primary"
                  href="/orgs/${organizations[0].id}/network${organizations[0].slug.endsWith("-evidence") ? "?evidence=all" : ""}"
                  >Open the network${interfaceIcon("network")}</a
                >
                <a class="key" href="/orgs/${organizations[0].id}/you"
                  >Your network${interfaceIcon("person")}</a
                >`
            : ""}
          <a class="key" href="/review">${interfaceIcon("review")}Review queue</a>
        </div>
      </header>

      ${statStrip([
        ["Organizations", organizations.length],
        ["Business units", trees.reduce((sum, tree) => sum + (tree?.businessUnits.length ?? 0), 0)],
        ["Projects", trees.reduce((sum, tree) => sum + (tree?.businessUnits.reduce((count, unit) => count + unit.projects.length, 0) ?? 0), 0)],
        ["Assigned roles", own.length],
      ])}
      ${needsYou.length > 0
        ? html`<section class="needs-you panel" aria-labelledby="needs-title">
            <h2 id="needs-title">Needs you</h2>
            <ul class="ledger">${needsYou}</ul>
          </section>`
        : ""}
      ${recentActivity.length > 0
        ? html`<section aria-labelledby="activity-title">
            <h2 id="activity-title">Recent activity</h2>
            <ul class="ledger">${recentActivity}</ul>
          </section>`
        : ""}
      ${brainActivity.length > 0
        ? html`<section aria-labelledby="brain-activity-title">
            <h2 id="brain-activity-title">Brain activity</h2>
            <ul class="ledger">${brainActivity}</ul>
          </section>`
        : ""}
      <section class="dash-section" aria-labelledby="orgs-title">
        <div class="dash-section-head">
          <h2 id="orgs-title">Your organizations</h2>
          <span class="count-pill">${organizations.length}</span>
        </div>
        ${organizations.length > 0
          ? html`<ul class="ledger org-ledger">
              ${organizations.map((organization, index) => {
                const tree = trees[index];
                const units = tree?.businessUnits.length ?? 0;
                const projects =
                  tree?.businessUnits.reduce(
                    (sum, unit) => sum + unit.projects.length,
                    0,
                  ) ?? 0;
                return ledgerRow({
                  href: `/orgs/${organization.id}`,
                  title: html`<span class="org-mark hue-${[...organization.slug].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4}" aria-hidden="true">${monogram(organization.name)}</span> ${organization.name}`,
                  meta: html`${organization.slug} · ${units} ${units === 1 ? "unit" : "units"} · ${projects} ${projects === 1 ? "project" : "projects"}`,
                  trailing: html`${roleBadge(tree?.role ?? null)} <a href="/orgs/${organization.id}/network${organization.slug.endsWith("-evidence") ? "?evidence=all" : ""}">Network</a> <a href="/orgs/${organization.id}/you">Your network</a>`,
                });
              })}
            </ul>`
          : html`<div class="empty-state">
              <p class="empty">
                You have no roles in any organization, so there is nothing to
                show. An administrator must give you a role first.
              </p>
            </div>`}
      </section>

      <div class="dash-grid">
        <section aria-labelledby="roles-title">
          <h2 id="roles-title">Your roles</h2>
          ${table(
            ["Role", "Where", "Organization"],
            own.map((role) => [
              roleBadge(role.role),
              html`<a href="${scopePath(role.scope)}">${role.scopeName}</a>
                <small>${LEVEL_LABEL[role.scope.level]}</small>`,
              html`${role.organizationName}`,
            ]),
            "None yet.",
          )}
        </section>
        ${user.kind === "human" && !rc.prototype
          ? html`<section aria-labelledby="create-title">
              <h2 id="create-title">Create an organization</h2>
              <p class="hint">
                Start a new shared memory. You become its owner and can add
                business units, projects, and people.
              </p>
              ${postForm(
                rc,
                "/orgs",
                html`<label
                    >Name <input name="name" required maxlength="120"
                  /></label>
                  <label
                    >Short name for links
                    <input
                      name="slug"
                      required
                      maxlength="63"
                      pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
                      placeholder="my-team"
                  /></label>`,
                "Create organization",
                "stacked",
              )}
            </section>`
          : rc.prototype ? html`` : html`<section>
              <p class="hint">Agents cannot create organizations.</p>
            </section>`}
      </div>
    </div>`,
  });
}

async function organizationPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const tree = await getOrganizationTree(rc.ctx, user.id, rc.params.id ?? "");
  const organization = tree.organization;
  const scope: ScopeRef = { level: "organization", id: organization.id };
  const own = await listOwnRoles(rc.ctx, user.id);
  const isAdmin =
    user.kind === "human" && rankOf(tree.role) >= ROLE_RANK.administrator;
  return page(rc, {
    title: organization.name,
    crumbs: [[organization.name, `/orgs/${organization.id}`]],
    body: html`${recordHead({
        kind: "Organization",
        title: organization.name,
        status: roleBadge(tree.role),
        meta: html`${organization.slug} · Your organization-wide role is shown beside the title.`,
        actions: html`<a class="key key-primary" href="/orgs/${organization.id}/network${organization.slug.endsWith("-evidence") ? "?evidence=all" : ""}">Open the network</a> <a class="key" href="/orgs/${organization.id}/you">Your network</a> ${integrityLink(organization.id, tree.role)}`,
      })}
      ${statStrip([
        ["Business units", tree.businessUnits.length],
        ["Projects", tree.businessUnits.reduce((sum, unit) => sum + unit.projects.length, 0)],
        ["Your role", tree.role ?? "None"],
      ])}
      <section>
        <h2>Business units and projects you can see</h2>
        ${tree.businessUnits.length === 0
          ? html`<p class="empty">None yet.</p>`
          : html`<ul class="ledger">
              ${tree.businessUnits.flatMap((unit) => [
                ledgerRow({
                  href: `/business-units/${unit.id}`,
                  title: unit.name,
                  meta: html`${unit.projects.length} ${unit.projects.length === 1 ? "project" : "projects"}`,
                  trailing: roleBadge(unit.role),
                }),
                ...unit.projects.map((item) => ledgerRow({
                  href: `/projects/${item.id}`,
                  title: item.name,
                  meta: html`Project in ${unit.name}`,
                  trailing: roleBadge(item.role),
                })),
              ])}
            </ul>`}
      </section>
      ${await definitionsSummary(rc, scope, organization.id)}
      ${isAdmin
        ? html`<section>
            <h2>Create a business unit</h2>
            ${postForm(
              rc,
              `/orgs/${organization.id}/business-units`,
              html`<label
                  >Name <input name="name" required maxlength="120"
                /></label>
                <label
                  >Short name for links
                  <input name="slug" required maxlength="63"
                /></label>`,
              "Create business unit",
              "stacked",
            )}
          </section>`
        : ""}
      ${isAdmin ? exportForm(rc, scope) : ""}
      ${await membersSection(rc, scope, tree.role)}
      ${ownRoleSection(rc, scope, own)}`,
  });
}

async function businessUnitPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const id = requireId(rc.params.id, "businessUnitId");
  const scope = await resolveScope(rc.ctx.db, { level: "business_unit", id });
  const tree = await getOrganizationTree(
    rc.ctx,
    user.id,
    scope.organizationId,
  ).catch(notFoundAs("Business unit not found"));
  const unit = tree.businessUnits.find((item) => item.id === id);
  if (!unit) throw new NotFoundError("Business unit not found");
  const own = await listOwnRoles(rc.ctx, user.id);
  const isAdmin =
    user.kind === "human" && rankOf(unit.role) >= ROLE_RANK.administrator;
  const unitScope: ScopeRef = { level: "business_unit", id: unit.id };
  return page(rc, {
    title: unit.name,
    crumbs: [
      [tree.organization.name, `/orgs/${tree.organization.id}`],
      [unit.name, `/business-units/${unit.id}`],
    ],
    body: html`${recordHead({
        kind: "Business unit",
        title: unit.name,
        status: roleBadge(unit.role),
        meta: html`${tree.organization.name} · ${unit.projects.length} ${unit.projects.length === 1 ? "project" : "projects"} you can see.`,
      })}
      <section>
        <h2>Projects you can see</h2>
        ${unit.projects.length === 0
          ? html`<p class="empty">No projects you can see.</p>`
          : html`<ul class="ledger">
              ${unit.projects.map((item) => ledgerRow({
                href: `/projects/${item.id}`,
                title: item.name,
                meta: "Project",
                trailing: roleBadge(item.role),
              }))}
            </ul>`}
      </section>
      ${await definitionsSummary(rc, unitScope, tree.organization.id)}
      ${isAdmin
        ? html`<section>
            <h2>Create a project</h2>
            ${postForm(
              rc,
              `/business-units/${unit.id}/projects`,
              html`<label
                  >Name <input name="name" required maxlength="120"
                /></label>
                <label
                  >Short name for links
                  <input name="slug" required maxlength="63"
                /></label>`,
              "Create project",
              "stacked",
            )}
          </section>`
        : ""}
      ${isAdmin ? exportForm(rc, unitScope) : ""}
      ${await membersSection(rc, unitScope, unit.role)}
      ${ownRoleSection(rc, unitScope, own)}`,
  });
}

function repositoriesSection(
  rc: RequestContext,
  projectId: string,
  connections: readonly RepositoryConnection[],
): SafeHtml {
  const rows = connections.map((connection) => [
    html`${connection.fullName}`,
    html`${connection.externalRepositoryId}`,
    connection.disconnectedAt === null
      ? html`${badge("connected", "ok")} since ${connection.connectedAt}`
      : html`${badge("disconnected", "muted")} ${connection.disconnectedAt}:
        ${connection.disconnectReason ?? ""}`,
    connection.disconnectedAt === null
      ? postForm(
          rc,
          `/repositories/${connection.id}/disconnect`,
          REASON_INPUT,
          "Disconnect",
        )
      : html``,
  ]);
  return html`<section>
    <h2>GitHub repositories</h2>
    <p class="hint">
      Only sources from a connected repository are readable, and only by people
      who can read that repository on GitHub.
    </p>
    ${table(
      ["Repository", "GitHub ID", "Status", "Change"],
      rows,
      "No repositories connected yet.",
    )}
    <h3>Connect a repository</h3>
    ${postForm(
      rc,
      `/projects/${projectId}/repositories`,
      html`<label
          >GitHub repository ID
          <input
            name="externalRepositoryId"
            required
            inputmode="numeric"
            pattern="[1-9][0-9]*"
        /></label>
        <label
          >Full name
          <input name="fullName" required placeholder="owner/repository"
        /></label>`,
      "Connect repository",
      "stacked",
    )}

  </section>`;
}

async function projectPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const view = await loadProject(rc, rc.params.id);
  const { project } = view;
  const scope: ScopeRef = { level: "project", id: project.id };
  const memories = await listMemories(rc.ctx, user.id, { scope, limit: 200 });
  const suspended = await listMemories(rc.ctx, user.id, {
    scope,
    status: "suspended",
    limit: 200,
  });
  const replaced = await listMemories(rc.ctx, user.id, {
    scope,
    status: "superseded",
    limit: 200,
  });
  const sources = await listSources(rc.ctx, user.id, { scope, limit: 200 });
  const own = await listOwnRoles(rc.ctx, user.id);
  const rank = rankOf(project.role);
  const isAdmin = user.kind === "human" && rank >= ROLE_RANK.administrator;
  const canPropose = rank >= ROLE_RANK.contributor;
  const connections = isAdmin
    ? await listRepositoryConnections(rc.ctx, user.id, project.id)
    : null;
  return page(rc, {
    title: project.name,
    crumbs: projectCrumbs(view),
    body: html`${recordHead({
        kind: "Project",
        title: project.name,
        status: roleBadge(project.role),
        meta: html`Your role in this project is shown beside the title.`,
        actions: rc.checkouts?.has(project.name) ? html`<a class="key" href="/projects/${project.id}/repository">Browse original repository</a>` : undefined,
      })}
      ${scopeTabs([
        { label: "Knowledge", href: "#current-knowledge", count: memories.length, current: true },
        { label: "Definitions", href: `/scopes/project/${project.id}/definitions` },
        { label: "Evidence", href: "#evidence", count: sources.length },
        { label: "Work", href: `/projects/${project.id}/work` },
        { label: "Search", href: `/projects/${project.id}/search` },
        { label: "Activity", href: `/projects/${project.id}/retrievals` },
      ])}
      <nav class="project-actions" aria-label="Project actions">
        ${rc.checkouts?.has(project.name)?html`<a class="button-link" href="/projects/${project.id}/repository">Browse original repository</a>`:""}
        <a href="/projects/${project.id}/work">Affected work</a>
        <a href="#current-knowledge">Current knowledge</a>
        <a href="#evidence">Evidence</a>
        ${canPropose
          ? html`<a href="#record-evidence">Record evidence</a>
              <a href="#propose-memory">Propose a memory</a>`
          : ""}
      </nav>
      ${rc.decisionGuardAvailable && user.kind === "human" && canPropose
        ? html`<p><a class="button" href="/projects/${project.id}/decision-guard">Decision Guard: suggest decisions with Meta</a></p>`
        : ""}
      ${searchSection(project.id)}
      ${await memoriesSection(
        rc,
        memories,
        "Current knowledge",
        "No current knowledge you can read here.",
        undefined,
        "current-knowledge",
      )}
      ${await definitionsSummary(rc, scope, view.tree.organization.id)}
      ${await brainSection(rc, project.id, view.tree.organization.id, canPropose)}
      ${user.kind === "human" && canPropose
        ? await proposalsSection(rc, project.id)
        : ""}
      ${suspended.length > 0
        ? await memoriesSection(
            rc,
            suspended,
            "Suspended",
            "",
            "Disputed guidance, not current until a reviewer resolves it.",
          )
        : ""}
      ${replaced.length > 0
        ? await memoriesSection(
            rc,
            replaced,
            "Replaced",
            "",
            "Older guidance kept for its history. Not current.",
          )
        : ""}
      ${sourcesSection(sources)}
      ${canPropose ? await recordSourceSection(rc, project.id) : ""}
      ${canPropose ? await proposeSection(rc, project.id, sources) : ""}
      ${isAdmin ? exportForm(rc, scope) : ""}
      ${await policySection(rc, project.id, project.role)}
      ${connections ? repositoriesSection(rc, project.id, connections) : ""}
      ${await membersSection(rc, scope, project.role)}
      ${ownRoleSection(rc, scope, own)}`,
  });
}

async function createOrganizationAction(
  rc: RequestContext,
): Promise<WebResponse> {
  const user = requireUser(rc);
  const organization = await createOrganization(rc.ctx, user.id, {
    slug: formValue(rc, "slug") ?? "",
    name: formValue(rc, "name") ?? "",
  });
  return redirect(`/orgs/${organization.id}`, "org-created");
}

async function createBusinessUnitAction(
  rc: RequestContext,
): Promise<WebResponse> {
  const user = requireUser(rc);
  const unit = await createBusinessUnit(rc.ctx, user.id, {
    organizationId: rc.params.id ?? "",
    slug: formValue(rc, "slug") ?? "",
    name: formValue(rc, "name") ?? "",
  });
  return redirect(`/business-units/${unit.id}`, "bu-created");
}

async function createProjectAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const created = await createProject(rc.ctx, user.id, {
    businessUnitId: rc.params.id ?? "",
    slug: formValue(rc, "slug") ?? "",
    name: formValue(rc, "name") ?? "",
  });
  return redirect(`/projects/${created.id}`, "project-created");
}

async function assignRoleAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const scope = routeScope(rc);
  await assignRole(rc.ctx, user.id, {
    principalId: formValue(rc, "principalId") ?? "",
    scope,
    role: (formValue(rc, "role") ?? "") as Role,
    reason: formValue(rc, "reason"),
  });
  return redirect(scopePath(scope), "role-assigned");
}

async function revokeRoleAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const scope = routeScope(rc);
  const principalId = formValue(rc, "principalId") ?? "";
  await revokeRole(rc.ctx, user.id, {
    principalId,
    scope,
    reason: formValue(rc, "reason") ?? "",
  });
  return redirect(
    principalId === user.id ? "/" : scopePath(scope),
    "role-revoked",
  );
}

async function removeMemberAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const principalId = formValue(rc, "principalId") ?? "";
  const organizationId = rc.params.id ?? "";
  await removeFromOrganization(rc.ctx, user.id, {
    principalId,
    organizationId,
    reason: formValue(rc, "reason") ?? "",
  });
  return redirect(
    principalId === user.id ? "/" : `/orgs/${organizationId}`,
    "member-removed",
  );
}

async function connectRepositoryAction(
  rc: RequestContext,
): Promise<WebResponse> {
  const user = requireUser(rc);
  const connection = await connectRepository(rc.ctx, user.id, {
    projectId: rc.params.id ?? "",
    provider: "github",
    externalRepositoryId: formValue(rc, "externalRepositoryId") ?? "",
    fullName: formValue(rc, "fullName") ?? "",
  });
  return redirect(`/projects/${connection.projectId}`, "repo-connected");
}

async function disconnectRepositoryAction(
  rc: RequestContext,
): Promise<WebResponse> {
  const user = requireUser(rc);
  const connection = await disconnectRepository(rc.ctx, user.id, {
    connectionId: rc.params.id ?? "",
    reason: formValue(rc, "reason") ?? "",
  });
  return redirect(`/projects/${connection.projectId}`, "repo-disconnected");
}

const ID = "(?<id>[^/]+)";
const LEVEL = "(?<level>organization|business_unit|project)";

export const organizationRoutes: readonly Route[] = [
  { method: "GET", pattern: /^\/$/, access: "public", handle: home },
  {
    method: "POST",
    pattern: /^\/orgs$/,
    access: "user",
    handle: createOrganizationAction,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/orgs/${ID}$`),
    access: "user",
    handle: organizationPage,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/orgs/${ID}/business-units$`),
    access: "user",
    handle: createBusinessUnitAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/orgs/${ID}/remove-member$`),
    access: "user",
    handle: removeMemberAction,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/business-units/${ID}$`),
    access: "user",
    handle: businessUnitPage,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/business-units/${ID}/projects$`),
    access: "user",
    handle: createProjectAction,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/projects/${ID}$`),
    access: "user",
    handle: projectPage,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/projects/${ID}/repositories$`),
    access: "user",
    handle: connectRepositoryAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/repositories/${ID}/disconnect$`),
    access: "user",
    handle: disconnectRepositoryAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/scopes/${LEVEL}/${ID}/roles$`),
    access: "user",
    handle: assignRoleAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/scopes/${LEVEL}/${ID}/roles/revoke$`),
    access: "user",
    handle: revokeRoleAction,
  },
];
