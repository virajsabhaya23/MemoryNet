import { html } from "../web/html.ts";
import type { DecisionDemoReport } from "./decision-demo.ts";

/** Static, escaped replay of an executed integration run. Contains no live workspace controls. */
export function renderDecisionDemo(report: DecisionDemoReport): string {
  const old = report.before.current[0]!;
  const current = report.after.current[0]!;
  const text = report.quote.text ?? "";
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemoryNet · See a decision change</title>
<meta name="description" content="Follow an executed MemoryNet demo: exact evidence, approval, MCP context, stale-work detection, and fresh context.">
<link rel="icon" href="./assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="./assets/styles.css"><link rel="stylesheet" href="./assets/demo.css"></head>
<body><a class="skip-link" href="#main">Skip to content</a>
<header class="site-header container demo-header"><a class="wordmark" href="./"><img src="./assets/mark.svg" width="36" height="36" alt="">MemoryNet</a>
<nav aria-label="Demo navigation"><a href="./">Product</a><a href="./guide.html">Setup guide</a><a href="./demo-report.json">Run evidence (JSON)</a></nav></header>
<main id="main" class="container demo-page">
<p class="demo-eyebrow">A three-minute walkthrough · read-only replay</p>
<h1>A decision changes.<br>Catch the work it leaves behind.</h1>
<p class="demo-lead">An agent starts with the approved retry policy. The team reverses it. MemoryNet flags the pinned task, blocks its stale context export, and gives the next agent the replacement with citations.</p>
<p class="demo-disclosure">This replay comes from an executed, isolated integration run. Evidence, extraction responses and approvals are synthetic fixtures. The database, quote validation, review rules, MCP clients and export checks are real. No live model call or coding-agent implementation is represented.</p>
<nav class="demo-stages" aria-label="Walkthrough stages"><a href="#evidence">1. Evidence</a><a href="#approval">2. Approval</a><a href="#context">3. Agent context</a><a href="#change">4. Decision change</a><a href="#refresh">5. Fresh context</a></nav>
<details class="demo-step" id="evidence" open><summary><span>01</span> Extract a decision with an exact quote</summary>
<div class="demo-step-body"><p>AI Decision Extraction (Decision Guard) checks each quotation against the selected source. This offline run supplies a scripted response through the same validation path used by Meta.</p>
<blockquote>${text.slice(0, report.quote.start)}<mark>${report.quote.quote}</mark>${text.slice(report.quote.end)}</blockquote>
<p class="demo-meta">Validated UTF-16 span [${report.quote.start}, ${report.quote.end}). Provider: scripted-demo. Live Meta requests: ${report.metaCalls}.</p></div></details>
<details class="demo-step" id="approval" open><summary><span>02</span> Keep suggestions out of authoritative context</summary>
<div class="demo-step-body"><p>The candidate enters review as a pending proposal. An MCP query returns <strong>${report.pending.outcome}</strong> before approval. The agent’s attempt to approve is refused.</p>
<p>A distinct fixture reviewer approves the exact proposal revision. In a real workflow, this is an authorized person reviewing the evidence.</p>
<p class="demo-meta">Proposal ${report.proposalId} · approved decision ${old.memoryId} · revision ${old.revision}.</p></div></details>
<details class="demo-step" id="context" open><summary><span>03</span> Deliver approved context and pin the task</summary>
<div class="demo-step-body"><p>A real MCP SDK client retrieves guidance for repository <code>${report.scope.repositoryId}</code>, branch <code>${report.scope.branch}</code>. The task “${report.work.title}” pins that exact decision.</p>
<blockquote>${old.content}</blockquote><p class="demo-state">Initial work baseline: ${report.work.before}. Context export succeeds.</p>
<p class="demo-meta">Agent Audit Trail · retrieval receipt ${report.before.retrievalId}.</p></div></details>
<details class="demo-step" id="change" open><summary><span>04</span> Reverse the decision. See the affected work.</summary>
<div class="demo-step-body"><p>A replacement proposal removes HTTP 429 retries. Its scripted conflict hint names decision <code>${report.conflict.memoryId}</code>, revision ${report.conflict.revision}. The original remains authoritative while the replacement is pending.</p>
<p>After the fixture reviewer approves the replacement, Stale-Work Radar (Affected work) finds the task pinned to superseded guidance.</p>
<p class="demo-state demo-state-alert">${report.work.after} · stale context export blocked</p>
<p>Refreshing an agent query does not silently update the task’s baseline. A person must review the affected work and record a new baseline.</p></div></details>
<details class="demo-step" id="refresh" open><summary><span>05</span> A fresh agent receives the replacement</summary>
<div class="demo-step-body"><p>A second MCP SDK client receives only the replacement decision and its source citations.</p><blockquote>${current.content}</blockquote>
<p class="demo-meta">Decision ${current.memoryId} · revision ${current.revision} · receipt ${report.after.retrievalId}.</p>
<p>Replacement creates a new decision ID at revision 1. These are successive policies, not revision 1 and revision 2 of one record.</p>
<p class="demo-state">${report.receipts.length} retrieval receipts recorded · ${report.freshProtocolClients} protocol clients · all lifecycle assertions passed</p></div></details>
<section class="demo-reproduce"><h2>Run it yourself</h2><pre><code>npm ci --ignore-scripts
npm run demo</code></pre><p>The command uses temporary storage, makes no external API requests, and writes a new report under <code>.local/decision-demo/</code>. No persona switching or credentials needed. <code>npm run demo -- --website</code> regenerates this static replay locally.</p>
<p>Recorded ${report.recordedAt} on ${report.nodeVersion}. This demonstrates context freshness and governance. It does not measure code correctness, comparative agent effectiveness or production readiness.</p><a href="./demo-report.json">Inspect the machine-readable result</a> · <a href="./guide.html#limits">Deployment boundaries</a></section>
</main><footer class="site-footer container"><p>Reviewed decisions. Traceable agent context.</p><a href="./">Back to MemoryNet</a></footer></body></html>`.__html;
}
