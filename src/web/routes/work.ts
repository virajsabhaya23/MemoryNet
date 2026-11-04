import { createHash } from "node:crypto";
import { listMemories } from "../../knowledge.ts";
import { ValidationError } from "../../errors.ts";
import { closeWork, createWork, exportWork, listWork } from "../../work.ts";
import { html, badge } from "../html.ts";
import { csrfField, page, redirect, requireUser, SECURITY_HEADERS, type Route, type RequestContext } from "../kit.ts";
import { loadProject, projectCrumbs, rankOf } from "../views.ts";

const reasons = {
  revision_changed: "Approved revision changed; refresh the linked spec and task context.",
  lifecycle_changed: "Decision lifecycle changed; review even if the text is unchanged.",
  not_approved: "Pinned decision is no longer approved. Review its replacement or withdrawal.",
  outside_validity: "Decision no longer applies at the current time on this exact branch.",
};
async function workPage(rc: RequestContext) {
  const user = requireUser(rc), view = await loadProject(rc, rc.params.id);
  const items = await listWork(rc.ctx, user.id, view.project.id);
  const affected = items.filter((i) => i.contextStatus === "review_needed");
  const canWrite = rankOf(view.project.role) >= 2;
  const available = canWrite ? (await listMemories(rc.ctx, user.id, { scope: { level: "project", id: view.project.id }, limit: 200 }))
    .filter((m) => m.applicability && m.applicability.validFrom <= rc.ctx.now() && (m.applicability.validUntil === null || rc.ctx.now() < m.applicability.validUntil)) : [];
  return page(rc, { title: "Affected work", crumbs: projectCrumbs(view), body: html`
    <p>Keep approved decisions, specs and active work in sync. Each task pins the decision versions it started with.</p>
    <p>${badge(`${affected.length} need review`, affected.length ? "warn" : "neutral")} ${items.length} visible active tasks</p>
    <p class="hint">Checked now against approved context. File links and commits are declared by contributors. These checks do not verify artifact contents, test coverage or code behavior.</p>
    ${items.length === 0 ? html`<p class="empty">No active work is tracked yet. Link a spec and approved decisions to start a context baseline.</p>` : ""}
    ${[...affected, ...items.filter((i) => i.contextStatus === "current")].map((item) => html`<section class="panel work-item" data-status="${item.contextStatus}">
      <h2>${item.work.title}</h2>
      <p>${badge(item.contextStatus === "current" ? "Context current" : "Review needed", item.contextStatus === "current" ? "neutral" : "warn")}
      · repository ${item.work.repositoryId} · branch <code>${item.work.branch}</code></p>
      <p>Baseline commit <code>${item.work.codeCommit}</code> · created ${item.work.createdAt} · checked ${item.checkedAt}</p>
      <h3>Linked artifacts</h3><ul>${item.work.artifacts.map((a) => html`<li><code>${a.path}</code> · ${a.requirementId} · ${a.kind}<br><small>SHA-256 <code>${a.sha256}</code></small></li>`)}</ul>
      <h3>Decision versions</h3><ul>${item.work.pins.map((pin) => html`<li><a href="/memories/${pin.memoryId}">${pin.memoryId}</a> · version ${pin.revision}</li>`)}</ul>
      ${item.issues.length ? html`<ul>${item.issues.map((issue) => html`<li><a href="/memories/${issue.memoryId}">Pinned v${issue.pinnedRevision}, observed v${issue.observedRevision ?? issue.pinnedRevision}</a> · ${reasons[issue.reason]}</li>`)}</ul>
        <p>Review the decision history, update the linked artifacts, then create a new baseline. The original baseline stays unchanged.</p>` : html`<p><a href="/work/${item.work.id}/context.md">Download agent context for OpenSpec</a> · <a href="/work/${item.work.id}/context.json">Download JSON bundle</a></p>`}
      ${canWrite ? html`<form method="post" action="/work/${item.work.id}/close">${csrfField(rc)}<button type="submit">Close tracked task</button></form>` : ""}
    </section>`)}
    ${canWrite ? html`<section class="panel"><h2>Track a spec or task</h2>
      <p>Use an approved decision's exact repository and branch. For OpenSpec, link the spec under <code>openspec/changes/&lt;change&gt;/specs/</code>, then put the downloaded context alongside that change's planning artifacts. MemoryNet owns the approved decision; this file is generated context.</p>
      <form method="post" action="/projects/${view.project.id}/work">${csrfField(rc)}
        <label>Task title <input name="title" required maxlength="200"></label>
        <label>Repository ID <input name="repositoryId" required pattern="[1-9][0-9]{0,18}|local-[a-f0-9]{32}"></label>
        <label>Exact branch <input name="branch" required maxlength="255" placeholder="main"></label>
        <label>Full source commit <input name="codeCommit" required pattern="[a-f0-9]{40}|[a-f0-9]{64}"></label>
        <label>Spec path <input name="path" required maxlength="500" placeholder="openspec/changes/retry-policy/specs/retries/spec.md"></label>
        <label>Requirement ID <input name="requirementId" required maxlength="100" placeholder="RETRY-001"></label>
        <label>Exact spec text <textarea name="specText" required rows="8" maxlength="100000" placeholder="Paste the spec at the source commit. We hash this text and retain only its hash."></textarea></label>
        <p class="hint">The hash covers the UTF-8 text received by this form; browsers can normalize line endings. It is a declared baseline, not proof the text matches Git.</p>
        <fieldset><legend>Approved decisions</legend>
          ${available.length ? available.map((m) => html`<label><input type="checkbox" name="decisions" value="${m.id}@${m.revision}">
            ${m.title} · version ${m.revision} · repository ${m.applicability!.repositoryId} · branch ${m.applicability!.branch}</label>`)
            : html`<p>No current scoped decisions are available. <a href="/projects/${view.project.id}#propose-memory">Propose a decision</a> with reviewed repository and branch applicability first.</p>`}
          <p class="hint">Choose up to 20 decisions for the same exact repository and branch. Up to 200 recent approved records are considered.</p>
        </fieldset>
        <button type="submit">Create context baseline</button>
      </form></section>` : ""}` });
}
async function create(rc: RequestContext) {
  const specText = rc.form.get("specText") ?? "";
  if (!specText.trim() || specText.length > 100_000) throw new ValidationError("Include the exact spec text (up to 100,000 characters)");
  const decisions = rc.form.getAll("decisions").flatMap((value) => value.trim().split(/\r?\n/)).map((line) => {
    const [memoryId, revision, extra] = line.trim().split("@");
    if (extra !== undefined || !revision || !/^[1-9][0-9]*$/.test(revision)) throw new ValidationError("Use one memory UUID@revision per line");
    return { memoryId: memoryId!, revision: Number(revision) };
  });
  await createWork(rc.ctx, requireUser(rc).id, { projectId: rc.params.id!, title: rc.form.get("title")!,
    repositoryId: rc.form.get("repositoryId")!, branch: rc.form.get("branch")!, codeCommit: rc.form.get("codeCommit")!,
    artifacts: [{ kind: "spec", path: rc.form.get("path")!, requirementId: rc.form.get("requirementId")!, sha256: createHash("sha256").update(specText).digest("hex") }], decisions });
  return redirect(`/projects/${rc.params.id}/work`);
}
async function download(rc: RequestContext) {
  const bundle = await exportWork(rc.ctx, requireUser(rc).id, rc.params.id!);
  const json = rc.params.format === "json";
  // Fenced JSON preserves exact approved text without interpreting source text as Markdown.
  const body = json ? JSON.stringify(bundle, null, 2) : [
    "# MemoryNet approved decision context", "", `Generated: ${bundle.checkedAt.toISOString()}`,
    `Work: ${bundle.work.id}`, `Repository: ${bundle.work.repositoryId}; exact branch: ${bundle.work.branch}`,
    `Source commit: ${bundle.work.codeCommit}`, "", bundle.verification, "",
    "Revalidate in MemoryNet before finalizing work. A generated file may become stale after download.",
    "Do not edit this file to change authority. Review decision changes in MemoryNet and create a fresh baseline.", "",
    "## Linked spec requirements", "```json", JSON.stringify(bundle.work.artifacts, null, 2), "```",
    "", "## Approved decisions", "```json", JSON.stringify(bundle.decisions, null, 2), "```", "",
  ].join("\n");
  return { status: 200, headers: { ...SECURITY_HEADERS, "Cache-Control": "no-store",
    "Content-Type": json ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="memorynet-context.${json ? "json" : "md"}"` }, body };
}
export const workRoutes: readonly Route[] = [
  { method: "GET", pattern: /^\/projects\/(?<id>[^/]+)\/work$/, access: "user", handle: workPage },
  { method: "POST", pattern: /^\/projects\/(?<id>[^/]+)\/work$/, access: "user", handle: create },
  { method: "GET", pattern: /^\/work\/(?<id>[^/]+)\/context\.(?<format>json|md)$/, access: "user", handle: download },
  { method: "POST", pattern: /^\/work\/(?<id>[^/]+)\/close$/, access: "user", handle: async (rc) => {
    await closeWork(rc.ctx, requireUser(rc).id, rc.params.id!);
    return redirect("/");
  } },
];
