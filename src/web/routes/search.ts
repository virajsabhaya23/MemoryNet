import { UnavailableError, ValidationError } from "../../errors.ts";
import {
  CONTEXT_LIMITS,
  getContext,
  listRetrievals,
  type ContextMemory,
  type ContextResponse,
  type NotCurrentMatch,
  type RetrievalRecord,
} from "../../retrieval.ts";
import { ROLE_RANK } from "../../roles.ts";
import { badge, externalLink, html, ledgerRow, table, type SafeHtml } from "../html.ts";
import {
  page,
  requireUser,
  type RequestContext,
  type Route,
  type WebResponse,
} from "../kit.ts";
import {
  flagBadges,
  loadProject,
  memoryStatusBadge,
  nameOf,
  namesFor,
  projectCrumbs,
  rankOf,
  shortSha,
  typeLabel,
  type Names,
} from "../views.ts";

/** To the second, so a search can be matched to a timed question. */
function formatTime(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Stored terms such as 'queue' | 'retri' as plain words. */
function termWords(terms: string): string {
  return [...terms.matchAll(/'((?:[^']|'')*)'/g)]
    .map((match) => (match[1] ?? "").replaceAll("''", "'"))
    .join(", ");
}

function searchForm(projectId: string, query = ""): SafeHtml {
  return html`<form
    method="get"
    action="/projects/${projectId}/search"
    class="knowledge-search"
    role="search"
  >
    <label class="visually-hidden" for="knowledge-q"
      >Search this project's knowledge</label
    >
    <input
      id="knowledge-q"
      type="search"
      name="q"
      value="${query}"
      required
      maxlength="${CONTEXT_LIMITS.queryLength}"
      placeholder="Search decisions, reasons, lessons…"
    />
    <button type="submit">Search</button>
  </form>`;
}

/** The search box on a project's page. */
export function searchSection(projectId: string): SafeHtml {
  return html`<section>
    <h2>Search knowledge</h2>
    ${searchForm(projectId)}
    <p class="hint">
      Finds current, approved knowledge you can read here, with the pull
      requests it cites. Every search is recorded:
      <a href="/projects/${projectId}/retrievals">search log</a>.
    </p>
  </section>`;
}

function citations(item: ContextMemory): SafeHtml {
  const more = item.moreCitations;
  return html`<ul class="evidence">
    ${item.citations.map(
      (citation) =>
        html`<li>
          <p>
            ${externalLink(citation.url, citation.reference)}
            <small
              >commit ${shortSha(citation.revision)} · captured
              ${citation.capturedAt}</small
            >
            ${flagBadges(citation.flags)}
            <a href="/sources/${citation.sourceId}"
              >${citation.shortened ? "whole excerpt" : "source record"}</a
            >
          </p>
          <blockquote>${citation.excerpt}</blockquote>
        </li>`,
    )}
    ${more > 0
      ? html`<li>
          <a href="/memories/${item.memoryId}"
            >${more} more cited source${more === 1 ? "" : "s"}</a
          >
        </li>`
      : ""}
  </ul>`;
}

function currentItem(item: ContextMemory, names: Names): SafeHtml {
  return html`<li class="result">
    <h3><a href="/memories/${item.memoryId}">${item.title}</a></h3>
    <p class="result-meta">
      ${memoryStatusBadge("approved")} ${badge(typeLabel(item.type), "type")}
      <span>version ${item.revision}</span>
      <span>owner ${nameOf(names, item.ownerId)}</span>
      <span>approved ${item.approvedAt}</span>
    </p>
    <p class="result-text">${item.content}</p>
    ${item.shortened
      ? html`<p><a href="/memories/${item.memoryId}">Read all of it</a></p>`
      : ""}
    ${citations(item)}
  </li>`;
}

function notCurrentItem(item: NotCurrentMatch): SafeHtml {
  const next = item.replacedBy;
  return html`<li class="result">
    <h3><a href="/memories/${item.memoryId}">${item.title}</a></h3>
    <p class="result-meta">
      ${memoryStatusBadge(item.status)} ${badge(typeLabel(item.type), "type")}
      <span>version ${item.revision}</span>
      ${item.since ? html`<span>since ${item.since}</span>` : ""}
    </p>
    ${item.status === "suspended"
      ? html`<p>
          Suspended${item.reason ? html`: ${item.reason}` : ""}. Not current
          until a reviewer resolves it.
        </p>`
      : next
        ? html`<p>
            Replaced by
            <a href="/memories/${next.memoryId}">${next.title}</a>, version
            ${next.revision}${next.status === "approved"
              ? ""
              : html` (${memoryStatusBadge(next.status)})`}.
          </p>`
        : html`<p>Replaced by a memory you cannot read.</p>`}
  </li>`;
}

async function resultsView(
  rc: RequestContext,
  response: ContextResponse,
): Promise<SafeHtml> {
  const names = await namesFor(
    rc,
    response.current.map((item) => item.ownerId),
  );
  const current =
    response.current.length === 0
      ? html`<section>
          <h2>No current knowledge matched</h2>
          <p class="empty">
            Nothing current and approved that you can read here matches these
            words. That does not mean no earlier decision exists: it may not be
            recorded yet, may use other words, or may be somewhere you cannot
            read. Try other words, or check the pull requests themselves.
          </p>
        </section>`
      : html`<section>
          <h2>Current knowledge</h2>
          <p class="hint">
            Best match
            first.${response.moreMatches
              ? ` Showing the best ${response.current.length}; more matched, so add words to narrow it down.`
              : ""}
          </p>
          <ol class="results">
            ${response.current.map((item) => currentItem(item, names))}
          </ol>
        </section>`;
  const retired =
    response.notCurrent.length === 0
      ? html``
      : html`<section>
          <h2>Matches that are not current</h2>
          <p class="hint">
            Suspended or replaced guidance, so its text is left out. Open one to
            see its history.
          </p>
          <ul class="results">
            ${response.notCurrent.map(notCurrentItem)}
          </ul>
        </section>`;
  return html`${current}${retired}
    <p class="hint">
      Recorded at ${formatTime(response.retrievedAt)} as retrieval
      <code>${response.retrievalId}</code>.
    </p>`;
}

async function searchPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const view = await loadProject(rc, rc.params.id);
  const projectId = view.project.id;
  const query = rc.req.query.get("q")?.trim() ?? "";
  let status = 200;
  let outcome = html``;
  if (query !== "") {
    try {
      outcome = await resultsView(
        rc,
        await getContext(rc.ctx, user.id, { projectId, query }),
      );
    } catch (error) {
      if (error instanceof ValidationError) {
        status = 400;
        outcome = html`<p class="error" role="alert">${error.message}</p>`;
      } else if (error instanceof UnavailableError) {
        console.error("Search failed:", error.cause);
        status = 503;
        outcome = html`<p class="error" role="alert">${error.message}</p>
          <p class="hint">
            If it keeps failing, the terminal running the app shows why.
          </p>`;
      } else {
        throw error;
      }
    }
  }
  return page(rc, {
    title: `Search ${view.project.name}`,
    crumbs: projectCrumbs(view),
    status,
    body: html`<section class="panel">
        <h2>Search knowledge</h2>
        <p class="hint">
          Finds current, approved knowledge you can read in this project, and
          the pull requests it cites. Proposals are never searched. Every search
          is recorded: who, when, the words searched, and each memory version
          shown.
          <a href="/projects/${projectId}/retrievals">Search log</a>
        </p>
        ${searchForm(projectId, query)}
      </section>
      ${outcome}`,
  });
}

function returned(record: RetrievalRecord): SafeHtml {
  if (record.failed) {
    return html`${badge("failed", "danger")} nothing was searched`;
  }
  if (record.items.length === 0) {
    return html`<span class="muted">nothing you can read now</span>`;
  }
  return html`<ul class="plain">
    ${record.items.map(
      (item) =>
        html`<li>
          <a href="/memories/${item.memoryId}">${item.title}</a>
          <small>version ${item.revision}</small>
          ${item.status === "approved" ? "" : memoryStatusBadge(item.status)}
        </li>`,
    )}
  </ul>`;
}

async function logPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const view = await loadProject(rc, rc.params.id);
  const projectId = view.project.id;
  const records = await listRetrievals(rc.ctx, user.id, { projectId });
  const everyone =
    user.kind === "human" &&
    rankOf(view.project.role) >= ROLE_RANK.administrator;
  const names = await namesFor(
    rc,
    records.map((record) => record.callerId),
  );
  return page(rc, {
    title: `Search log: ${view.project.name}`,
    crumbs: projectCrumbs(view),
    body: html`<p class="hint">
        ${everyone ? "Everyone's searches" : "Your searches"} in this project,
        newest first, up to 200: who, when, the words searched, and each memory
        version shown. Words are stored as the search reads them (word stems,
        without very common words), and not at all when the search may have held
        personal data. Memories you cannot read now are left out.
      </p>
      <p><a href="/projects/${projectId}/search">Search this project</a></p>
      ${records.length === 0
        ? html`<p class="empty">No searches recorded here yet.</p>`
        : html`<ul class="ledger">
            ${records.map((record) => ledgerRow({
              href: `/projects/${projectId}/search`,
              title: html`<span id="r-${record.id}">${formatTime(record.retrievedAt)}</span>`,
              meta: html`${nameOf(names, record.callerId)} · ${record.terms === null ? "not recorded" : termWords(record.terms)}`,
              trailing: returned(record),
            }))}
          </ul>`}`,
  });
}

const ID = "(?<id>[^/]+)";

export const searchRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: new RegExp(`^/projects/${ID}/search$`),
    access: "user",
    handle: searchPage,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/projects/${ID}/retrievals$`),
    access: "user",
    handle: logPage,
  },
];
