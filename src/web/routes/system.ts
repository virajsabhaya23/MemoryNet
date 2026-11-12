import { loadExampleData } from "../../demo-data.ts";
import { ValidationError } from "../../errors.ts";
import { createPrincipal } from "../../members.ts";
import {
  handleRepositoryRemoved,
  recordRepositoryAccess,
} from "../../repositories.ts";
import type { PrincipalKind } from "../../roles.ts";
import { badge, html, options, table, type SafeHtml } from "../html.ts";
import {
  formValue,
  page,
  redirect,
  type RequestContext,
  type Route,
  type WebResponse,
} from "../kit.ts";
import {
  allPrincipals,
  isSystemTab,
  knownRepositories,
  principalOptions,
  repositoryOptions,
  stamp,
  SYSTEM_TABS,
  systemForm,
  systemPath,
  type SystemTab,
} from "../system-kit.ts";
import { capturedList, captureForm } from "./capture.ts";
import { checkSummarySection } from "./review.ts";

/** Rows per page in the System tables, so thousands of people and reports stay quick. */
export const SYSTEM_PAGE = 50;

interface Stats {
  people: number;
  agents: number;
  organizations: number;
  repositories: number;
  reports: number;
  captured: number;
}

async function systemStats(rc: RequestContext): Promise<Stats> {
  const { rows } = await rc.ctx.db.query<{
    people: number;
    agents: number;
    organizations: number;
    repositories: number;
    reports: number;
    captured: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM principals WHERE kind = 'human') AS people,
       (SELECT count(*)::int FROM principals WHERE kind = 'agent') AS agents,
       (SELECT count(*)::int FROM organizations) AS organizations,
       (SELECT count(*)::int FROM repository_connections WHERE disconnected_at IS NULL) AS repositories,
       (SELECT count(*)::int FROM repository_access) AS reports,
       (SELECT count(*)::int FROM sources WHERE capture_method = 'github_app') AS captured`,
  );
  return (
    rows[0] ?? {
      people: 0,
      agents: 0,
      organizations: 0,
      repositories: 0,
      reports: 0,
      captured: 0,
    }
  );
}

function pageNumber(rc: RequestContext): number {
  const value = Number(rc.req.query.get("page") ?? "1");
  return Number.isInteger(value) && value > 0 ? value : 1;
}

/** Previous and next links that keep the tab and the search. */
function pager(
  tab: SystemTab,
  query: string,
  page: number,
  total: number,
): SafeHtml {
  const pages = Math.max(1, Math.ceil(total / SYSTEM_PAGE));
  if (pages === 1) return html``;
  const link = (to: number) =>
    `/system?tab=${tab}${query === "" ? "" : `&q=${encodeURIComponent(query)}`}&page=${to}`;
  return html`<nav class="pager" aria-label="Pages">
    ${
      page > 1
        ? html`<a href="${link(page - 1)}" rel="prev">← Previous</a>`
        : html`<span aria-hidden="true"></span>`
    }
    <span>Page ${Math.min(page, pages)} of ${pages}</span>
    ${
      page < pages
        ? html`<a href="${link(page + 1)}" rel="next">Next →</a>`
        : html`<span aria-hidden="true"></span>`
    }
  </nav>`;
}

function searchForm(tab: SystemTab, query: string, label: string): SafeHtml {
  return html`<form
    method="get"
    action="/system"
    class="console-search"
    role="search"
  >
    <input type="hidden" name="tab" value="${tab}" />
    <label class="visually-hidden" for="console-q">${label}</label>
    <input
      id="console-q"
      type="search"
      name="q"
      value="${query}"
      placeholder="${label}…"
    />
    <button type="submit" class="secondary">Search</button>
    ${query === "" ? html`` : html`<a href="/system?tab=${tab}">Clear</a>`}
  </form>`;
}

function tabNav(current: SystemTab): SafeHtml {
  return html`<nav class="console-tabs" aria-label="System sections">
    ${SYSTEM_TABS.map(
      ([id, label]) =>
        html`<a
          href="${id === "overview" ? "/system" : `/system?tab=${id}`}"
          ${id === current ? html`aria-current="page"` : ""}
          >${label}</a
        >`,
    )}
  </nav>`;
}

function card(title: string, hint: string, body: SafeHtml): SafeHtml {
  return html`<div class="console-card panel">
    <h2>${title}</h2>
    <p class="hint">${hint}</p>
    ${body}
  </div>`;
}

function addPersonForm(rc: RequestContext, back: SystemTab): SafeHtml {
  return systemForm(
    rc,
    "/system/principals",
    html`<input type="hidden" name="back" value="${back}" />
      <div class="field-grid">
        <label
          >Name <input name="displayName" required maxlength="120"
        /></label>
        <label
          >Kind
          <select name="kind">
            ${options([
              { value: "human", label: "person" },
              { value: "agent", label: "agent" },
            ])}
          </select></label
        >
      </div>
      <label
        >GitHub user ID (people only, optional)
        <input name="githubUserId" inputmode="numeric" pattern="[1-9][0-9]*"
      /></label>`,
    "Add",
  );
}

async function overviewTab(
  rc: RequestContext,
  stats: Stats,
): Promise<SafeHtml> {
  const repositories = await knownRepositories(rc);
  const empty = stats.people + stats.agents === 0;
  const tile = (value: number, label: string, href: string) =>
    html`<a class="console-tile" href="${href}"
      ><strong>${value.toLocaleString("en-US")}</strong><span>${label}</span></a
    >`;
  return html`<div class="console-tiles">
      ${tile(stats.organizations, "Organizations", "/")}
      ${tile(stats.people, "People", "/system?tab=people")}
      ${tile(stats.agents, "Agents", "/system?tab=people")}
      ${tile(stats.repositories, "Connected repositories", "/system?tab=github")}
      ${tile(stats.reports, "Access reports", "/system?tab=access")}
      ${tile(stats.captured, "Pull requests captured", "/system?tab=github")}
    </div>
    <div class="console-grid">
      ${card(
        "A pull request was merged",
        "The everyday event: its title and description become evidence in the project the repository is connected to, ready for someone to propose a memory from it.",
        repositories.some((repository) => repository.fullName !== null)
          ? captureForm(rc, repositories, "overview", true)
          : html`<p class="empty">
              No repository is connected yet. An administrator connects one from
              a project page first.
            </p>`,
      )}
      ${card(
        "Add a person or agent",
        "Everyone who signs in here starts as a stand-in account. Add yourself and a teammate to review, then give them roles from an organization or project page.",
        addPersonForm(rc, "overview"),
      )}
      ${card(
        "Example data",
        "Two synthetic organizations with people, an agent, repositories, sources, approved memories, and pending proposals.",
        empty
          ? systemForm(
              rc,
              "/system/example-data",
              html``,
              "Load synthetic example data",
            )
          : html`<p>
              Data is loaded. To start over, stop the app (Ctrl+C), run
              <code>npm run app:reset</code>, then <code>npm run app</code>.
            </p>`,
      )}
    </div>
    <div class="console-panel">${await capturedList(rc, 8)}</div>`;
}

async function peopleTab(rc: RequestContext): Promise<SafeHtml> {
  const query = (rc.req.query.get("q") ?? "").trim();
  const page = pageNumber(rc);
  const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await rc.ctx.db.query<{
    id: string;
    kind: "human" | "agent";
    display_name: string;
    github_user_id: string | null;
    total: number;
  }>(
    `SELECT id, kind, display_name, github_user_id, count(*) OVER ()::int AS total
     FROM principals
     WHERE display_name ILIKE $1
     ORDER BY kind = 'agent', display_name, id
     LIMIT $2 OFFSET $3`,
    [pattern, SYSTEM_PAGE, (page - 1) * SYSTEM_PAGE],
  );
  const total = rows[0]?.total ?? 0;
  return html`<div class="console-grid wide-left">
    <div class="console-panel">
      <div class="console-panel-head">
        <h2>People and agents <span class="count-pill">${total}</span></h2>
        ${searchForm("people", query, "Find by name")}
      </div>
      ${table(
        ["Name", "Kind", "GitHub user ID"],
        rows.map((principal) => [
          html`${principal.display_name}`,
          principal.kind === "agent"
            ? badge("agent", "agent")
            : badge("person", "neutral"),
          html`${principal.github_user_id ?? ""}`,
        ]),
        query === "" ? "Nobody yet." : "Nobody matches that name.",
      )}
      ${pager("people", query, page, total)}
    </div>
    ${card(
      "Add a person or agent",
      "Stands in for an account being created. They have no roles until an administrator gives them one.",
      addPersonForm(rc, "people"),
    )}
  </div>`;
}

async function accessTab(rc: RequestContext): Promise<SafeHtml> {
  const query = (rc.req.query.get("q") ?? "").trim();
  const page = pageNumber(rc);
  const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await rc.ctx.db.query<{
    display_name: string;
    external_repository_id: string;
    full_name: string | null;
    can_read: boolean;
    observed_at: Date;
    total: number;
  }>(
    `SELECT pr.display_name, ra.external_repository_id,
            (SELECT c.full_name FROM repository_connections c
             WHERE c.external_repository_id = ra.external_repository_id
             ORDER BY c.connected_at DESC LIMIT 1) AS full_name,
            ra.can_read, ra.observed_at, count(*) OVER ()::int AS total
     FROM repository_access ra JOIN principals pr ON pr.id = ra.principal_id
     WHERE pr.display_name ILIKE $1 OR ra.external_repository_id ILIKE $1
        OR EXISTS (SELECT 1 FROM repository_connections c
                   WHERE c.external_repository_id = ra.external_repository_id
                     AND c.full_name ILIKE $1)
     ORDER BY ra.observed_at DESC, pr.display_name
     LIMIT $2 OFFSET $3`,
    [pattern, SYSTEM_PAGE, (page - 1) * SYSTEM_PAGE],
  );
  const total = rows[0]?.total ?? 0;
  const principals = await allPrincipals(rc);
  const repositories = repositoryOptions(await knownRepositories(rc));
  const days = Math.round(rc.ctx.repositoryAccessMaxAgeMs / 86_400_000);
  return html`<div class="console-grid wide-left">
    <div class="console-panel">
      <div class="console-panel-head">
        <h2>
          Access reported by GitHub <span class="count-pill">${total}</span>
        </h2>
        ${searchForm("access", query, "Find a person or repository")}
      </div>
      <p class="hint">
        Reading a source needs a current report that the person can read its
        repository. This local app treats a report as current for ${days} days;
        the real limit is 15 minutes, kept fresh by GitHub. Newest first.
      </p>
      ${table(
        ["Person or agent", "Repository", "Can read", "Reported"],
        rows.map((row) => [
          html`${row.display_name}`,
          html`${row.full_name ?? ""}
            <small><code>${row.external_repository_id}</code></small>`,
          row.can_read ? badge("yes", "ok") : badge("no", "danger"),
          html`<time>${stamp(row.observed_at)}</time>`,
        ]),
        query === "" ? "No reports yet." : "No report matches that.",
      )}
      ${pager("access", query, page, total)}
    </div>
    ${card(
      "Report a change in access",
      "Stands in for GitHub telling MemoryNet that someone gained or lost read access to a repository.",
      systemForm(
        rc,
        "/system/repository-access",
        html`<input type="hidden" name="back" value="access" />
          <label
            >Person or agent
            <select name="principalId" required>
              ${principalOptions(principals)}
            </select></label
          >
          <label
            >Repository
            <select name="externalRepositoryId" required>
              ${repositories}
            </select></label
          >
          <label
            >Can read it on GitHub
            <select name="canRead">
              ${options([
                { value: "yes", label: "yes" },
                { value: "no", label: "no" },
              ])}
            </select></label
          >`,
        "Report access",
      ),
    )}
  </div>`;
}

async function githubTab(rc: RequestContext): Promise<SafeHtml> {
  const repositories = await knownRepositories(rc);
  return html`<div class="console-grid">
      ${card(
        "A pull request was merged",
        "The title and description become one source in the project the repository is connected to. Secrets are replaced, possible personal data is flagged, and text over 4,000 characters is shortened. Later events for the same pull request change nothing.",
        captureForm(rc, repositories, "github"),
      )}
      ${card(
        "Repository removed from the GitHub App",
        "Disconnects the repository from its project. Its sources and the memories citing them stop being readable at once.",
        systemForm(
          rc,
          "/system/repository-removed",
          html`<input type="hidden" name="back" value="github" />
            <label
              >Repository
              <select name="externalRepositoryId" required>
                ${repositoryOptions(repositories)}
              </select></label
            >`,
          "Report removal",
        ),
      )}
    </div>
    <div class="console-panel">${await capturedList(rc, 20)}</div>`;
}

async function systemPage(rc: RequestContext): Promise<WebResponse> {
  const asked = rc.req.query.get("tab");
  const tab: SystemTab = isSystemTab(asked)
    ? asked
    : rc.req.query.has("checkRepository")
      ? "checks"
      : "overview";
  const stats = await systemStats(rc);
  const body =
    tab === "people"
      ? await peopleTab(rc)
      : tab === "access"
        ? await accessTab(rc)
        : tab === "github"
          ? await githubTab(rc)
          : tab === "checks"
            ? html`<div class="console-narrow">
                ${await checkSummarySection(rc)}
              </div>`
            : await overviewTab(rc, stats);
  const info = SYSTEM_TABS.find(([id]) => id === tab);
  return page(rc, {
    title: "System",
    body: html`<p class="console-banner">
        <span class="tag-dot" aria-hidden="true"></span>
        <span
          ><strong>Stand-in for GitHub and account setup.</strong> In a real
          deployment only signature-checked GitHub events and sign-in could do
          these things. Local testing only.</span
        >
      </p>
      ${rc.decisionGuardAvailable
        ? html`<p><a href="/settings/meta">Connect Meta Model API</a></p>`
        : ""}
      ${tabNav(tab)}
      <p class="console-lede">${info?.[2] ?? ""}</p>
      <div class="console-body">${body}</div>`,
  });
}

async function loadExampleDataAction(rc: RequestContext): Promise<WebResponse> {
  await loadExampleData(rc.ctx);
  return redirect("/", "example-data");
}

async function addPrincipalAction(rc: RequestContext): Promise<WebResponse> {
  const githubUserId = formValue(rc, "githubUserId");
  await createPrincipal(rc.ctx, {
    kind: (formValue(rc, "kind") ?? "") as PrincipalKind,
    displayName: formValue(rc, "displayName") ?? "",
    ...(githubUserId === undefined ? {} : { githubUserId }),
  });
  return redirect(systemPath(rc), "principal-created");
}

async function reportAccessAction(rc: RequestContext): Promise<WebResponse> {
  const answer = formValue(rc, "canRead");
  if (answer !== "yes" && answer !== "no") {
    throw new ValidationError("Choose whether they can read the repository");
  }
  await recordRepositoryAccess(rc.ctx, {
    principalId: formValue(rc, "principalId") ?? "",
    provider: "github",
    externalRepositoryId: formValue(rc, "externalRepositoryId") ?? "",
    canRead: answer === "yes",
  });
  return redirect(systemPath(rc), "access-reported");
}

async function reportRemovalAction(rc: RequestContext): Promise<WebResponse> {
  const { disconnected } = await handleRepositoryRemoved(rc.ctx, {
    provider: "github",
    externalRepositoryId: formValue(rc, "externalRepositoryId") ?? "",
    reason: "Removed from the GitHub App installation (synthetic event)",
  });
  return redirect(
    systemPath(rc),
    disconnected ? "repo-removed" : "repo-removed-none",
  );
}

export const systemRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: /^\/system$/,
    access: "public",
    handle: systemPage,
  },
  {
    method: "POST",
    pattern: /^\/system\/example-data$/,
    access: "system",
    handle: loadExampleDataAction,
  },
  {
    method: "POST",
    pattern: /^\/system\/principals$/,
    access: "system",
    handle: addPrincipalAction,
  },
  {
    method: "POST",
    pattern: /^\/system\/repository-access$/,
    access: "system",
    handle: reportAccessAction,
  },
  {
    method: "POST",
    pattern: /^\/system\/repository-removed$/,
    access: "system",
    handle: reportRemovalAction,
  },
];
