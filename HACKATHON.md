# Hackathon — MemoryNet demo script (3 minutes, free tier, offline-capable)

Everything below runs locally with no paid services, no API key, and no
account. If the live app cannot run in the venue, open the static replay at
`website/demo.html` (or the generated `.local/decision-demo/index.html`).

## The pitch in one line

Mem0 remembers what was said. claude-mem remembers what happened.
**MemoryNet remembers what was decided — approved by a human, scoped to a
repo/branch, cited to evidence, and enforced when it changes.**

## Run it

```sh
npm ci --ignore-scripts
npm run demo        # isolated lifecycle demo; writes .local/decision-demo/
npm start           # optional: full local app on http://127.0.0.1:3050
npm run site:serve  # optional: this website locally
```

## 3-minute flow

| Time | Do | Say |
| --- | --- | --- |
| 0:00 | Open the website hero / demo replay | "AI agents build on decisions teams already reversed. Git and AGENTS.md can't tell them which version is current, approved, or scoped to this branch." |
| 0:30 | Show pending proposal -> owner approves exact revision | "Agents may propose. Only a different human can approve, and approval binds the exact text, paths, repo, branch, and validity window." |
| 1:15 | Show `get_task_context` via MCP | "Before editing, the agent gets approved, current, permission-filtered context — with reasons, citations, and a retrieval receipt. No results is explicit, never a silent miss." |
| 2:00 | Approve a replacement decision | "Now the decision changes." |
| 2:20 | Open Affected Work | "Every task pinned to v1 is flagged stale, and stale context export is refused until revalidated. That's the moment every other memory tool misses." |
| 2:45 | Show ledger / receipts | "Every approval and delivery is SHA-256 chained and verifiable offline: `npm run ledger:verify`." |

## Why it wins (judging map)

- **Innovation:** governed decision memory — exact-version human approval,
  repo+branch+path+time scoping, stale-work radar. No major rival
  (Mem0, claude-mem, Graphify, Zep) enforces approval or stale-export refusal.
- **Technical depth:** versioned memories with reviewed links
  (`depends_on`/`refines`/`conflicts_with`), bounded graph expansion with
  explainable reasons, tamper-evident audit ledger, MCP with scoped,
  expiring bindings. 456 automated tests.
- **Design:** Hallmark Cobalt design system across the app and website —
  deep-cobalt premium hero, IBM Plex Sans / Familjen Grotesk / JetBrains
  Mono, accessible focus and reduced-motion support, phone-width layout.
- **Honesty as a feature:** synthetic fixtures are labelled synthetic,
  scripted controls are not agent results, and unproven claims are stated
  as unproven (`docs/evaluation.md`). Effectiveness validation is
  preregistered (`docs/validation/`).
- **Free and local-first:** Apache-2.0, embedded database, no hosted
  dependency, no model key required for the core workflow.

## Fallbacks

- No network: everything above is local; the static replay needs no server.
- No time to approve live: the demo script performs fixture approvals and
  prints `PASS: exact quote -> pending withheld -> approval -> MCP receipt
  -> replacement -> stale export blocked -> fresh context.`
- Deep questions: `docs/trust.md` (guarantees), `docs/architecture.md`,
  `docs/validation/second-opinion.md` (independent competitive review).
