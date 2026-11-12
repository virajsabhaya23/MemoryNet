import { ValidationError } from "../../errors.ts";
import { formatCheckpoint, verifyOrganizationLedger, type LedgerReport } from "../../ledger.ts";
import { getOrganizationTree } from "../../organizations.ts";
import { getProjectPolicy, MAX_REQUIRED_APPROVALS, setProjectPolicy } from "../../policy.ts";
import type { Role } from "../../roles.ts";
import { ROLE_RANK } from "../../roles.ts";
import { badge, html, table, type SafeHtml } from "../html.ts";
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
import { nameOf, namesFor, rankOf } from "../views.ts";

/** The project's review policy for everyone with a role there; administrators also get the change form. */
export async function policySection(rc: RequestContext, projectId: string, role: Role | null): Promise<SafeHtml> {
  const user = requireUser(rc);
  const policy = await getProjectPolicy(rc.ctx, user.id, projectId);
  const names = await namesFor(rc, [policy.changedBy]);
  const isAdmin = user.kind === "human" && rankOf(role) >= ROLE_RANK.administrator;
  const choice = (value: number) => html`<option value="${value}" ${value === policy.requiredApprovals ? "selected" : ""}>${value} ${value === 1 ? "reviewer" : "different reviewers"}</option>`;
  return html`<section id="review-policy">
    <h2>Review policy</h2>
    <dl class="facts">
      <dt>Approvals to publish</dt>
      <dd>${policy.requiredApprovals} ${policy.requiredApprovals === 1 ? "reviewer" : "different reviewers"}, none of whom wrote a version</dd>
      <dt>Agent proposals</dt>
      <dd>${policy.agentProposals ? html`Allowed, at most ${policy.agentPendingLimit} waiting per agent` : "Turned off"}</dd>
      <dt>Policy version</dt>
      <dd>${policy.revision === 0
        ? html`<span class="muted">built-in default</span>`
        : html`${policy.revision} · ${nameOf(names, policy.changedBy)} on ${policy.changedAt ?? ""} · ${policy.reason ?? ""}`}</dd>
    </dl>
    <p class="hint">Agents can only propose. People approve, and every approval names the exact version it covers.</p>
    ${isAdmin ? postForm(rc, `/projects/${projectId}/policy`, html`
      <input type="hidden" name="expectedRevision" value="${policy.revision}" />
      <label>Approvals to publish
        <select name="requiredApprovals">${Array.from({ length: MAX_REQUIRED_APPROVALS }, (_, i) => choice(i + 1))}</select></label>
      <label><input type="checkbox" name="agentProposals" value="yes" ${policy.agentProposals ? "checked" : ""} /> Accept proposals from agents</label>
      <label>Most proposals one agent may have waiting
        <input name="agentPendingLimit" type="number" min="1" max="500" required value="${policy.agentPendingLimit}" /></label>
      <label>Reason <input name="reason" required maxlength="500" /></label>`, "Save policy", "stacked") : ""}
  </section>`;
}

async function policyAction(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const number = (name: string) => {
    const value = formValue(rc, name);
    if (value === undefined || !/^\d{1,10}$/.test(value)) throw new ValidationError(`${name} must be a whole number`);
    return Number(value);
  };
  const projectId = rc.params.id ?? "";
  await setProjectPolicy(rc.ctx, user.id, {
    projectId,
    expectedRevision: number("expectedRevision"),
    requiredApprovals: number("requiredApprovals"),
    agentProposals: rc.form.get("agentProposals") === "yes",
    agentPendingLimit: number("agentPendingLimit"),
    reason: formValue(rc, "reason") ?? "",
  });
  return redirect(`/projects/${projectId}#review-policy`, "policy-saved");
}

function reportView(report: LedgerReport): SafeHtml {
  const chain = report.chains[0];
  if (!chain) return html`<p class="empty">No audited activity yet.</p>`;
  return html`<p>${report.ok ? badge("verified", "ok") : badge("verification failed", "warn")}
      ${chain.entries} chained audit events and retrieval receipts.</p>
    ${chain.problems.length + report.problems.length > 0
      ? table(["Problem"], [...chain.problems, ...report.problems].map((problem) => [html`${problem}`]), "")
      : ""}
    <h3>Checkpoint</h3>
    <p class="hint">Copy this line somewhere MemoryNet cannot change, such as a ticket, a commit message or a signed note.
      Verifying with it later proves the history up to this point was not rewritten.</p>
    <pre>${formatCheckpoint(chain.head)}</pre>`;
}

async function integrityPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const tree = await getOrganizationTree(rc.ctx, user.id, rc.params.id ?? "");
  const checkpoint = rc.req.method === "POST" ? formValue(rc, "checkpoint") : undefined;
  const report = await verifyOrganizationLedger(rc.ctx, user.id, {
    organizationId: tree.organization.id,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  });
  return page(rc, {
    title: "Audit integrity",
    crumbs: [[tree.organization.name, `/orgs/${tree.organization.id}`], ["Audit integrity", `/orgs/${tree.organization.id}/integrity`]],
    body: html`<p class="hint">Every audit event and retrieval receipt in this organization is linked into a SHA-256 hash chain.
        This page recomputed it just now from the stored records. It shows identifiers and digests only, never content.</p>
      ${checkpoint === undefined ? "" : html`<p>Checked against checkpoint <code>${checkpoint}</code>.</p>`}
      ${reportView(report)}
      <section>
        <h2>Verify against an earlier checkpoint</h2>
        ${postForm(rc, `/orgs/${tree.organization.id}/integrity`, html`<label>Checkpoint
          <input name="checkpoint" required maxlength="200" placeholder="mnl1.…" /></label>`, "Verify", "stacked")}
      </section>
      <p class="hint">A chain that verifies shows the records were not edited, removed or inserted since they were chained,
        and, with a checkpoint, that earlier history was not rebuilt. It does not show that the recorded actions were correct.</p>`,
  });
}

/** Administrators see the integrity link on the organization page. */
export function integrityLink(organizationId: string, role: Role | null): SafeHtml {
  return rankOf(role) >= ROLE_RANK.administrator
    ? html`<a class="ghost-link" href="/orgs/${organizationId}/integrity">Audit integrity</a>`
    : html``;
}

const ID = "(?<id>[^/]+)";

export const governanceRoutes: readonly Route[] = [
  { method: "POST", pattern: new RegExp(`^/projects/${ID}/policy$`), access: "user", handle: policyAction },
  { method: "GET", pattern: new RegExp(`^/orgs/${ID}/integrity$`), access: "user", handle: integrityPage },
  { method: "POST", pattern: new RegExp(`^/orgs/${ID}/integrity$`), access: "user", handle: integrityPage },
];
