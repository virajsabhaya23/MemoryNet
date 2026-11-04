import { hasFreshRepositoryAccess, type ScopeRef } from "../../access.ts";
import { accessFreshSince } from "../../context.ts";
import { ValidationError } from "../../errors.ts";
import { exportKnowledge } from "../../export.ts";
import {
  EXCERPT_MAX_LENGTH,
  getSource,
  listProposals,
  MEMORY_TYPES,
  proposeMemory,
  recordSource,
  type Memory,
  type MemoryType,
  type ProposalStatus,
  type Source,
  type DecisionApplicability,
  type DecisionApplicabilityInput,
} from "../../knowledge.ts";
import { listProjectPeople } from "../../members.ts";
import { listConnectedRepositories } from "../../repositories.ts";
import {
  badge,
  externalLink,
  html,
  ledgerRow,
  options,
  preview,
  recordHead,
  table,
  type SafeHtml,
} from "../html.ts";
import {
  formValue,
  page,
  postForm,
  redirect,
  requireUser,
  SECURITY_HEADERS,
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
  routeScope,
  shortSha,
  typeLabel,
} from "../views.ts";
import { LEVEL_LABEL } from "./sign-in.ts";
import { relationFields, relationsFromForm } from "../relations-view.ts";

export const TYPE_HINTS: Readonly<Record<MemoryType, string>> = {
  decision: "decision: what was chosen",
  rationale: "rationale: the reason behind a choice",
  constraint: "constraint: a limit that must be respected",
  lesson: "lesson: something learned",
  failed_approach: "failed approach: something tried that did not work",
  incident: "incident: something that went wrong",
};

const STATUS_VARIANT: Readonly<Record<ProposalStatus, string>> = {
  pending: "warn",
  approved: "ok",
  rejected: "danger",
};

export function proposalStatusBadge(status: ProposalStatus): SafeHtml {
  return badge(status, STATUS_VARIANT[status]);
}

/** Scope is reviewed metadata, never inferred from a source or from the model. */
export async function applicabilityFields(
  rc: RequestContext,
  projectId: string,
  settings: { required?: boolean; value?: DecisionApplicability | null } = {},
): Promise<SafeHtml> {
  const user = requireUser(rc);
  const connected = await listConnectedRepositories(rc.ctx, user.id, projectId);
  const checks = await Promise.all(connected.map(async (repository) => ({ repository,
    allowed: await hasFreshRepositoryAccess(rc.ctx.db, user.id, repository.provider,
      repository.externalRepositoryId, accessFreshSince(rc.ctx)),
  })));
  const repositories = checks.filter((item) => item.allowed).map((item) => item.repository);
  const initial = settings.value;
  const field = (name: string, fallback: string) => rc.form.has(name) ? rc.form.get(name) ?? "" : fallback;
  const required = settings.required === true;
  return html`<fieldset>
    <legend>Reviewed applicability${required ? " (required)" : " (optional for legacy project-only memory)"}</legend>
    <p class="hint">Choose the exact repository, branch and UTC interval this decision governs.
      These fields are part of the proposal version a human approves; evidence does not set them automatically.</p>
    <label>Repository
      <select name="appRepositoryId" ${required ? html`required` : ""}>
        <option value="">${required ? "Choose a readable repository" : "No reviewed applicability (legacy)"}</option>
        ${options(repositories.map((repository) => ({ value: repository.externalRepositoryId,
          label: `${repository.fullName} (${repository.externalRepositoryId})` })), field("appRepositoryId", initial?.repositoryId ?? ""))}
      </select></label>
    <label>Exact branch
      <input name="appBranch" maxlength="255" placeholder="main" value="${field("appBranch", initial?.branch ?? "")}"
        ${required ? html`required` : ""} /></label>
    <label>Valid from (UTC, inclusive)
      <input name="appValidFrom" placeholder="2026-10-30T00:00:00.000Z" maxlength="40"
        value="${field("appValidFrom", initial ? utc(initial.validFrom) : required ? rc.ctx.now().toISOString() : "")}"
        ${required ? html`required` : ""} /></label>
    <label>Valid until (UTC, exclusive; optional)
      <input name="appValidUntil" placeholder="No end date" maxlength="40"
        value="${field("appValidUntil", initial?.validUntil ? utc(initial.validUntil) : "")}" /></label>
    <p class="hint">Use ISO timestamps ending in Z. Branches are exact, with no wildcard expansion.
      A different branch or validity interval needs a new decision, not replacement of a differently scoped one.</p>
  </fieldset>`;
}

function utc(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function isExactUtcTimestamp(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
}

export function applicabilityFromForm(rc: RequestContext, required = false): DecisionApplicabilityInput | undefined {
  const names = ["appRepositoryId", "appBranch", "appValidFrom", "appValidUntil"];
  if (names.some((name) => rc.form.getAll(name).length > 1)) throw new ValidationError("Submit one value for each applicability field");
  const [repositoryId, branch, validFrom, validUntil] = names.map((name) => rc.form.get(name)?.trim() ?? "");
  if (!required && !repositoryId && !branch && !validFrom && !validUntil) return undefined;
  if (!repositoryId || !branch || !validFrom) throw new ValidationError("Choose a repository, exact branch and UTC valid-from time");
  if (![validFrom, ...(validUntil ? [validUntil] : [])].every(isExactUtcTimestamp)) {
    throw new ValidationError("Applicability times must be valid ISO timestamps ending in Z (UTC)");
  }
  return { repositoryId, branch, validFrom, validUntil: validUntil || null };
}

export function applicabilityView(value: DecisionApplicability | null | undefined, now?: Date, proposed = false): SafeHtml {
  if (!value) return html`<section><h2>Applicability</h2>
    <p>${badge("Legacy: no reviewed applicability", "warn")}</p>
    <p class="hint">No repository, branch or validity interval has been approved for this record.
      It remains project-only and is excluded from scoped agent context.</p></section>`;
  const from = utc(value.validFrom);
  const until = value.validUntil ? utc(value.validUntil) : null;
  const outside = now && (now.getTime() < Date.parse(from) || (until !== null && now.getTime() >= Date.parse(until)));
  return html`<section><h2>${proposed ? "Proposed applicability" : "Reviewed applicability"}</h2>
    <dl class="facts"><dt>GitHub repository ID</dt><dd><code>${value.repositoryId}</code></dd>
      <dt>Exact branch</dt><dd><code>${value.branch}</code></dd>
      <dt>Valid from (inclusive)</dt><dd><code>${from}</code></dd>
      <dt>Valid until (exclusive)</dt><dd>${until ? html`<code>${until}</code>` : "No end date"}</dd></dl>
    ${outside ? html`<p class="warning" role="note">This applicability interval is not active now.</p>` : ""}
    <p class="hint">${proposed ? "Human approval would apply" : "Approval applies"} only to this exact repository, branch and interval.</p>
  </section>`;
}

export function applicabilitySummary(value: DecisionApplicability | null | undefined): SafeHtml {
  if (!value) return badge("Legacy: no reviewed applicability", "warn");
  return html`Repository <code>${value.repositoryId}</code>, branch <code>${value.branch}</code>;
    from <code>${utc(value.validFrom)}</code> inclusive
    ${value.validUntil ? html`until <code>${utc(value.validUntil)}</code> exclusive` : "with no end date"}`;
}

export async function memoriesSection(
  rc: RequestContext,
  memories: readonly Memory[],
  heading = "Approved knowledge you can read",
  empty = "No approved knowledge you can read here.",
  hint?: string,
  id?: string,
): Promise<SafeHtml> {
  const names = await namesFor(
    rc,
    memories.map((memory) => memory.ownerId),
  );
  return html`<section${id ? html` id="${id}"` : ""}>
    <h2>${heading}</h2>
    ${hint === undefined ? "" : html`<p class="hint">${hint}</p>`}
    ${memories.length === 0
      ? html`<p class="empty">${empty}</p>`
      : html`<ul class="ledger">
          ${memories.map((memory) => ledgerRow({
            href: `/memories/${memory.id}`,
            title: memory.title,
            meta: html`${typeLabel(memory.type)} · ${nameOf(names, memory.ownerId)} · rev ${memory.revision} · approved ${memory.approvedAt}`,
            trailing: memoryStatusBadge(memory.status),
          }))}
        </ul>`}
  </section>`;
}

export async function proposalsSection(
  rc: RequestContext,
  projectId: string,
): Promise<SafeHtml> {
  const user = requireUser(rc);
  const proposals = await listProposals(rc.ctx, user.id, {
    scope: { level: "project", id: projectId },
    limit: 200,
  });
  const names = await namesFor(
    rc,
    proposals.map((proposal) => proposal.proposedBy),
  );
  return html`<section>
    <h2>Proposals</h2>
    <p class="hint">
      Proposals are not knowledge. Only contributors and above can see them, and
      a different reviewer must approve each one.
    </p>
    ${proposals.length === 0
      ? html`<p class="empty">No proposals here.</p>`
      : html`<ul class="ledger">
          ${proposals.map((proposal) => ledgerRow({
            href: `/proposals/${proposal.id}`,
            title: html`${proposal.title} ${flagBadges(proposal.flags)}`,
            meta: html`${typeLabel(proposal.type)} · proposed by ${nameOf(names, proposal.proposedBy)} · ${proposal.proposedAt}`,
            trailing: proposalStatusBadge(proposal.status),
          }))}
        </ul>`}
  </section>`;
}

export function sourcesSection(sources: readonly Source[]): SafeHtml {
  return html`<section id="evidence">
    <h2>Sources you can read</h2>
    <p class="hint">Sources are raw evidence, not knowledge.</p>
    ${sources.length === 0
      ? html`<p class="empty">No sources you can read here.</p>`
      : html`<ul class="ledger">
          ${sources.map((source) => ledgerRow({
            href: `/sources/${source.id}`,
            title: html`${source.reference} ${flagBadges(source.flags)}`,
            meta: preview(source.excerpt),
            trailing: html`${source.capturedAt}`,
          }))}
        </ul>`}
  </section>`;
}

export async function recordSourceSection(
  rc: RequestContext,
  projectId: string,
): Promise<SafeHtml> {
  const user = requireUser(rc);
  const repositories = await listConnectedRepositories(
    rc.ctx,
    user.id,
    projectId,
  );
  if (repositories.length === 0) {
    return html`<section id="record-evidence">
      <h2>Record pull request evidence</h2>
      <p class="empty">No repository is connected to this project yet.</p>
    </section>`;
  }
  return html`<section id="record-evidence">
    <h2>Record pull request evidence</h2>
    <p class="hint">
      Only pull requests are supported for now. Text that looks like a secret is
      refused.
    </p>
    ${postForm(
      rc,
      `/projects/${projectId}/sources`,
      html`<label
          >Repository
          <select name="externalRepositoryId" required>
            ${options(
              repositories.map((repository) => ({
                value: repository.externalRepositoryId,
                label: repository.fullName,
              })),
            )}
          </select></label
        >
        <label
          >Pull request number
          <input
            name="pullRequest"
            required
            inputmode="numeric"
            pattern="[1-9][0-9]*"
        /></label>
        <label
          >Link (optional; defaults to the pull request)
          <input
            name="url"
            type="url"
            placeholder="https://github.com/…/pull/42"
        /></label>
        <label
          >Commit SHA (optional)
          <input name="revision" pattern="[0-9a-f]{7,64}"
        /></label>
        <label
          >Excerpt
          <textarea
            name="excerpt"
            required
            maxlength="${EXCERPT_MAX_LENGTH}"
          ></textarea>
        </label>`,
      "Record evidence",
      "stacked",
    )}
  </section>`;
}

export async function proposeSection(
  rc: RequestContext,
  projectId: string,
  sources: readonly Source[],
): Promise<SafeHtml> {
  const user = requireUser(rc);
  if (sources.length === 0) {
    return html`<section id="propose-memory">
      <h2>Propose a memory</h2>
      <p class="empty">Record evidence first: every proposal cites a source.</p>
    </section>`;
  }
  const people = await listProjectPeople(rc.ctx, user.id, projectId);
  const owners = people.map((person) => ({
    value: person.id,
    label: `${person.displayName} (${person.role})`,
  }));
  const applicability = await applicabilityFields(rc, projectId);
  const relations = await relationFields(rc, projectId);
  return html`<section id="propose-memory">
    <h2>Propose a memory</h2>
    ${postForm(
      rc,
      `/projects/${projectId}/proposals`,
      html`<label
          >Type
          <select name="type">
            ${options(
              MEMORY_TYPES.map((type) => ({
                value: type,
                label: TYPE_HINTS[type],
              })),
            )}
          </select></label
        >
        <label>Title <input name="title" required maxlength="200" /></label>
        <label
          >What should people know?
          <textarea name="content" required maxlength="10000"></textarea>
        </label>
        <fieldset>
          <legend>Evidence (choose at least one)</legend>
          ${sources.map(
            (source) =>
              html`<label class="choice">
                <input
                  type="checkbox"
                  name="evidenceSourceIds"
                  value="${source.id}"
                />
                <strong>${source.reference}</strong>
                <span class="muted">${preview(source.excerpt, 90)}</span>
              </label>`,
          )}
        </fieldset>
        ${applicability}
        ${relations}
        <label
          >Owner, the person accountable for keeping it correct
          <select name="ownerId" ${user.kind === "agent" ? html`required` : ""}>
            ${user.kind === "human" ? html`<option value="">Me</option>` : ""}
            ${options(owners)}
          </select></label
        >`,
      "Propose",
      "stacked",
    )}
  </section>`;
}

export function exportForm(rc: RequestContext, scope: ScopeRef): SafeHtml {
  return html`<section>
    <h2>Export approved knowledge</h2>
    <p class="hint">
      Downloads the approved memories you can read in this
      ${LEVEL_LABEL[scope.level]} as plain JSON, with their sources. Proposals,
      roles, and repository access are left out. Treat the file as confidential.
    </p>
    ${postForm(
      rc,
      `/scopes/${scope.level}/${scope.id}/export`,
      "",
      "Download export",
    )}
  </section>`;
}

async function sourcePage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const source = await getSource(rc.ctx, user.id, rc.params.id ?? "");
  const view = await loadProject(rc, source.projectId);
  const names = await namesFor(rc, [source.capturedBy]);
  return page(rc, {
    title: `Source ${source.reference}`,
    crumbs: projectCrumbs(view),
    body: html`${recordHead({
        kind: "Source",
        title: source.reference,
        status: flagBadges(source.flags),
        meta: html`Repository ${source.externalRepositoryId} · Captured ${source.captureMethod === "github_app" ? "by the GitHub App" : `by ${nameOf(names, source.capturedBy)}`} on ${source.capturedAt}`,
        actions: externalLink(source.url, source.url),
      })}
      <p class="hint">A source is raw evidence, not knowledge.</p>
      <section>
        <h2>Excerpt</h2>
        <blockquote>${source.excerpt}</blockquote>
      </section>
      <section>
        <h2>Record</h2>
        <dl class="facts">
          <dt>Source ID</dt>
          <dd><code>${source.id}</code></dd>
          <dt>Repository ID</dt>
          <dd>${source.externalRepositoryId}</dd>
          <dt>Commit</dt>
          <dd>${shortSha(source.revision)}</dd>
          <dt>Captured</dt>
          <dd>
            ${source.captureMethod === "github_app"
              ? "by the GitHub App"
              : `by ${nameOf(names, source.capturedBy)}`}
            on ${source.capturedAt}
          </dd>
        </dl>
      </section>`,
  });
}

async function recordSourceAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const projectId = rc.params.id ?? "";
  const pull = formValue(rc, "pullRequest")?.trim() ?? "";
  if (!/^[1-9][0-9]{0,9}$/.test(pull)) {
    throw new ValidationError(
      "Pull request number must be a whole number, such as 42",
    );
  }
  const externalRepositoryId = formValue(rc, "externalRepositoryId") ?? "";
  const repositories = await listConnectedRepositories(
    rc.ctx,
    user.id,
    projectId,
  );
  const repository = repositories.find(
    (item) => item.externalRepositoryId === externalRepositoryId,
  );
  const revision = formValue(rc, "revision");
  const source = await recordSource(rc.ctx, user.id, {
    projectId,
    provider: "github",
    externalRepositoryId,
    reference: `pull/${pull}`,
    url:
      formValue(rc, "url") ??
      (repository
        ? `https://github.com/${repository.fullName}/pull/${pull}`
        : ""),
    excerpt: formValue(rc, "excerpt") ?? "",
    ...(revision === undefined ? {} : { revision }),
  });
  return redirect(`/sources/${source.id}`, "source-recorded");
}

async function proposeAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const evidenceSourceIds = rc.form.getAll("evidenceSourceIds");
  if (evidenceSourceIds.length === 0) {
    throw new ValidationError("Choose at least one source as evidence");
  }
  const ownerId = formValue(rc, "ownerId");
  const applicability = applicabilityFromForm(rc);
  const relations = relationsFromForm(rc);
  const proposal = await proposeMemory(rc.ctx, user.id, {
    projectId: rc.params.id ?? "",
    type: (formValue(rc, "type") ?? "") as MemoryType,
    title: formValue(rc, "title") ?? "",
    content: formValue(rc, "content") ?? "",
    evidenceSourceIds,
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(applicability === undefined ? {} : { applicability }),
    ...(relations === undefined ? {} : { relations }),
  });
  return user.kind === "agent"
    ? redirect(`/projects/${proposal.projectId}`, "proposed-by-agent")
    : redirect(`/proposals/${proposal.id}`, "proposed");
}

async function exportAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const scope = routeScope(rc);
  const data = await exportKnowledge(rc.ctx, user.id, { scope });
  const day = data.exportedAt.slice(0, 10);
  return {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="memorynet-export-${data.organization.slug}-${day}.json"`,
    },
    body: `${JSON.stringify(data, null, 2)}\n`,
  };
}

const ID = "(?<id>[^/]+)";
const LEVEL = "(?<level>organization|business_unit|project)";

export const knowledgeRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: new RegExp(`^/sources/${ID}$`),
    access: "user",
    handle: sourcePage,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/projects/${ID}/sources$`),
    access: "user",
    handle: recordSourceAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/projects/${ID}/proposals$`),
    access: "user",
    handle: proposeAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/scopes/${LEVEL}/${ID}/export$`),
    access: "user",
    handle: exportAction,
  },
];
