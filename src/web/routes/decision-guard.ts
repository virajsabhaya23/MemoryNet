import { requireHuman } from "../../access.ts";
import { GuardProviderError } from "../../decision-guard/errors.ts";
import type { DecisionGuardWebRuntime } from "../../decision-guard/runtime.ts";
import { getGuardRun, publishGuardCandidate, type GuardRun } from "../../decision-guard/workflow.ts";
import { ForbiddenError, MemoryNetError, UnavailableError, ValidationError } from "../../errors.ts";
import { getMemory, listMemories, listSources, type Memory } from "../../knowledge.ts";
import { ROLE_RANK } from "../../roles.ts";
import { badge, externalLink, html, options, preview, type SafeHtml } from "../html.ts";
import { formValue, page, postForm, redirect, requireUser, type RequestContext, type Route, type WebResponse } from "../kit.ts";
import { systemForm } from "../system-kit.ts";
import { loadProject, projectCrumbs, rankOf, shortSha } from "../views.ts";
import { applicabilityFields, applicabilityFromForm, applicabilitySummary, applicabilityView } from "./knowledge.ts";

async function projectForExtraction(rc: RequestContext) {
  const user = requireUser(rc);
  requireHuman(user, "extract and review decision candidates");
  const view = await loadProject(rc, rc.params.id);
  if (rankOf(view.project.role) < ROLE_RANK.contributor) {
    throw new ForbiddenError("A contributor role is required to extract decision candidates");
  }
  return view;
}

async function settingsPage(
  rc: RequestContext,
  runtime: DecisionGuardWebRuntime,
  error?: string,
): Promise<WebResponse> {
  const status = runtime.status();
  const { rows: agents } = await rc.ctx.db.query<{ id: string; display_name: string }>(
    "SELECT id, display_name FROM principals WHERE kind = 'agent' ORDER BY display_name, id LIMIT 200",
  );
  return page(rc, {
    title: "Meta model settings",
    status: error ? 400 : 200,
    body: html`<section>
      <h2>Connect Meta Model API</h2>
      ${error ? html`<p class="error" role="alert">${error}</p>` : ""}
      <p>${badge(status.configured ? "Key configured" : "Key not configured", status.configured ? "ok" : "warn")}
        ${badge(status.enabled ? "Configured; access unverified" : "Live model off", status.enabled ? "neutral" : "muted")}</p>
      <p class="hint">Your key stays in this app's server memory and is cleared when the app restarts.
        It is never shown again. Saving a key makes no model request.</p>
      ${systemForm(rc, "/settings/meta", html`
        <label for="meta-api-key">What is your Meta Model API key?</label>
        <input id="meta-api-key" type="password" name="apiKey" autocomplete="new-password"
          autocapitalize="none" spellcheck="false" maxlength="2048" ${status.configured ? "" : html`required`} />
        ${status.configured ? html`<p class="hint">Leave the key blank to keep the configured key.</p>` : ""}
        <label for="meta-agent">Decision proposal agent</label>
        <select id="meta-agent" name="agentId" required>
          <option value="">Choose an existing agent</option>
          ${options(agents.map((agent) => ({ value: agent.id, label: agent.display_name })), status.agentId ?? "")}
        </select>
        <p class="hint">The agent needs contributor access and current source-repository access in each project.
          This setting does not grant permissions. <a href="/system?tab=people">Manage local agents</a>.</p>
        <details>
          <summary>Request limits</summary>
          <label for="meta-output-limit">Maximum output tokens</label>
          <select id="meta-output-limit" name="maxOutputTokens">
            ${options([{ value: "2048", label: "2,048 (default)" }, { value: "4096", label: "4,096" }], String(status.maxOutputTokens ?? 2048))}
          </select>
          <p class="hint">A larger cap can consume more tokens. Change it only when permitted by your budget.
            Saving this setting makes no model request and does not refill the request allowance.</p>
        </details>
      `, "Save Meta settings")}
      <p class="hint">Model: ${status.model}. Requests remaining in this app process: ${status.remainingRequests}.
        Failed calls count. Configuring or forgetting a key does not reset the allowance.</p>
      <p class="hint">Only an explicit extraction sends selected engineering evidence to Meta.
        Account credits, data-use terms and billing remain your responsibility.</p>
      ${status.configured ? systemForm(rc, "/settings/meta/forget", html``, "Forget key") : ""}
    </section>`,
  });
}

function providerMessage(error: GuardProviderError, maxOutputTokens = 2048): string {
  switch (error.reason) {
    case "disabled": return "Live model is off. Configure Meta settings before extracting.";
    case "access": return "Meta model access is not configured correctly. Check the key and account access.";
    case "budget": return "Model request allowance or account credits are unavailable. Check Meta settings and your account.";
    case "busy": return error.retryAfterSeconds === null ? "Meta is busy. Try again later." : `Meta is busy. Try again in ${error.retryAfterSeconds} seconds.`;
    case "timeout": return "Meta took too long. No decision proposal was saved. You can try again.";
    case "invalid_response": {
      switch (error.diagnostic) {
        case "token_limit": return maxOutputTokens === 4096
          ? "Meta reached the configured 4,096-token output limit before completing a valid response. No draft or proposal was saved. The available cap is already selected; reduce the evidence selection or review the model response behavior before another request."
          : "Meta reached the configured output-token limit before completing a valid response. No draft or proposal was saved. Open Meta settings → Request limits to review the cap; choose 4,096 only if your budget permits, then explicitly extract again.";
        case "model_mismatch": return "The returned model ID did not match the configured model. No draft or proposal was saved. Review model compatibility before making another request.";
        case "refusal": return "Meta declined to return a decision for this request. No draft or proposal was saved. Review the selected evidence and its permitted use before trying again.";
        case "too_large": return "Meta's response exceeded the safe response-size limit. No draft or proposal was saved. Choose a smaller evidence selection before trying again.";
        case "invalid_json": return "Meta returned malformed JSON. No draft or proposal was saved. The response was rejected; review the request before making another call.";
        case "choice_count": return "Meta returned an unexpected number of responses. No draft or proposal was saved. Review provider compatibility before another request.";
        case "unexpected_tool_call": return "Meta returned a tool call instead of decision data. No draft or proposal was saved. This workflow accepts validated decision data only.";
        case "missing_body":
        case "missing_text": return "Meta returned no usable decision text. No draft or proposal was saved. Review the selected evidence and model compatibility before another request.";
        case "invalid_envelope": return "Meta returned an unsupported response format. No draft or proposal was saved. Review provider compatibility before another request.";
        default: return "The model response was rejected by validation. No decision proposal was saved.";
      }
    }
    case "unavailable": return "Meta is unavailable. No decision proposal was saved. Try again later.";
  }
}

async function extractionPage(
  rc: RequestContext,
  runtime: DecisionGuardWebRuntime,
  feedback?: { status: number; message: string },
): Promise<WebResponse> {
  const user = requireUser(rc);
  const view = await projectForExtraction(rc);
  const projectId = view.project.id;
  const [allSources, allMemories] = await Promise.all([
    listSources(rc.ctx, user.id, { scope: { level: "project", id: projectId }, limit: 200 }),
    listMemories(rc.ctx, user.id, { scope: { level: "project", id: projectId }, status: "approved", limit: 200 }),
  ]);
  const sources = allSources.filter((source) => source.revision !== null && /^[0-9a-f]{40}$/i.test(source.revision));
  const decisions = allMemories.filter((memory) => memory.type === "decision" && memory.applicability !== null);
  const selectedSources = new Set(rc.form.getAll("sourceIds"));
  const selectedDecisions = new Set(rc.form.getAll("decisionIds"));
  const status = runtime.status();
  const scopeFields = await applicabilityFields(rc, projectId, { required: true });
  return page(rc, {
    title: `Decision Guard: ${view.project.name}`,
    crumbs: projectCrumbs(view),
    status: feedback?.status ?? 200,
    body: html`<section>
      <h2>Suggest a source-backed decision</h2>
      <p>${badge(status.enabled ? "Meta configured" : "Live model off", status.enabled ? "ok" : "muted")}
        <a href="/settings/meta">Meta settings</a></p>
      <p class="hint">Choose evidence that you are permitted to send to Meta. Extraction sends only your selected
        excerpts and selected approved decisions. A merged PR is evidence; a person still decides whether a proposal becomes guidance.</p>
      <p class="hint">Your free-credit account may use content for product improvement.
        Send only evidence you have permission to disclose under those terms.</p>
      ${feedback ? html`<p class="error" role="alert">${feedback.message}</p>` : ""}
      ${sources.length === 0 ? html`<p class="empty">No readable sources with a full pinned commit are available.
        <a href="/projects/${projectId}">Record PR evidence on the project page</a> with its full commit SHA first.</p>` : ""}
      ${postForm(rc, `/projects/${projectId}/decision-guard`, html`
        ${scopeFields}
        <fieldset><legend>Engineering evidence (choose 1–8)</legend>
          ${sources.map((source) => html`<label class="choice">
            <input type="checkbox" name="sourceIds" value="${source.id}" ${selectedSources.has(source.id) ? html`checked` : ""} />
            <strong>${source.reference}</strong> · commit ${shortSha(source.revision)}
            <span class="muted">${preview(source.excerpt, 180)}</span>
          </label>`)}
        </fieldset>
        <fieldset><legend>Approved decisions to check for possible conflicts (optional, up to 20)</legend>
          <p class="hint">Choose only decisions with the same repository, exact branch and validity interval as this run.
            Legacy unscoped decisions are omitted from this scoped workflow.</p>
          ${decisions.length ? decisions.map((memory) => html`<label class="choice">
            <input type="checkbox" name="decisionIds" value="${memory.id}" ${selectedDecisions.has(memory.id) ? html`checked` : ""} />
            ${memory.title} · version ${memory.revision}
            <span class="muted">${applicabilitySummary(memory.applicability)}</span>
          </label>`) : html`<p class="muted">No current approved decisions with reviewed applicability are available.</p>`}
        </fieldset>
        <p class="hint">The chosen applicability is preserved with this run and its pending proposal.
          A person approves that exact scope and version. Extraction does not approve or replace any decision.</p>
      `, "Extract with Meta", "stacked")}
      <p class="hint">Model: ${status.model}. ${status.remainingRequests} requests remain in this app process.</p>
    </section>`,
  });
}

async function runPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  requireHuman(user, "review decision candidates");
  const run = await getGuardRun(rc.ctx, user.id, rc.params.runId ?? "");
  const view = await loadProject({ ...rc, params: { id: run.projectId } }, run.projectId);
  const decisionNames = new Map<string, Memory>();
  for (const compared of run.comparedDecisions) {
    const current = await getMemory(rc.ctx, user.id, compared.memoryId);
    decisionNames.set(compared.memoryId, current);
  }
  const provenance = run.extraction.provenance;
  return page(rc, {
    title: "Review extracted decisions",
    crumbs: [...projectCrumbs(view), ["Decision Guard", `/projects/${run.projectId}/decision-guard`]],
    body: html`<section>
      <h2>Recorded extraction</h2>
      <p>${badge("Unreviewed suggestions", "warn")} ${provenance.provider} · ${provenance.model} · ${run.createdAt}</p>
      <p class="hint">These suggestions are not approved knowledge. Saving a candidate creates a pending proposal
        by the configured agent, owned by the person who requested extraction. Review the exact proposal version on the next screen.</p>
      <p class="hint">Compared decisions help identify possible conflicts. Sources retained as access dependencies
        are not automatically evidence for every suggestion. Only the exact source quotes listed with a candidate support its citation.</p>
      <p class="hint">Run <code>${run.id}</code>. Reloading this page makes no model request.</p>
      ${applicabilityView(run.applicability, rc.ctx.now(), true)}
      ${provenance.usage ? html`<p class="hint">Reported usage: ${provenance.usage.inputTokens} input tokens,
        ${provenance.usage.outputTokens} output tokens.</p>` : ""}
      ${run.extraction.candidates.length === 0 ? html`<p class="empty">Not enough evidence in this PR to suggest a decision.
        No decision proposal was saved.</p>` : ""}
    </section>
    ${run.extraction.candidates.map((candidate, index) => candidateView(rc, run, index, decisionNames))}`,
  });
}

function candidateView(rc: RequestContext, run: GuardRun, index: number, names: Map<string, Memory>): SafeHtml {
  const candidate = run.extraction.candidates[index];
  if (!candidate) return html``;
  const published = run.publications.find((item) => item.candidateIndex === index);
  const comparisonChanged = run.comparedDecisions.some((compared) => {
    const current = names.get(compared.memoryId);
    return !current || current.revision !== compared.revision || current.status !== "approved";
  });
  return html`<section>
    <h2>Suggested decision ${index + 1}: ${candidate.title}</h2>
    <p class="content">${candidate.decision}</p>
    <h3>Source says</h3>
    <ul class="evidence">${candidate.evidence.map((citation) => {
      const source = run.extraction.sourceSnapshots.find((source) => source.sourceId === citation.sourceId);
      if (!source) throw new ValidationError("Extraction source is unavailable");
      return html`<li><p>${externalLink(source.url, "Open PR")} · commit <code>${source.revision}</code>
        · <a href="/sources/${source.sourceId}">source record</a></p>
        <blockquote>${source.text.slice(citation.start, citation.end)}</blockquote>
        <small>Excerpt positions ${citation.start}–${citation.end} (end excluded).</small></li>`;
    })}</ul>
    ${candidate.possibleConflicts.length ? html`<h3>Possible conflict</h3>
      <ul>${candidate.possibleConflicts.map((conflict) => {
        const current = names.get(conflict.memoryId);
        const changed = current && (current.revision !== conflict.revision || current.status !== "approved");
        return html`<li>Compared decision <code>${conflict.memoryId}</code> · version ${conflict.revision}: ${conflict.reason}
          ${current ? html`<p>Current record: <a href="/memories/${conflict.memoryId}">${current.title}</a>
            · version ${current.revision} · ${current.status}.</p>
            <div class="review-grid" aria-label="Compared decision and suggestion">
              <section><h4>Existing guidance at time of viewing</h4>
                <p class="content">${current.content}</p>
                <p>${applicabilitySummary(current.applicability)}</p></section>
              <section><h4>Suggested change for human review</h4>
                <p class="content">${candidate.decision}</p>
                <p>${applicabilitySummary(run.applicability)}</p></section>
            </div>` : ""}
          ${changed ? html`<p class="warning" role="note">This comparison is stale. The decision changed after extraction;
            a replacement from this run will be refused. Extract again against the current decision.</p>` : ""}
        </li>`;
      })}</ul><p class="hint">A conflict hint does not retire or replace the approved decision.</p>` : ""}
    ${published ? html`<p><a href="/proposals/${published.proposalId}">Open saved proposal</a>
        · submitted at proposal version ${published.proposalRevision}. Approval is a separate human action.</p>` :
      userMayPublish(rc, run) ? postForm(rc, `/decision-guard/runs/${run.id}/candidates/${index}/propose`, html`
        <fieldset><legend>What should this proposal do?</legend>
          <label class="choice"><input type="radio" name="kind" value="new" checked /> Propose a new decision</label>
          ${run.comparedDecisions.length ? html`<label class="choice"><input type="radio" name="kind" value="replace" />
            Propose replacing an approved decision</label>
            <label>Decision to replace (only for replacement)
              <select name="targetMemoryId"><option value="">Choose a compared decision</option>
                ${options(run.comparedDecisions.map((compared) => ({ value: compared.memoryId,
                  label: `Compared version ${compared.revision} of ${compared.memoryId} (current title: ${names.get(compared.memoryId)?.title ?? "unavailable"})` })), "")}
              </select></label>` : ""}
        </fieldset>
        ${run.comparedDecisions.length ? html`<p class="hint">Replacement is your explicit selection from decisions compared in this run.
          It does not assert that the model found a conflict. The existing decision stays current until an authorized human approves the exact pending replacement.</p>` : ""}
        ${comparisonChanged ? html`<p class="warning" role="note">A compared decision changed after extraction.
          Replacement from this run will be refused; extract again against the current decision.</p>` : ""}
        <p class="hint">Owner: ${requireUser(rc).displayName}. The agent proposes; an authorized human reviews.
          Correction requires rejecting with feedback and generating a new proposal.</p>
      `, "Save pending proposal", "stacked") : html`<p class="hint">Only the person who requested this extraction can save its candidates.</p>`}
  </section>`;
}

function userMayPublish(rc: RequestContext, run: GuardRun): boolean {
  return rc.user?.kind === "human" && rc.user.id === run.requesterId;
}

export function createDecisionGuardRoutes(runtime: DecisionGuardWebRuntime): readonly Route[] {
  return [
    { method: "GET", pattern: /^\/settings\/meta$/, access: "system", handle: (rc) => settingsPage(rc, runtime) },
    { method: "POST", pattern: /^\/settings\/meta$/, access: "system", handle: async (rc) => {
      try {
        if (rc.form.getAll("apiKey").length !== 1 || rc.form.getAll("agentId").length !== 1 || rc.form.getAll("maxOutputTokens").length > 1) throw new ValidationError("Submit one key, agent selection and request limit");
        const limit = rc.form.get("maxOutputTokens");
        if (limit !== null && limit !== "2048" && limit !== "4096") throw new ValidationError("Choose a supported output-token limit");
        const agentId = formValue(rc, "agentId") ?? "";
        const agent = await rc.ctx.db.query<{ id: string }>("SELECT id FROM principals WHERE id::text = $1 AND kind = 'agent'", [agentId]);
        if (!agent.rows[0]) throw new ValidationError("Choose an existing agent");
        await runtime.configure(rc.form.get("apiKey") ?? "", { agentId, ...(limit === null ? {} : { maxOutputTokens: Number(limit) }) });
        return redirect("/settings/meta");
      } catch {
        // Configuration errors can involve secrets. Never echo submitted values or raw errors.
        return settingsPage(rc, runtime, "Meta settings could not be saved. Check the key, choose an existing agent and review request limits, then try again.");
      }
    } },
    { method: "POST", pattern: /^\/settings\/meta\/forget$/, access: "system", handle: async (rc) => {
      try { await runtime.forget(); return redirect("/settings/meta"); }
      catch { return settingsPage(rc, runtime, "The key could not be cleared. Restart the app to clear its server memory."); }
    } },
    { method: "GET", pattern: /^\/projects\/(?<id>[^/]+)\/decision-guard$/, access: "user", handle: (rc) => extractionPage(rc, runtime) },
    { method: "POST", pattern: /^\/projects\/(?<id>[^/]+)\/decision-guard$/, access: "user", handle: async (rc) => {
      const view = await projectForExtraction(rc);
      const attemptedOutputLimit = runtime.status().maxOutputTokens ?? 2048;
      let applicability;
      try { applicability = applicabilityFromForm(rc, true); }
      catch (error) {
        if (error instanceof ValidationError) return extractionPage(rc, runtime, { status: 400, message: error.message });
        throw error;
      }
      try {
        const run = await runtime.createRun(rc.ctx, requireUser(rc).id, {
          projectId: view.project.id, sourceIds: rc.form.getAll("sourceIds"), decisionIds: rc.form.getAll("decisionIds"),
          applicability,
        });
        return redirect(`/decision-guard/runs/${run.id}`);
      } catch (error) {
        if (error instanceof GuardProviderError) return extractionPage(rc, runtime, { status: 503, message: providerMessage(error, attemptedOutputLimit) });
        if (error instanceof ValidationError) return extractionPage(rc, runtime, { status: 400, message: "The selected applicability, evidence, comparison decisions or model response failed validation. No decision proposal was saved." });
        if (error instanceof MemoryNetError && !(error instanceof UnavailableError)) throw error;
        return extractionPage(rc, runtime, { status: 503, message: "Decision extraction failed. No decision proposal was saved. Try again later." });
      }
    } },
    { method: "GET", pattern: /^\/decision-guard\/runs\/(?<runId>[^/]+)$/, access: "user", handle: runPage },
    { method: "POST", pattern: /^\/decision-guard\/runs\/(?<runId>[^/]+)\/candidates\/(?<index>[^/]+)\/propose$/, access: "user", handle: async (rc) => {
      const user = requireUser(rc);
      requireHuman(user, "save decision candidates");
      const index = rc.params.index ?? "";
      const kind = rc.form.get("kind");
      if (!/^\d{1,2}$/.test(index) || (kind !== "new" && kind !== "replace")) throw new ValidationError("Choose a valid candidate and proposal action");
      const proposal = await publishGuardCandidate(rc.ctx, user.id, {
        runId: rc.params.runId ?? "", candidateIndex: Number(index), kind,
        ...(kind === "replace" ? { targetMemoryId: formValue(rc, "targetMemoryId") ?? "" } : {}),
      });
      return redirect(`/proposals/${proposal.id}`);
    } },
  ];
}
