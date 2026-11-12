import {
  analyzeBrainHealth,
  listBrainBriefs,
  listBrainRecommendations,
  type BrainBrief,
  type BrainFindingKind,
  type BrainRecommendation,
  type BrainRecommendationKind,
} from "../../brain.ts";
import type { DecisionGuardWebRuntime } from "../../decision-guard/runtime.ts";
import { listSources, proposeMemory, type MemoryType } from "../../knowledge.ts";
import { html, join, ledgerRow, options, type SafeHtml } from "../html.ts";
import { formValue, page, postForm, redirect, requireUser, type RequestContext, type Route, type WebResponse } from "../kit.ts";
import { MEMORY_TYPE_INFO } from "../labels.ts";
import { loadProject, projectCrumbs } from "../views.ts";

const RECOMMENDATION_LABELS: Readonly<Record<BrainRecommendationKind, string>> = {
  definition_outdated: "Definition may be outdated",
  recurring_reports: "Reported as outdated more than once",
  rejected_agent_attempts: "Agent proposals keep being rejected",
  conflicting_decisions: "Conflicting decisions",
};

/** Findings that only count the recommendations the panel lists in full. */
const COUNTED_RECOMMENDATIONS: ReadonlySet<BrainFindingKind> = new Set<BrainFindingKind>([
  "outdated_definitions",
  "recurring_reports",
  "rejected_agent_attempts",
  "conflicting_decisions",
]);

function recommendationRow(recommendation: BrainRecommendation): SafeHtml {
  const related = recommendation.related.map((record, index) =>
    html`${index > 0 ? ", " : ""}<a href="/${record.kind === "memory" ? "memories" : "definitions"}/${record.id}">${record.title}</a>`);
  return ledgerRow({
    title: recommendation.reason,
    meta: html`${RECOMMENDATION_LABELS[recommendation.kind]}${related.length > 0 ? html` · Related: ${join(related)}` : ""}${recommendation.at === null ? "" : html` · ${recommendation.at}`}`,
    trailing: join(recommendation.actions.map((action, index) =>
      html`${index > 0 ? " " : ""}<a class="key key-small" href="${action.href}">${action.label}</a>`)),
  });
}

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

/** The project Brain panel: deterministic findings and recommendations, brief history, and the brief action. */
export async function brainSection(
  rc: RequestContext,
  projectId: string,
  organizationId: string,
  canPropose: boolean,
): Promise<SafeHtml> {
  const user = requireUser(rc);
  const findings = (await analyzeBrainHealth(rc.ctx, user.id, { organizationId, projectId }).catch(() => []))
    .filter((finding) => !COUNTED_RECOMMENDATIONS.has(finding.kind));
  const recommendations = await listBrainRecommendations(rc.ctx, user.id, { organizationId, projectId }).catch(() => []);
  const briefs = await listBrainBriefs(rc.ctx, user.id, projectId).catch(() => []);
  const sources = canPropose
    ? await listSources(rc.ctx, user.id, { scope: { level: "project", id: projectId }, limit: 50 }).catch(() => [])
    : [];
  return html`<section id="brain" class="panel brain-panel">
    <h2>Brain</h2>
    <p class="hint">
      What the company brain notices in this project. Findings come from records
      you can already read; briefs are AI synthesis, never approved knowledge.
    </p>
    ${findings.length === 0 && recommendations.length === 0
      ? html`<p class="empty">Nothing needs attention here right now.</p>`
      : ""}
    ${findings.length > 0
      ? html`<ul class="ledger">
          ${findings.map((finding) => ledgerRow({
            href: finding.href,
            title: finding.label,
            meta: "Brain health",
            trailing: html`<span class="badge" data-state="pending">${finding.count}</span>`,
          }))}
        </ul>`
      : ""}
    ${recommendations.length > 0
      ? html`<h3 id="brain-recommendations">Recommendations</h3>
        <p class="hint">
          Suggested from approved records you can read. A person decides: nothing
          changes until someone proposes the change and a different person approves it.
        </p>
        <ul class="ledger">${recommendations.map(recommendationRow)}</ul>`
      : ""}
    ${rc.decisionGuardAvailable && user.kind === "human" && canPropose
      ? html`<p><a class="key" href="/projects/${projectId}/decision-guard">Suggest memories from evidence</a></p>
          ${postForm(rc, `/projects/${projectId}/brain/brief`, "", "Generate brain brief")}
          ${postForm(rc, `/projects/${projectId}/brain/ask`, html`<label>Ask the brain (answers only from approved knowledge)
              <textarea name="question" required maxlength="500" rows="2" placeholder="What do we know about…"></textarea></label>`, "Ask", "stacked")}`
      : ""}
    ${canPropose
      ? html`<h3>Capture a session learning</h3>
        ${postForm(rc, `/projects/${projectId}/brain/capture`, html`
          <label>Title <input name="title" required maxlength="200" /></label>
          <label>Kind
            <select name="type">${options(Object.entries(MEMORY_TYPE_INFO).map(([value, info]) => ({ value, label: info.label })))}</select></label>
          <label>What was learned <textarea name="summary" required rows="4" maxlength="10000"></textarea></label>
          <fieldset><legend>Evidence (cite at least one source)</legend>
            ${sources.length === 0
              ? html`<p class="hint">No sources you can cite yet. Record evidence first.</p>`
              : sources.map((source) => html`<label class="choice"><input type="checkbox" name="evidenceSourceIds" value="${source.id}" /> ${source.reference}</label>`)}
          </fieldset>
          `, "Send for review", "stacked brain-capture")}
          <p class="hint">Capture proposes; a different reviewer approves. Nothing becomes knowledge from this form alone.</p>`
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
    {
      method: "POST",
      pattern: /^\/projects\/(?<id>[^/]+)\/brain\/ask$/,
      access: "user",
      handle: async (rc: RequestContext): Promise<WebResponse> => {
        const user = requireUser(rc);
        if (!runtime.ask) throw new Error("Ask is not available on this server");
        const projectId = rc.params.id ?? "";
        const answer = await runtime.ask(rc.ctx, user.id, {
          projectId,
          question: formValue(rc, "question") ?? "",
        });
        const view = await loadProject(rc, projectId);
        return page(rc, {
          title: `Ask: ${view.project.name}`,
          crumbs: projectCrumbs(view),
          body: html`<p><span class="badge" data-kind="guidance">AI answer — from approved knowledge only</span>
              <span class="muted">${answer.model} · retrieval <code>${answer.retrievalId.slice(0, 8)}</code></span></p>
            <h2>${answer.question}</h2>
            <p class="content">${answer.answer}</p>
            ${answer.citations.length > 0
              ? html`<p class="hint">Cites: ${answer.citations.map((id) => html`<a href="/memories/${id}"><code>${id.slice(0, 8)}</code></a> `)}</p>`
              : html`<p class="hint">No approved memory was cited for this answer.</p>`}
            <p><a href="/projects/${projectId}#brain">Back to the project Brain</a></p>`,
        });
      },
    },
  ];
}

/** Session capture: a learning from a work session, proposed for review with cited evidence. */
export const brainCaptureRoutes: Route[] = [
  {
    method: "POST",
    pattern: /^\/projects\/(?<id>[^/]+)\/brain\/capture$/,
    access: "user",
    handle: async (rc: RequestContext): Promise<WebResponse> => {
      const user = requireUser(rc);
      const projectId = rc.params.id ?? "";
      const evidenceSourceIds = rc.form.getAll("evidenceSourceIds");
      const proposal = await proposeMemory(rc.ctx, user.id, {
        projectId,
        type: (formValue(rc, "type") ?? "lesson") as MemoryType,
        title: formValue(rc, "title") ?? "",
        content: formValue(rc, "summary") ?? "",
        evidenceSourceIds,
      });
      return user.kind === "agent"
        ? redirect(`/projects/${projectId}`, "proposed-by-agent")
        : redirect(`/proposals/${proposal.id}`, "proposed");
    },
  },
];
