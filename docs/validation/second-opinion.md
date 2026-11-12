# Second opinion — subagent fan-out on the external assessment

Five agents (product, security, competitive, audit-plan, synthesis) reviewed
the external production-readiness/usefulness assessment independently.
Overall agreement: **8/10** — direction confirmed, execution corrected.

## What all reviewers confirmed

- Prove usefulness before production is the right sequence. The repo itself
  disclaims effectiveness (`docs/evaluation.md` historical observations;
  `docs/production-readiness.md`: "Product effectiveness and repeat adoption
  are unproven").
- All six production blockers are real: auth, permission sync, private
  ingestion, PGlite recovery, secret/supply-chain hygiene, OpenSSF L1 gap.
- Defer semantic/embedding search, graph UI, and new connectors. Lexical
  `tsvector` + path anchors + spreading activation (`src/task-context.ts`)
  covers current cases; the moat is exact-version review, scoping, and
  receipts — not recall parity with Mem0/claude-mem/Graphify.

## Top corrections to the assessment

1. **Do not rebuild Experiments A/B — run them.** `src/evaluation/coding-demo.ts`
   freezes six arms with an oracle and `scientificEffectiveness: false`;
   `src/evaluation/preregistration.ts` already requires >=10 tasks for a
   study and names the metrics (`stale_implementation_rate`,
   `human_maintenance_minutes`). The ESLint maintained-instructions control
   (`examples/eslint-demo/controls/`) also exists. Remaining work is
   execution with pinned model/budget — and stale-instruction arms are
   negative controls, so only maintained-instructions parity counts.
2. **Solo signal overweighted; Test C as specified is invalid.** Publishing
   requires a different human who wrote no version (`docs/trust.md`), so five
   solo developers cannot complete propose -> approve -> retrieve. Redesign
   as 2-3 paired teams on public/synthetic evidence, plus a second decision
   change weeks later to test repeat adoption.
3. **"No app CI" is true only for public HEAD.** Tracked workflows at HEAD:
   only `.github/workflows/deploy-pages.yml`. Locally, `check.yml` (full
   typecheck + test matrix, SHA-pinned), `pages.yml`, and `cla.yml` exist but
   are uncommitted — as are `docs/trust.md`, `docs/production-readiness.md`,
   and `docs/evaluation.md`. Before pushing: reconcile the duplicate Pages
   publishers (`deploy-pages.yml` auto vs `pages.yml` manual), pin
   `deploy-pages.yml` floating action tags to SHAs, and commit the docs the
   public assessment cites.
4. **Reject the single mega-assignment.** Auditor, usability subjects, and
   experiment operator must be independent; no CONTINUE/NARROW/PIVOT verdict
   until the preregistered bar is met. Split version: `audit-assignments.md`.

## Measurable triggers adopted

- Semantic search: prototype a hybrid re-ranker only if a 100-task eval on
  current retrieval shows top-5 recall < 0.70 on paraphrased tasks **and**
  > 30% of failures are vocabulary mismatch (not missing/stale/unscoped).
- Automation: expand setup/binding automation when usability timings show
  setup+review overhead exceeding measured task benefit.

## Single recommended gate (synthesis)

Run the 1-day ESLint parity comparison (maintained `AGENTS.md` vs MemoryNet,
one fixed model/budget, oracle outside agent context, recording
`stale_implementation_rate` + operator maintenance minutes) plus one paired
two-human Affected Work loop (approve v1 -> pin -> approve replacement ->
flag/refuse stale). Gate all further audit/scale work on matching or beating
maintained instructions there. Prepared in `experiment-a-smoke.md`.
