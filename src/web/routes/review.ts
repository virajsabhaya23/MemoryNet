import { buildCheckSummary } from "../../checks.ts";
import { getGuardProposalProvenance } from "../../decision-guard/workflow.ts";
import { diffLines } from "../../diff.ts";
import {
  MemoryNetError,
  NotFoundError,
  ValidationError,
} from "../../errors.ts";
import {
  approveProposal,
  editProposal,
  getMemory,
  getProposal,
  getProposalHistory,
  listProposals,
  listReviewQueue,
  listSources,
  MEMORY_TYPES,
  rejectProposal,
  type Memory,
  type MemoryType,
  type Proposal,
  type ProposalVersion,
} from "../../knowledge.ts";
import { listProjectPeople } from "../../members.ts";
import { describeProjects } from "../../organizations.ts";
import { ROLE_RANK } from "../../roles.ts";
import { listRetrievals, type RetrievalRecord } from "../../retrieval.ts";
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
import { knownRepositories, repositoryOptions } from "../system-kit.ts";
import {
  evidenceList,
  flagBadges,
  loadProject,
  memoryStatusBadge,
  nameOf,
  namesFor,
  projectCrumbs,
  rankOf,
  typeLabel,
} from "../views.ts";
import { applicabilityFields, applicabilityFromForm, applicabilitySummary, applicabilityView, proposalStatusBadge, TYPE_HINTS } from "./knowledge.ts";
import { changeLabel } from "./memories.ts";

const DIFF_MARK = { added: "+", removed: "−", same: " " } as const;

/** Receipts describe delivery only; they never stand in for a coding result. */
function decisionInspector(
  proposal: Proposal,
  target: Memory | null,
  receipts: readonly RetrievalRecord[],
): SafeHtml {
  const relatedIds = new Set([proposal.targetMemoryId, proposal.memoryId].filter((id): id is string => id !== null));
  const delivered = receipts.flatMap((receipt) => receipt.failed ? [] : receipt.items
    .filter((item) => relatedIds.has(item.memoryId) && item.status === "approved")
    .map((item) => ({ receipt, item })));
  return html`<section aria-label="Decision-change inspector">
    <h2>Decision-change inspector</h2>
    <p>${proposalStatusBadge(proposal.status)} · proposal version ${proposal.revision}
      · ${badge(changeLabel(proposal.changeKind), "type")}</p>
    <div class="review-grid">
      ${target ? html`<section>
        <h3>Existing decision, version ${target.revision}</h3>
        <p><a href="/memories/${target.id}">${target.title}</a> · ${memoryStatusBadge(target.status)}</p>
        <p class="content">${target.content}</p>
        <p>${applicabilitySummary(target.applicability)}</p>
        <details><summary>Existing evidence</summary>${evidenceList(target.evidence)}</details>
      </section>` : html`<section><h3>Existing decision</h3>
        <p class="muted">${proposal.targetMemoryId === null
          ? "This proposes a new memory; no existing decision is selected for replacement."
          : "The target decision is not readable by you."}</p></section>`}
      <section>
        <h3>Proposed text, version ${proposal.revision}</h3>
        <p class="content">${proposal.content}</p>
        <p>${applicabilitySummary(proposal.applicability)}</p>
        <h3>Evidence for review</h3>
        ${evidenceList(proposal.evidence)}
      </section>
    </div>
    <h3>Authority</h3>
    <p>${proposal.status === "pending"
      ? "This pending proposal supplies no current agent guidance. An authorized human must approve this exact version and applicability."
      : proposal.status === "rejected"
        ? "This proposal was rejected and publishes no guidance."
        : "This proposal was approved. The published memory's present status, applicability and access permissions determine whether it can be delivered now."}</p>
    <h3>Recorded context deliveries</h3>
    ${table(["Receipt", "Delivered memory version", "Repository and branch", "Retrieved at"], delivered.map(({ receipt, item }) => [
      html`<code>${receipt.id}</code>`,
      html`<a href="/memories/${item.memoryId}">${item.title}</a> · version ${item.revision} · approved at retrieval`,
      receipt.applicability ? html`<code>${receipt.applicability.repositoryId}</code> / <code>${receipt.applicability.branch}</code>` : html`Project-only retrieval`,
      html`${receipt.retrievedAt}`,
    ]), "No matching delivery receipt is visible to you in the latest 200 permitted retrievals.")}
    <p class="hint">Only receipts and memory versions you may read are shown. A receipt records context returned at that time;
      it does not show that an agent followed it or that generated code passed a test.</p>
    <h3>Code outcome</h3>
    <p class="muted">No executable coding result is attached to this proposal. Review a separately retained agent artifact and test result before judging code compliance.</p>
  </section>`;
}

function diffView(before: string, after: string): SafeHtml {
  return html`<div class="diff" role="group" aria-label="Line changes">
    ${diffLines(before, after).map(
      (line) =>
        html`<div class="diff-${line.kind}">
          <span class="diff-mark" aria-hidden="true"
            >${DIFF_MARK[line.kind]}</span
          >
          <span class="visually-hidden"
            >${line.kind === "same" ? "" : `${line.kind}:`}</span
          >
          <span class="diff-text">${line.text}</span>
        </div>`,
    )}
  </div>`;
}

/** What changed between two readable versions, field by field, then line by line. */
function changesView(
  before: ProposalVersion,
  after: ProposalVersion,
  names: Map<string, { displayName: string; kind: "human" | "agent" }>,
  references: Map<string, string>,
): SafeHtml {
  const facts: SafeHtml[] = [];
  if (before.title !== after.title) {
    facts.push(html`<li>Title: “${before.title}” → “${after.title}”</li>`);
  }
  if (before.type !== after.type) {
    facts.push(
      html`<li>
        Type: ${typeLabel(before.type ?? "")} → ${typeLabel(after.type ?? "")}
      </li>`,
    );
  }
  if (before.ownerId !== after.ownerId) {
    facts.push(
      html`<li>
        Owner: ${nameOf(names, before.ownerId)} →
        ${nameOf(names, after.ownerId)}
      </li>`,
    );
  }
  if (JSON.stringify(before.applicability) !== JSON.stringify(after.applicability)) {
    facts.push(html`<li>Applicability: ${applicabilitySummary(before.applicability)} → ${applicabilitySummary(after.applicability)}</li>`);
  }
  const label = (id: string) => references.get(id) ?? "a source";
  const added = after.evidenceSourceIds.filter(
    (id) => !before.evidenceSourceIds.includes(id),
  );
  const removed = before.evidenceSourceIds.filter(
    (id) => !after.evidenceSourceIds.includes(id),
  );
  if (added.length > 0)
    facts.push(html`<li>Evidence added: ${added.map(label).join(", ")}</li>`);
  if (removed.length > 0) {
    facts.push(
      html`<li>Evidence removed: ${removed.map(label).join(", ")}</li>`,
    );
  }
  return html`<section>
    <h2>Changes in version ${after.revision}</h2>
    ${facts.length > 0
      ? html`<ul>
          ${facts}
        </ul>`
      : ""}
    ${before.content === after.content
      ? html`<p class="muted">The text did not change.</p>`
      : diffView(before.content ?? "", after.content ?? "")}
  </section>`;
}

function editForm(
  rc: RequestContext,
  proposal: Proposal,
  sources: Awaited<ReturnType<typeof listSources>>,
  people: Awaited<ReturnType<typeof listProjectPeople>>,
  scopeFields: SafeHtml,
): SafeHtml {
  const cited = new Set(proposal.evidence.map((item) => item.sourceId));
  return html`<details class="edit">
    <summary>Edit this proposal</summary>
    <p class="hint">
      Saves version ${proposal.revision + 1}. If you edit it, you can no longer
      review it.
    </p>
    ${postForm(
      rc,
      `/proposals/${proposal.id}/edit`,
      html`<input
          type="hidden"
          name="expectedRevision"
          value="${proposal.revision}"
        />
        <label
          >Type
          <select name="type">
            ${options(
              MEMORY_TYPES.map((type) => ({
                value: type,
                label: TYPE_HINTS[type],
              })),
              proposal.type,
            )}
          </select></label
        >
        <label
          >Title
          <input
            name="title"
            required
            maxlength="200"
            value="${proposal.title}"
        /></label>
        <label
          >Text
          <textarea name="content" required maxlength="10000">
${proposal.content}</textarea
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
        ${scopeFields}
        <label
          >Owner
          <select name="ownerId" required>
            ${options(
              people.map((person) => ({
                value: person.id,
                label: `${person.displayName} (${person.role})`,
              })),
              proposal.ownerId,
            )}
          </select></label
        >
        <label
          >What changed (optional) <input name="changeNote" maxlength="500"
        /></label>`,
      "Save new version",
      "stacked",
    )}
  </details>`;
}

/** Saves the same content as a new version that builds on the memory's latest version. */
function rebaseForm(
  rc: RequestContext,
  proposal: Proposal,
  latest: number,
): SafeHtml {
  return postForm(
    rc,
    `/proposals/${proposal.id}/edit`,
    html`<input
        type="hidden"
        name="expectedRevision"
        value="${proposal.revision}"
      />
      <input type="hidden" name="baseRevision" value="${latest}" />
      <input type="hidden" name="type" value="${proposal.type}" />
      <input type="hidden" name="title" value="${proposal.title}" />
      <input type="hidden" name="content" value="${proposal.content}" />
      <input type="hidden" name="ownerId" value="${proposal.ownerId}" />
      <input
        type="hidden"
        name="changeNote"
        value="Builds on version ${latest}"
      />
      ${proposal.evidence.map(
        (item) =>
          html`<input
            type="hidden"
            name="evidenceSourceIds"
            value="${item.sourceId}"
          />`,
      )}`,
    `Build on version ${latest}`,
  );
}

/** For a change to an existing memory: which one, what it changes, and whether it still builds on the current version. */
function changeSection(
  rc: RequestContext,
  proposal: Proposal,
  target: Memory | null,
  mayEdit: boolean,
): SafeHtml {
  if (proposal.targetMemoryId === null) return html``;
  if (target === null) {
    return html`<section>
      <h2>Change to a memory</h2>
      <p class="muted">This proposal changes a memory you cannot read.</p>
    </section>`;
  }
  const pending = proposal.status === "pending";
  const replaced = target.status === "superseded";
  const authorityChanged = proposal.baseStatusGeneration !== null && proposal.baseStatusGeneration !== target.statusGeneration;
  const outdated =
    pending && !replaced && (target.revision !== proposal.baseRevision || authorityChanged);
  const what =
    proposal.changeKind === "restore"
      ? `brings back version ${proposal.restoredFromRevision ?? "?"} as a new version`
      : proposal.changeKind === "replace"
        ? "replaces it with a new memory"
        : "adds a new version of it";
  return html`<section class="change">
    <h2>Change to <a href="/memories/${target.id}">${target.title}</a></h2>
    <p>
      ${badge(changeLabel(proposal.changeKind), "type")} This proposal ${what}.
      It builds on version ${proposal.baseRevision ?? "?"}; the memory is now
      ${memoryStatusBadge(target.status)} at version ${target.revision}.
    </p>
    ${pending && replaced
      ? html`<p class="warning" role="note">
          The memory was replaced, so this change can only be rejected.
        </p>`
      : ""}
    ${outdated
      ? html`${authorityChanged ? html`<p class="warning" role="note">Approval status changed after this proposal was written.
            It must be rebuilt and reviewed against the current status before approval.</p>` : html`<p class="warning" role="note">
              The memory changed after this proposal was written. Approval is
              refused until it builds on version ${target.revision}.
            </p>`}
          ${mayEdit ? rebaseForm(rc, proposal, target.revision) : ""}`
      : ""}
    ${pending && proposal.changeKind === "replace" && !replaced
      ? html`${target.status === "approved" && !outdated
          ? html`<h3>What approval changes</h3>
              <ol aria-label="Decision replacement">
                <li><strong>Now:</strong> the existing decision remains current guidance.</li>
                <li><strong>After approval of proposal version ${proposal.revision}:</strong>
                  the proposed decision becomes current, and the existing
                  decision is marked replaced. Both histories are kept.</li>
              </ol>
              <p class="hint">Rejecting this proposal keeps the existing decision current.</p>`
          : ""}`
      : ""}
    ${proposal.changeKind !== "replace" && target.content !== proposal.content
      ? html`<details open>
          <summary>What this changes in the current text</summary>
          ${diffView(target.content, proposal.content)}
        </details>`
      : ""}
  </section>`;
}

async function proposalPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const proposal = await getProposal(rc.ctx, user.id, rc.params.id ?? "");
  const history = await getProposalHistory(rc.ctx, user.id, proposal.id);
  const modelLinked = (await rc.ctx.db.query<{ found: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM decision_guard_publications WHERE proposal_id = $1) AS found",
    [proposal.id],
  )).rows[0]?.found === true;
  const guardProvenance = await getGuardProposalProvenance(
    rc.ctx, user.id, proposal.id, proposal.revision,
  ).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  const view = await loadProject(rc, proposal.projectId);
  const target =
    proposal.targetMemoryId === null
      ? null
      : await getMemory(rc.ctx, user.id, proposal.targetMemoryId).catch(
          (error: unknown) => {
            if (error instanceof NotFoundError) return null;
            throw error;
          },
        );
  const sources = await listSources(rc.ctx, user.id, {
    scope: { level: "project", id: proposal.projectId },
    limit: 200,
  });
  const receipts = await listRetrievals(rc.ctx, user.id, { projectId: proposal.projectId, limit: 200 });
  const people = await listProjectPeople(rc.ctx, user.id, proposal.projectId);
  const authors = new Set(history.map((version) => version.authoredBy));
  const names = await namesFor(rc, [
    proposal.ownerId,
    proposal.proposedBy,
    proposal.reviewedBy,
    ...history.flatMap((version) => [version.authoredBy, version.ownerId]),
  ]);
  const references = new Map(
    sources.map((source) => [source.id, source.reference]),
  );
  const rank = rankOf(view.project.role);
  const pending = proposal.status === "pending";
  const mayEdit =
    pending &&
    !modelLinked &&
    user.kind === "human" &&
    (proposal.proposedBy === user.id
      ? rank >= ROLE_RANK.contributor
      : rank >= ROLE_RANK.reviewer);
  const mayReview =
    pending &&
    user.kind === "human" &&
    rank >= ROLE_RANK.reviewer &&
    !authors.has(user.id);
  const editableApplicability = mayEdit && proposal.targetMemoryId === null
    ? await applicabilityFields(rc, proposal.projectId, { value: proposal.applicability })
    : html`<p class="hint">This change inherits the target decision's exact applicability.
        A different repository, branch or interval requires a new decision.</p>`;
  const current = history.at(-1);
  const previous = history.at(-2);
  const revisionField = html`<input
    type="hidden"
    name="expectedRevision"
    value="${proposal.revision}"
  />`;
  const review = mayReview
    ? html`<section class="review">
        <h2>Review version ${proposal.revision}</h2>
        <p class="hint">
          Your decision applies to version ${proposal.revision} only. If someone
          saves a new version first, it is refused and you review again.
        </p>
        ${postForm(
          rc,
          `/proposals/${proposal.id}/approve`,
          html`${revisionField}
            <label
              >Reason (optional) <input name="reason" maxlength="500"
            /></label>`,
          "Approve",
          "stacked",
        )}
        ${postForm(
          rc,
          `/proposals/${proposal.id}/reject`,
          html`${revisionField}
            <label
              >Reason <input name="reason" required maxlength="500"
            /></label>`,
          "Reject",
          "stacked",
        )}
      </section>`
    : pending
      ? html`<p class="hint">
          ${authors.has(user.id)
            ? "You wrote a version of this proposal, so a different reviewer must decide."
            : "A reviewer decides on this proposal."}
        </p>`
      : "";
  return page(rc, {
    title: proposal.title,
    crumbs: [...projectCrumbs(view), ["Proposal", `/proposals/${proposal.id}`]],
    body: html`<p>
        ${proposalStatusBadge(proposal.status)}
        ${badge(typeLabel(proposal.type), "type")}
        <span class="muted">version ${proposal.revision}</span>
        ${flagBadges(proposal.flags)}
      </p>
      <p class="hint">A proposal is not knowledge until it is approved.</p>
      ${modelLinked && pending
        ? html`<p class="hint">This model-generated proposal preserves its original sources and version.
            To correct it, reject with feedback and request a new extraction.</p>`
        : ""}
      ${guardProvenance
        ? html`<p class="hint">Suggested by ${guardProvenance.run.extraction.provenance.model}.
            <a href="/decision-guard/runs/${guardProvenance.run.id}">Review the recorded extraction and exact source quotes</a>
            for proposal version ${guardProvenance.publication.proposalRevision}.
            Evidence retains every context input to preserve its access restrictions;
            the extraction distinguishes the exact supporting quotes.</p>`
        : ""}
      ${decisionInspector(proposal, target, receipts)}
      ${applicabilityView(proposal.applicability, rc.ctx.now(), proposal.status !== "approved")}
      ${changeSection(rc, proposal, target, mayEdit)}
      <section>
        <h2>Record</h2>
        <dl class="facts">
              <dt>Proposal ID</dt>
              <dd><code>${proposal.id}</code></dd>
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
              ${proposal.memoryId === null
                ? ""
                : html`<dt>Published as</dt>
                    <dd>
                      <a href="/memories/${proposal.memoryId}">memory</a>
                    </dd>`}
        </dl>
      </section>
      ${review}
      ${current && previous
        ? previous.readable && current.readable
          ? changesView(previous, current, names, references)
          : html`<p class="muted">
              The previous version cites a source you cannot read, so its
              changes are hidden.
            </p>`
        : ""}
      <section>
        <h2>Versions</h2>
        ${table(
          ["Version", "Written by", "When", "Note", "Applicability"],
          history.map((version) => [
            html`${version.revision}
            ${version.readable ? "" : badge("hidden from you", "muted")}`,
            html`${nameOf(names, version.authoredBy)}`,
            html`${version.authoredAt}`,
            html`${version.changeNote ?? ""}`,
            version.readable ? applicabilitySummary(version.applicability) : html`<span class="muted">hidden from you</span>`,
          ]),
          "No versions.",
        )}
      </section>
      ${mayEdit ? editForm(rc, proposal, sources, people, editableApplicability) : ""}`,
  });
}

async function reviewQueuePage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const queue = await listReviewQueue(rc.ctx, user.id, { limit: 200 });
  const mine = (
    await listProposals(rc.ctx, user.id, { status: "pending", limit: 200 })
  ).filter((proposal) => proposal.proposedBy === user.id);
  const projects = await describeProjects(rc.ctx.db, [
    ...queue.map((proposal) => proposal.projectId),
    ...mine.map((proposal) => proposal.projectId),
  ]);
  const names = await namesFor(
    rc,
    queue.map((proposal) => proposal.proposedBy),
  );
  const projectName = (id: string) => projects.get(id)?.name ?? "Unknown";
  return page(rc, {
    title: "Review",
    body: html`<section>
        <h2>Waiting for your review</h2>
        <p class="hint">
          Pending proposals in projects where you are a reviewer, oldest first.
          Ones you wrote a version of are not listed.
        </p>
        ${table(
          ["Proposal", "Project", "Version", "Proposed by", "Waiting since"],
          queue.map((proposal) => [
            html`<a href="/proposals/${proposal.id}">${proposal.title}</a>
              ${flagBadges(proposal.flags)}`,
            html`<a href="/projects/${proposal.projectId}"
              >${projectName(proposal.projectId)}</a
            >`,
            html`${proposal.revision}`,
            html`${nameOf(names, proposal.proposedBy)}`,
            html`${proposal.proposedAt}`,
          ]),
          "Nothing is waiting for your review.",
        )}
      </section>
      <section>
        <h2>Your proposals waiting for someone else</h2>
        ${table(
          ["Proposal", "Project", "Version"],
          mine.map((proposal) => [
            html`<a href="/proposals/${proposal.id}">${proposal.title}</a>`,
            html`${projectName(proposal.projectId)}`,
            html`${proposal.revision}`,
          ]),
          "None.",
        )}
      </section>`,
  });
}

function expectedRevision(rc: RequestContext): number {
  return Number(formValue(rc, "expectedRevision") ?? "");
}

async function editAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const evidenceSourceIds = rc.form.getAll("evidenceSourceIds");
  if (evidenceSourceIds.length === 0) {
    throw new ValidationError("Choose at least one source as evidence");
  }
  const changeNote = formValue(rc, "changeNote");
  const baseRevision = formValue(rc, "baseRevision");
  const applicability = applicabilityFromForm(rc);
  const proposal = await editProposal(rc.ctx, user.id, {
    proposalId: rc.params.id ?? "",
    expectedRevision: expectedRevision(rc),
    type: (formValue(rc, "type") ?? "") as MemoryType,
    title: formValue(rc, "title") ?? "",
    content: formValue(rc, "content") ?? "",
    evidenceSourceIds,
    ownerId: formValue(rc, "ownerId") ?? "",
    ...(applicability === undefined ? {} : { applicability }),
    ...(changeNote === undefined ? {} : { changeNote }),
    ...(baseRevision === undefined
      ? {}
      : { baseRevision: Number(baseRevision) }),
  });
  return redirect(`/proposals/${proposal.id}`, "edited");
}

async function approveAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const memory = await approveProposal(rc.ctx, user.id, {
    proposalId: rc.params.id ?? "",
    expectedRevision: expectedRevision(rc),
    reason: formValue(rc, "reason"),
  });
  return redirect(`/memories/${memory.id}`, "approved");
}

async function rejectAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const proposal = await rejectProposal(rc.ctx, user.id, {
    proposalId: rc.params.id ?? "",
    expectedRevision: expectedRevision(rc),
    reason: formValue(rc, "reason") ?? "",
  });
  return redirect(`/proposals/${proposal.id}`, "rejected");
}

/** System page preview of the check run the GitHub App would post on a pull request. */
export async function checkSummarySection(
  rc: RequestContext,
): Promise<SafeHtml> {
  const repositories = await knownRepositories(rc);
  const repository = rc.req.query.get("checkRepository");
  const pull = rc.req.query.get("checkPull");
  let result: SafeHtml = html``;
  if (repository !== null && pull !== null) {
    try {
      if (!/^[1-9][0-9]{0,9}$/.test(pull)) {
        throw new ValidationError("Pull request number must be a whole number");
      }
      const summary = await buildCheckSummary(rc.ctx, {
        provider: "github",
        externalRepositoryId: repository,
        pullRequestNumber: Number(pull),
        reviewBaseUrl: rc.origin,
      });
      result =
        summary === null
          ? html`<p class="empty">
              No project uses this repository, so the App would post no check.
            </p>`
          : html`<div class="check">
              <p>
                <strong>${summary.name}</strong> ${badge(
                  summary.conclusion,
                  "muted",
                )}
                ${summary.title}
              </p>
              <pre>${summary.summary}</pre>
              <p><a href="${summary.detailsUrl}">Details link</a></p>
            </div>`;
    } catch (error) {
      if (!(error instanceof MemoryNetError)) throw error;
      result = html`<p class="error">${error.message}</p>`;
    }
  }
  return html`<section>
    <h2>GitHub check summary (preview)</h2>
    <p class="hint">
      What the GitHub App would show on a pull request: counts, versions, and
      links to the review screen, never titles or content. Posting it to GitHub
      waits for the Checks API docs.
    </p>
    <form method="get" action="/system" class="stacked">
      <input type="hidden" name="tab" value="checks" />
      <label
        >Repository
        <select name="checkRepository">
          ${repositoryOptions(repositories)}
        </select></label
      >
      <label
        >Pull request number
        <input
          name="checkPull"
          required
          inputmode="numeric"
          pattern="[1-9][0-9]*"
      /></label>
      <button type="submit">Preview check</button>
    </form>
    ${result}
  </section>`;
}

const ID = "(?<id>[^/]+)";

export const reviewRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: /^\/review$/,
    access: "user",
    handle: reviewQueuePage,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/proposals/${ID}$`),
    access: "user",
    handle: proposalPage,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/proposals/${ID}/edit$`),
    access: "user",
    handle: editAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/proposals/${ID}/approve$`),
    access: "user",
    handle: approveAction,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/proposals/${ID}/reject$`),
    access: "user",
    handle: rejectAction,
  },
];
