import { analyzeBrainHealth, listBrainBriefs, type BrainBrief } from "../../brain.ts";
import type { DecisionGuardWebRuntime } from "../../decision-guard/runtime.ts";
import { html, ledgerRow, type SafeHtml } from "../html.ts";
import { postForm, redirect, requireUser, type RequestContext, type Route, type WebResponse } from "../kit.ts";

function briefView(brief: BrainBrief): SafeHtml {
  return html`<article class="brain-brief">
    <p><span class="badge" data-kind="guidance">AI brief — not approved knowledge</span>
      <span class="muted">${brief.createdAt} · ${brief.model}</span></p>
    <p class="content">${brief.content}</p>
    ${brief.citations.length > 0
      ? html`<p class="hint">Cites: ${brief.citations.map((id) => html`<a href="/memories/${id}"><code>${id.slice(0, 8)}</code></a> `)}</p>`
      : ""}
  </article>`;
}

/** The project Brain panel: deterministic findings, brief history, and the brief action. */
export async function brainSection(
  rc: RequestContext,
  projectId: string,
  organizationId: string,
  canPropose: boolean,
): Promise<SafeHtml> {
  const user = requireUser(rc);
  const findings = await analyzeBrainHealth(rc.ctx, user.id, { organizationId, projectId }).catch(() => []);
  const briefs = await listBrainBriefs(rc.ctx, user.id, projectId).catch(() => []);
  return html`<section id="brain" class="panel brain-panel">
    <h2>Brain</h2>
    <p class="hint">
      What the company brain notices in this project. Findings come from records
      you can already read; briefs are AI synthesis, never approved knowledge.
    </p>
    ${findings.length === 0
      ? html`<p class="empty">Nothing needs attention here right now.</p>`
      : html`<ul class="ledger">
          ${findings.map((finding) => ledgerRow({
            href: finding.href,
            title: finding.label,
            meta: "Brain health",
            trailing: html`<span class="badge" data-state="pending">${finding.count}</span>`,
          }))}
        </ul>`}
    ${rc.decisionGuardAvailable && user.kind === "human" && canPropose
      ? html`<p><a class="key" href="/projects/${projectId}/decision-guard">Suggest memories from evidence</a></p>
          ${postForm(rc, `/projects/${projectId}/brain/brief`, "", "Generate brain brief")}`
      : ""}
    ${briefs.map(briefView)}
  </section>`;
}

export function createBrainBriefRoutes(runtime: DecisionGuardWebRuntime): Route[] {
  return [
    {
      method: "POST",
      pattern: /^\/projects\/(?<id>[^/]+)\/brain\/brief$/,
      access: "user",
      handle: async (rc: RequestContext): Promise<WebResponse> => {
        const user = requireUser(rc);
        if (!runtime.brief) throw new Error("Brain briefs are not available on this server");
        const brief = await runtime.brief(rc.ctx, user.id, { projectId: rc.params.id ?? "" });
        return redirect(`/projects/${brief.projectId}#brain`);
      },
    },
  ];
}
