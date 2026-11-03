import { diffLines } from "../../diff.ts";
import { ValidationError } from "../../errors.ts";
import {
  dismissReport,
  getMemoryHistory,
  reinstateMemory,
  reportOutdated,
  suspendMemory,
  revokeMemory,
  type MemoryHistory,
  type MemoryVersion,
} from "../../history.ts";
import {
  listSources,
  MEMORY_TYPES,
  proposeChange,
  proposeRestore,
  type ChangeKind,
  type MemoryType,
} from "../../knowledge.ts";
import { listProjectPeople } from "../../members.ts";
import { ROLE_RANK } from "../../roles.ts";
import {
  badge,
  html,
  options,
  preview,
  table,
  type SafeHtml,
} from "../html.ts";
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
import {
  evidenceList,
  loadProject,
  memoryStatusBadge,
  nameOf,
  namesFor,
  projectCrumbs,
  rankOf,
  REASON_INPUT,
  typeLabel,
  type Names,
  type ProjectView,
} from "../views.ts";
import { applicabilityFromForm, applicabilityView, proposalStatusBadge, TYPE_HINTS } from "./knowledge.ts";

/** How a version came about, in plain words. */
export function versionLabel(version: {
  changeKind: ChangeKind;
  restoredFromRevision: number | null;
}): string {
  if (version.changeKind === "revise") return "revised";
  if (version.changeKind === "restore") {
    return `restored from version ${version.restoredFromRevision ?? "?"}`;
  }
  if (version.changeKind === "replace") return "replacement";
  return "first version";
}

export function changeLabel(kind: ChangeKind): string {
  if (kind === "revise") return "new version";
  if (kind === "replace") return "replacement";
  if (kind === "restore") return "restore";
  return "new memory";
}

function revisionField(revision: number): SafeHtml {
  return html`<input
    type="hidden"
    name="expectedRevision"
    value="${revision}"
  />`;
}

function statusNotice(history: MemoryHistory, names: Names): SafeHtml {
  const { memory } = history;
  if (memory.status === "revoked") {
    return html`<p class="warning" role="note">
      Approval revoked on ${memory.statusChangedAt ?? ""} by
      ${nameOf(names, memory.statusChangedBy)}: ${memory.statusReason ?? ""}.
      This is not current guidance. Reauthorization requires a new reviewed revision or replacement;
      ordinary reinstatement is unavailable. Its history is retained.
    </p>`;
  }
  if (memory.status === "suspended") {
    return html`<p class="warning" role="note">
      Suspended on ${memory.statusChangedAt ?? ""} by
      ${nameOf(names, memory.statusChangedBy)}: ${memory.statusReason ?? ""}.
      This is not current guidance until a reviewer resolves it.
    </p>`;
  }
  if (memory.status === "superseded") {
    const next = history.replacedBy;
    return html`<p class="warning" role="note">
      Replaced on ${memory.statusChangedAt ?? ""} by
      ${next?.title
        ? html`<a href="/memories/${next.id}">${next.title}</a>`
        : "a memory you cannot read"}.
      This is not current guidance.
    </p>`;
  }
  return html``;
}

async function changeForm(
  rc: RequestContext,
  history: MemoryHistory,
  view: ProjectView,
): Promise<SafeHtml> {
  const user = requireUser(rc);
  const { memory } = history;
  const sources = await listSources(rc.ctx, user.id, {
    scope: { level: "project", id: memory.projectId },
    limit: 200,
  });
  const people = await listProjectPeople(rc.ctx, user.id, view.project.id);
  const cited = new Set(memory.evidence.map((item) => item.sourceId));
  return html`<details class="edit">
    <summary>Propose a change</summary>
    <p class="hint">
      Builds on version ${memory.revision}. Nothing changes until a different
      reviewer approves it.
    </p>
    ${postForm(
      rc,
      `/memories/${memory.id}/changes`,
      html`${revisionField(memory.revision)}
        ${applicabilityView(memory.applicability, rc.ctx.now())}
        <p class="hint">This change inherits the exact applicability above.
          A different repository, branch or interval requires a new decision.</p>
        <fieldset>
          <legend>Kind of change</legend>
          <label class="choice"
            ><input type="radio" name="kind" value="revise" checked /> A new
            version of this memory (keeps its ID)</label
          >
          <label class="choice"
            ><input type="radio" name="kind" value="replace" /> A new memory
            that replaces this one</label
          >
        </fieldset>
        <label
          >Type
          <select name="type">
            ${options(
              MEMORY_TYPES.map((type) => ({
                value: type,
                label: TYPE_HINTS[type],
              })),
              memory.type,
            )}
          </select></label
        >
        <label
          >Title
          <input name="title" required maxlength="200" value="${memory.title}"
        /></label>
        <label
          >Text
          <textarea name="content" required maxlength="10000">
${memory.content}</textarea
          >
        </label>
        <fieldset>
          <legend>Evidence (at least one)</legend>
          ${sources.map(
            (source) =>
              html`<label class="choice">
                <input
                  type="checkbox"
                  name="evidenceSourceIds"
                  value="${source.id}"
                  ${cited.has(source.id) ? html`checked` : ""}
                />
                <strong>${source.reference}</strong>
                <span class="muted">${preview(source.excerpt, 90)}</span>
              </label>`,
          )}
        </fieldset>
        <label
          >Owner
          <select name="ownerId" required>
            ${options(
              people.map((person) => ({
                value: person.id,
                label: `${person.displayName} (${person.role})`,
              })),
              memory.ownerId,
            )}
          </select></label
        >`,
      "Propose change",
      "stacked",
    )}
  </details>`;
}

async function memoryPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const history = await getMemoryHistory(rc.ctx, user.id, rc.params.id ?? "");
  const { memory } = history;
  const view = await loadProject(rc, memory.projectId);
  const openReports = history.reports.filter(
    (report) => report.resolvedAt === null,
  );
  const names = await namesFor(rc, [
    memory.ownerId,
    memory.proposedBy,
    memory.approvedBy,
    memory.statusChangedBy,
    ...history.pendingChanges.map((proposal) => proposal.proposedBy),
    ...openReports.map((report) => report.reportedBy),
  ]);
  const rank = rankOf(view.project.role);
  const human = user.kind === "human";
  const seesProposals = human && rank >= ROLE_RANK.contributor;
  const changeable = memory.status !== "superseded";
  const actions: SafeHtml[] = [];
  if (memory.status === "approved" || memory.status === "suspended") {
    actions.push(
      html`<section>
        <h2>Report as possibly outdated</h2>
        <p class="hint">
          A report changes nothing by itself. A person suspends, changes, or
          dismisses it.
        </p>
        ${postForm(rc, `/memories/${memory.id}/report`, REASON_INPUT, "Report")}
      </section>`,
    );
  }
  if (human && memory.status === "approved" && rank >= ROLE_RANK.contributor) {
    actions.push(
      html`<section>
        <h2>Suspend while disputed</h2>
        <p class="hint">
          It stops being current guidance until a reviewer resolves it.
        </p>
        ${postForm(
          rc,
          `/memories/${memory.id}/suspend`,
          html`${revisionField(memory.revision)} ${REASON_INPUT}`,
          "Suspend",
        )}
      </section>`,
    );
  }
  if (human && memory.status === "suspended" && rank >= ROLE_RANK.reviewer) {
    actions.push(
      html`<section>
        <h2>Resolve the suspension</h2>
        <p class="hint">
          Reinstate it unchanged, or propose a change below; approving a change
          also resolves it.
        </p>
        ${postForm(
          rc,
          `/memories/${memory.id}/reinstate`,
          html`${revisionField(memory.revision)} ${REASON_INPUT}`,
          "Reinstate",
        )}
      </section>`,
    );
  }
  if (human && (memory.status === "approved" || memory.status === "suspended") && rank >= ROLE_RANK.reviewer) {
    actions.push(html`<section><h2>Revoke approval</h2>
      <p class="hint">Withdraw authority for this exact decision version. Revoked guidance is excluded from current context.
        This differs from temporary suspension: restoring authority requires a new reviewed revision or replacement.</p>
      ${postForm(rc, `/memories/${memory.id}/revoke`, html`${revisionField(memory.revision)} ${REASON_INPUT}`, "Revoke approval")}
    </section>`);
  }
  const mayDismiss = human && rank >= ROLE_RANK.reviewer;
  return page(rc, {
    title: memory.title,
    crumbs: projectCrumbs(view),
    body: html`<p>
        ${memoryStatusBadge(memory.status)}
        ${badge(typeLabel(memory.type), "type")}
        <span class="muted">version ${memory.revision}</span>
        <a href="/memories/${memory.id}/history">History</a>
        ${memory.status === "approved"
          ? html`<a
              href="/orgs/${view.tree.organization
                .id}/network?node=${encodeURIComponent(`memory:${memory.id}`)}"
              >Show in the network</a
            >`
          : ""}
      </p>
      ${statusNotice(history, names)}
      ${applicabilityView(memory.applicability, rc.ctx.now())}
      <section>
        <h2>${memory.status === "revoked" ? "Historical decision" : "Knowledge"}</h2>
        <p class="content">${memory.content}</p>
      </section>
      <section>
        <h2>Evidence</h2>
        ${evidenceList(memory.evidence)}
      </section>
      <section>
        <h2>Record</h2>
        <dl class="facts">
          <dt>Memory ID</dt>
          <dd><code>${memory.id}</code> (never changes)</dd>
          <dt>Project</dt>
          <dd>
            <a href="/projects/${view.project.id}">${view.project.name}</a>
          </dd>
          <dt>Owner</dt>
          <dd>${nameOf(names, memory.ownerId)}</dd>
          <dt>Version ${memory.revision} proposed by</dt>
          <dd>${nameOf(names, memory.proposedBy)}</dd>
          <dt>Approved by</dt>
          <dd>${nameOf(names, memory.approvedBy)} on ${memory.approvedAt}</dd>
          <dt>Review record</dt>
          <dd>
            ${seesProposals
              ? html`<a href="/proposals/${memory.proposalId}">proposal</a>
                  (version ${memory.proposalRevision} approved)`
              : html`<span class="muted"
                  >visible to contributors and above</span
                >`}
          </dd>
        </dl>
      </section>
      ${seesProposals
        ? html`<section>
            <h2>Pending changes</h2>
            ${table(
              ["Proposal", "Kind", "Builds on", "Proposed by", "Status"],
              history.pendingChanges.map((proposal) => [
                html`<a href="/proposals/${proposal.id}">${proposal.title}</a>`,
                html`${changeLabel(proposal.changeKind)}`,
                proposal.baseRevision === memory.revision
                  ? html`version ${proposal.baseRevision}`
                  : html`${badge(
                      `version ${proposal.baseRevision ?? "?"}: outdated`,
                      "warn",
                    )}`,
                html`${nameOf(names, proposal.proposedBy)}`,
                proposalStatusBadge(proposal.status),
              ]),
              "No pending changes.",
            )}
          </section>`
        : ""}
      <section>
        <h2>Open reports</h2>
        ${table(
          ["Reported by", "Reason", "When", ""],
          openReports.map((report) => [
            html`${nameOf(names, report.reportedBy)}`,
            html`${report.reason}`,
            html`${report.reportedAt}`,
            mayDismiss
              ? postForm(
                  rc,
                  `/reports/${report.id}/dismiss`,
                  REASON_INPUT,
                  "Dismiss",
                )
              : html``,
          ]),
          "No open reports.",
        )}
      </section>
      ${actions}
      ${changeable && rank >= ROLE_RANK.contributor
        ? await changeForm(rc, history, view)
        : ""}`,
  });
}

function versionDiff(before: MemoryVersion, after: MemoryVersion): SafeHtml {
  if (!before.readable || !after.readable || before.content === after.content) {
    return html``;
  }
  return html`<details>
    <summary>Changes from version ${before.revision}</summary>
    <div class="diff" role="group" aria-label="Line changes">
      ${diffLines(before.content ?? "", after.content ?? "").map(
        (line) =>
          html`<div class="diff-${line.kind}">
            <span class="diff-mark" aria-hidden="true"
              >${line.kind === "added"
                ? "+"
                : line.kind === "removed"
                  ? "−"
                  : " "}</span
            >
            <span class="visually-hidden"
              >${line.kind === "same" ? "" : `${line.kind}:`}</span
            >
            <span class="diff-text">${line.text}</span>
          </div>`,
      )}
    </div>
  </details>`;
}

async function historyPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const history = await getMemoryHistory(rc.ctx, user.id, rc.params.id ?? "");
  const { memory } = history;
  const view = await loadProject(rc, memory.projectId);
  const names = await namesFor(rc, [
    ...history.versions.map((version) => version.approvedBy),
    ...history.statusChanges.map((change) => change.changedBy),
    ...history.reports.flatMap((report) => [
      report.reportedBy,
      report.resolvedBy,
    ]),
  ]);
  const rank = rankOf(view.project.role);
  const seesProposals = user.kind === "human" && rank >= ROLE_RANK.contributor;
  const mayRestore =
    rank >= ROLE_RANK.contributor && memory.status !== "superseded";
  const versions = [...history.versions].reverse();
  return page(rc, {
    title: `History: ${memory.title}`,
    crumbs: [...projectCrumbs(view), [memory.title, `/memories/${memory.id}`]],
    body: html`<p>
        Now ${memoryStatusBadge(memory.status)} at version ${memory.revision}.
        Every version stays here; old versions are never served as current.
      </p>
      <section>
        <h2>Versions, newest first</h2>
        ${versions.map((version, index) => {
          const previous = versions[index + 1];
          return html`<article class="version">
            <h3>
              Version ${version.revision}
              ${badge(versionLabel(version), "type")}
              ${version.revision === memory.revision
                ? memoryStatusBadge(memory.status)
                : ""}
            </h3>
            <p class="muted">
              Approved by ${nameOf(names, version.approvedBy)} on
              ${version.approvedAt}
              ${seesProposals
                ? html`·
                    <a href="/proposals/${version.proposalId}"
                      >review record</a
                    >`
                : ""}
            </p>
            ${version.readable
              ? html`<p><strong>${version.title}</strong></p>
                  <p class="content">${version.content}</p>
                  ${applicabilityView(version.applicability, undefined)}
                  <p class="muted">
                    Evidence:
                    ${version.evidence.map((item) => item.reference).join(", ")}
                  </p>`
              : html`<p class="muted">
                  Hidden: this version cites a source you cannot read.
                </p>`}
            ${previous ? versionDiff(previous, version) : ""}
            ${mayRestore &&
            version.readable &&
            version.revision < memory.revision
              ? postForm(
                  rc,
                  `/memories/${memory.id}/restore`,
                  html`${revisionField(memory.revision)}
                    <input
                      type="hidden"
                      name="fromRevision"
                      value="${version.revision}"
                    />`,
                  `Propose restoring version ${version.revision}`,
                )
              : ""}
          </article>`;
        })}
      </section>
      <section>
        <h2>Status changes</h2>
        ${table(
          ["When", "Change", "By", "Reason", "At version"],
          history.statusChanges.map((change) => [
            html`${change.changedAt}`,
            html`${memoryStatusBadge(change.from)} →
            ${memoryStatusBadge(change.to)}`,
            html`${nameOf(names, change.changedBy)}`,
            html`${change.reason ?? ""}`,
            html`${change.revision}`,
          ]),
          "None: it has stayed current.",
        )}
      </section>
      <section>
        <h2>Replacements</h2>
        <ul>
          ${history.replacedBy
            ? html`<li>
                Replaced by
                ${history.replacedBy.title
                  ? html`<a href="/memories/${history.replacedBy.id}"
                      >${history.replacedBy.title}</a
                    >`
                  : "a memory you cannot read"}
              </li>`
            : ""}
          ${history.replaces.map(
            (item) =>
              html`<li>
                Replaces
                ${item.title
                  ? html`<a href="/memories/${item.id}">${item.title}</a>`
                  : "a memory you cannot read"}
              </li>`,
          )}
        </ul>
        ${history.replacedBy === null && history.replaces.length === 0
          ? html`<p class="empty">No replacements.</p>`
          : ""}
      </section>
      <section>
        <h2>Reports</h2>
        ${table(
          ["Reported by", "Reason", "When", "Outcome"],
          history.reports.map((report) => [
            html`${nameOf(names, report.reportedBy)}`,
            html`${report.reason}`,
            html`${report.reportedAt}`,
            report.resolution === null
              ? badge("open", "warn")
              : html`${report.resolution}
                ${report.resolutionNote ? `: ${report.resolutionNote}` : ""}`,
          ]),
          "No reports.",
        )}
      </section>`,
  });
}

function expectedRevision(rc: RequestContext): number {
  return Number(formValue(rc, "expectedRevision") ?? "");
}

async function changeAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const evidenceSourceIds = rc.form.getAll("evidenceSourceIds");
  if (evidenceSourceIds.length === 0) {
    throw new ValidationError("Choose at least one source as evidence");
  }
  const ownerId = formValue(rc, "ownerId");
  const applicability = applicabilityFromForm(rc);
  const proposal = await proposeChange(rc.ctx, user.id, {
    memoryId: rc.params.id ?? "",
    expectedRevision: expectedRevision(rc),
    kind: (formValue(rc, "kind") ?? "") as "revise" | "replace",
    type: (formValue(rc, "type") ?? "") as MemoryType,
    title: formValue(rc, "title") ?? "",
    content: formValue(rc, "content") ?? "",
    evidenceSourceIds,
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(applicability === undefined ? {} : { applicability }),
  });
  return user.kind === "agent"
    ? redirect(`/memories/${rc.params.id ?? ""}`, "proposed-by-agent")
    : redirect(`/proposals/${proposal.id}`, "change-proposed");
}

async function restoreAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const proposal = await proposeRestore(rc.ctx, user.id, {
    memoryId: rc.params.id ?? "",
    expectedRevision: expectedRevision(rc),
    fromRevision: Number(formValue(rc, "fromRevision") ?? ""),
  });
  return user.kind === "agent"
    ? redirect(`/memories/${rc.params.id ?? ""}`, "proposed-by-agent")
    : redirect(`/proposals/${proposal.id}`, "change-proposed");
}

async function suspendAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const memory = await suspendMemory(rc.ctx, user.id, {
    memoryId: rc.params.id ?? "",
    expectedRevision: expectedRevision(rc),
    reason: formValue(rc, "reason") ?? "",
  });
  return redirect(`/memories/${memory.id}`, "suspended");
}

async function reinstateAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const memory = await reinstateMemory(rc.ctx, user.id, {
    memoryId: rc.params.id ?? "",
    expectedRevision: expectedRevision(rc),
    reason: formValue(rc, "reason") ?? "",
  });
  return redirect(`/memories/${memory.id}`, "reinstated");
}

async function revokeAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  if (rc.form.getAll("expectedRevision").length !== 1 || rc.form.getAll("reason").length !== 1) {
    throw new ValidationError("Submit one decision version and one revocation reason");
  }
  const memory = await revokeMemory(rc.ctx, user.id, {
    memoryId: rc.params.id ?? "", expectedRevision: expectedRevision(rc), reason: formValue(rc, "reason") ?? "",
  });
  return redirect(`/memories/${memory.id}`);
}

async function reportAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const report = await reportOutdated(rc.ctx, user.id, {
    memoryId: rc.params.id ?? "",
    reason: formValue(rc, "reason") ?? "",
  });
  return redirect(`/memories/${report.memoryId}`, "reported");
}

async function dismissAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const report = await dismissReport(rc.ctx, user.id, {
    reportId: rc.params.id ?? "",
    reason: formValue(rc, "reason") ?? "",
  });
  return redirect(`/memories/${report.memoryId}`, "report-dismissed");
}

const ID = "(?<id>[^/]+)";

export const memoryRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: new RegExp(`^/memories/${ID}$`),
    access: "user",
    handle: memoryPage,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/memories/${ID}/history$`),
    access: "user",
    handle: historyPage,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/memories/${ID}/changes$`),
    access: "user",
    handle: changeAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/memories/${ID}/restore$`),
    access: "user",
    handle: restoreAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/memories/${ID}/suspend$`),
    access: "user",
    handle: suspendAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/memories/${ID}/reinstate$`),
    access: "user",
    handle: reinstateAction,
  },
  { method: "POST", pattern: new RegExp(`^/memories/${ID}/revoke$`), access: "user", handle: revokeAction },
  {
    method: "POST",
    pattern: new RegExp(`^/memories/${ID}/report$`),
    access: "user",
    handle: reportAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/reports/${ID}/dismiss$`),
    access: "user",
    handle: dismissAction,
  },
];
