import { escapeHtml, html, type SafeHtml } from "../web/html.ts";
import type { DecisionDemoReport } from "./decision-demo.ts";

/** Escaped text with camelCase identifiers set as code, for the diff of the two policies. */
function withIdentifiers(text: string): SafeHtml {
  return {
    __html: text
      .split(/(\b[a-z]+[A-Z][A-Za-z0-9]*\b)/)
      .map((part, index) => (index % 2 === 1 ? `<code>${escapeHtml(part)}</code>` : escapeHtml(part)))
      .join(""),
  };
}

/** Static, escaped replay of an executed integration run. Contains no live workspace controls. */
export function renderDecisionDemo(report: DecisionDemoReport): string {
  const old = report.before.current[0]!;
  const current = report.after.current[0]!;
  const text = report.quote.text ?? "";
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemoryNet · See a decision change</title>
<meta name="description" content="Follow an executed MemoryNet demo: exact evidence, approval, MCP context, stale-work detection, and fresh context.">
<meta name="theme-color" content="#15191c">
<link rel="icon" href="./assets/icon.svg" type="image/svg+xml">
<link rel="preload" href="./assets/host-grotesk-latin-variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="./assets/styles.css"><link rel="stylesheet" href="./assets/demo.css">
<script src="./assets/site.js" defer></script>
</head>
<body><a class="skip-link" href="#main">Skip to content</a>
<header class="site-header demo-header">
  <div class="container site-header__bar">
    <a class="wordmark" href="./"><img src="./assets/mark.svg" width="36" height="36" alt="">MemoryNet</a>
    <button class="nav-toggle" type="button" aria-controls="main-navigation" aria-expanded="false" hidden>Menu</button>
    <nav id="main-navigation" aria-label="Demo navigation"><a href="./">Product</a><a href="./guide.html">Setup guide</a><a href="./demo-report.json">Run evidence (JSON)</a></nav>
  </div>
</header>
<main id="main" class="demo-main">
  <div class="demo-hero">
    <div class="container">
      <h1>A decision changes.<br>Catch the work it leaves behind.</h1>
      <p class="demo-lead">An agent starts with the approved retry policy. The team reverses it.</p>
      <nav class="demo-stages" aria-label="Walkthrough stages"><a href="#evidence">1. Evidence</a><a href="#approval">2. Approval</a><a href="#context">3. Agent context</a><a href="#change">4. Decision change</a><a href="#refresh">5. Fresh context</a></nav>
    </div>
  </div>

  <section class="demo-trail" aria-labelledby="replay-title">
    <div class="container">
      <div class="demo-run">
        <h2 id="replay-title">A three-minute walkthrough, read-only replay.</h2>
        <p class="demo-run__lead">MemoryNet flags the pinned task, blocks its stale context export, and gives the next agent the replacement with citations.</p>
        <p class="demo-disclosure">This replay comes from an executed, isolated integration run. Evidence, extraction responses and approvals are synthetic fixtures. The database, quote validation, review rules, MCP clients and export checks are real. No live model call or coding-agent implementation is represented.</p>
      </div>

      <ol class="trail">
        <li class="trail__stage" id="evidence">
          <div class="trail__text">
            <h3>Extract a decision with an exact quote</h3>
            <p>AI Decision Extraction (Decision Guard) checks each quotation against the selected source. This offline run supplies a scripted response through the same validation path used by Meta.</p>
          </div>
          <div class="trail__records">
            <figure class="demo-record">
              <blockquote>${text.slice(0, report.quote.start)}<mark>${report.quote.quote}</mark>${text.slice(report.quote.end)}</blockquote>
              <figcaption class="demo-meta"><span class="reading">Validated UTF-16 span [${report.quote.start}, ${report.quote.end}). Provider: scripted-demo. Live Meta requests: ${report.metaCalls}.</span></figcaption>
            </figure>
          </div>
        </li>
        <li class="trail__stage" id="approval">
          <div class="trail__text">
            <h3>Keep suggestions out of authoritative context</h3>
            <p>The candidate enters review as a pending proposal. An MCP query returns <strong class="reading">${report.pending.outcome}</strong> before approval. The agent’s attempt to approve is refused.</p>
            <p>A distinct fixture reviewer approves the exact proposal revision. In a real workflow, this is an authorized person reviewing the evidence.</p>
          </div>
          <div class="trail__records">
            <dl class="readings">
              <div><dt>Proposal</dt><dd class="reading">${report.proposalId}</dd></div>
              <div><dt>Approved decision</dt><dd class="reading">${old.memoryId}</dd></div>
              <div><dt>Revision</dt><dd class="reading">${old.revision}</dd></div>
            </dl>
          </div>
        </li>
        <li class="trail__stage" id="context">
          <div class="trail__text">
            <h3>Deliver approved context and pin the task</h3>
            <p>A real MCP SDK client retrieves guidance for repository <code>${report.scope.repositoryId}</code>, branch <code>${report.scope.branch}</code>. The task “${report.work.title}” pins that exact decision.</p>
          </div>
          <div class="trail__records">
            <figure class="demo-record">
              <blockquote>${old.content}</blockquote>
              <figcaption class="demo-meta">Agent Audit Trail: retrieval receipt <span class="reading">${report.before.retrievalId}</span>.</figcaption>
            </figure>
            <p class="demo-state">Initial work baseline: ${report.work.before}. Context export succeeds.</p>
          </div>
        </li>
        <li class="trail__stage trail__stage--lead" id="change">
          <div class="trail__text">
            <h3>Reverse the decision. See the affected work.</h3>
            <p>A replacement proposal removes HTTP 429 retries. Its scripted conflict hint names decision <code>${report.conflict.memoryId}</code>, revision ${report.conflict.revision}. The original remains authoritative while the replacement is pending.</p>
            <p>After the fixture reviewer approves the replacement, Stale-Work Radar (Affected work) finds the task pinned to superseded guidance.</p>
            <p>Refreshing an agent query does not silently update the task’s baseline. A person must review the affected work and record a new baseline.</p>
          </div>
          <div class="trail__records">
            <ol class="demo-diff" aria-label="Retry policy, replaced">
              <li class="change change--old"><span class="change__sign" aria-hidden="true">−</span><span class="change__id"><span class="reading">${old.memoryId.slice(0, 8)}</span><span class="reading">rev ${old.revision}</span></span><del><span class="visually-hidden">Replaced: </span>${withIdentifiers(old.content)}</del></li>
              <li class="change change--new"><span class="change__sign" aria-hidden="true">+</span><span class="change__id"><span class="reading">${current.memoryId.slice(0, 8)}</span><span class="reading">rev ${current.revision}</span></span><ins><span class="visually-hidden">Replacement: </span>${withIdentifiers(current.content)}</ins></li>
            </ol>
            <p class="demo-state demo-state-alert"><span class="reading reading--bad">${report.work.after}</span><span>stale context export blocked</span></p>
          </div>
        </li>
        <li class="trail__stage" id="refresh">
          <div class="trail__text">
            <h3>A fresh agent receives the replacement</h3>
            <p>A second MCP SDK client receives only the replacement decision and its source citations.</p>
            <p>Replacement creates a new decision ID at revision 1. These are successive policies, not revision 1 and revision 2 of one record.</p>
          </div>
          <div class="trail__records">
            <figure class="demo-record">
              <blockquote>${current.content}</blockquote>
            </figure>
            <dl class="readings">
              <div><dt>Decision</dt><dd class="reading">${current.memoryId}</dd></div>
              <div><dt>Revision</dt><dd class="reading">${current.revision}</dd></div>
              <div><dt>Receipt</dt><dd class="reading">${report.after.retrievalId}</dd></div>
            </dl>
            <ul class="demo-results">
              <li><span class="reading">${report.receipts.length}</span> retrieval receipts recorded</li>
              <li><span class="reading">${report.freshProtocolClients}</span> protocol clients</li>
              <li>all lifecycle assertions passed</li>
            </ul>
          </div>
        </li>
      </ol>

      <div class="demo-reproduce demo-reproduce--grid" id="reproduce">
        <div class="demo-reproduce__copy">
          <h2>Run it yourself</h2>
          <p>The command uses temporary storage, makes no external API requests, and writes a new report under <code>.local/decision-demo/</code>. No persona switching or credentials needed. <code>npm run demo -- --website</code> regenerates this static replay locally.</p>
          <p>Recorded <time datetime="${report.recordedAt}">${report.recordedAt}</time> on ${report.nodeVersion}. This demonstrates context freshness and governance. It does not measure code correctness, comparative agent effectiveness or production readiness.</p>
          <p class="demo-links"><a href="./demo-report.json">Inspect the machine-readable result</a><a href="./guide.html#limits">Deployment boundaries</a></p>
        </div>
        <div class="command-block"><div class="command-heading"><span>Terminal</span><button class="button copy-button" type="button" data-copy="reproduce-commands">Copy commands</button><span role="status" aria-live="polite"></span></div><pre><code id="reproduce-commands"><span class="ln">npm ci --ignore-scripts</span>
<span class="ln">npm run demo</span></code></pre></div>
      </div>
    </div>
  </section>
</main>
<footer class="site-footer">
  <div class="container">
    <a class="wordmark mast__wordmark" href="./"><img src="./assets/mark.svg" alt="" width="32" height="32">MemoryNet</a>
    <div class="mast__row">
      <p>Reviewed decisions. Traceable agent context.</p>
      <div class="mast__links"><a href="./">Back to MemoryNet</a></div>
    </div>
  </div>
</footer>
</body></html>
`.__html;
}
