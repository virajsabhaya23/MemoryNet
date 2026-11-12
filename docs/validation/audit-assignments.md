# Split audit assignments (replaces the single mega-assignment)

The external assessment proposed one agent run covering security audit, usability,
controlled coding comparison, and a CONTINUE / NARROW / PIVOT verdict. That is
rejected as a single assignment: the auditor would also be the experiment
executor (not independent), usability needs humans, and the coding comparison
needs a preregistered model budget. Run these four instead, in order. Each has
an exit criterion; a failed exit stops the next assignment.

## A1 — Quality floor and security checklist (1 day, agent + human spot-check)

Scope: CI, smoke commands, dependency and secret hygiene. No product code changes.

- Commit `.github/workflows/check.yml` and make it a required status check.
  It already runs `npm ci --ignore-scripts` + `npm run check` + the ESLint demo
  verifier on Ubuntu/Windows, Node 24/26. Add `npm audit --audit-level=high`
  and `npm run site:check`.
- Run and record: `npm run check`, `npm run eval:smoke`, `npm run eval:work`,
  `node examples/eslint-demo/verify.mjs`. Note: loopback-binding tests fail in
  sandboxes without local port permission (`listen EPERM`); CI is the authority.
- Secret-scan git history and release artifacts; enable Dependabot and secret
  scanning on the public repository.
- Walk the OpenSSF OSPS Baseline Level 1 checklist as a *checklist only*;
  record pass/fail per control with evidence links. Do not claim compliance.

Exit: CI green on a clean clone, audit clean or triaged, scan results recorded
in `docs/validation/results/a1-quality-floor.md`.

## A2 — Execute the preregistered coding comparison (Experiment A, smoke then study)

Scope: run the harness that already exists; do not design a new one.

- Arms are frozen in `src/evaluation/coding-demo.ts` (`CODING_ARMS`):
  `baseline`, `memorynet`, `repo-instructions` (negative control),
  `dated-sources`, `repo-memorynet`, `maintained-instructions` (positive
  control). Results are labelled `scientificEffectiveness: false` until a real
  agent study is executed and recorded.
- Smoke: 3 decision-change tasks. Study: at least 10, as required by
  `src/evaluation/preregistration.ts` for `purpose: "study"`.
- Freeze first with `npm run eval:preregister -- <manifest.json> <clean-repo>
  <new-lock.json>` (clean HEAD, pinned origin, hashed artifacts).
- Primary metrics (already in the preregistration schema):
  `stale_implementation_rate` and `human_maintenance_minutes` — the latter
  includes MemoryNet setup, capture, and review time, and AGENTS.md editing
  time on the control arm. Secondary: total task time, tokens/cost,
  interventions, oracle pass.
- Publish raw per-arm results, including failed MemoryNet runs.

Exit: smoke results recorded in `docs/validation/results/a2-experiment-a.md`;
study proceeds only if smoke shows a stale-implementation difference or a
maintenance-time difference worth measuring at n>=10.

## A3 — Human usability and team handoff (humans, not an agent)

Scope: first-time-user test (Experiment C) corrected for the review rule.

- 5 developers **in pairs** (author + different approver), because a proposal
  can never be approved by its author (`docs/trust.md`). A solo participant
  who cannot complete approval is a recorded finding, not a facilitator rescue.
- Task: "Track an engineering decision and retrieve it from your coding agent,"
  using only public docs. No coaching.
- Record segmented times: install, workspace setup, first proposal, approval,
  MCP connection, first useful retrieval. Targets (smoke thresholds, not
  industry benchmarks): 4/5 pairs complete, first useful retrieval < 10 min
  after install, no unexplained critical failure, 3/5 pairs would repeat.
- Add the team-handoff variant the solo test misses: agent proposes, a second
  human approves, the decision changes, and a second task/agent must be
  flagged stale via Affected Work (`npm run eval:work` covers the synthetic
  path; this covers the experienced one).

Exit: timings and verbatim blockers recorded in
`docs/validation/results/a3-usability.md`.

## A4 — Decision memo (human, informed by A1–A3)

One page, written by a human, stored at `docs/validation/decision.md`:

- PUBLIC OPEN-SOURCE ALPHA: PASS / CONDITIONAL / FAIL (public/synthetic data only)
- PRODUCTION (private/shared): PASS / CONDITIONAL / FAIL
- MEASURED USEFULNESS: PASS / CONDITIONAL / FAIL
- Decision: CONTINUE / NARROW / PIVOT, with the incident evidence:
  name the concrete development incidents MemoryNet prevented or accelerated.
  If none can be named, the decision is NARROW or PIVOT regardless of test counts.

## What not to build until A2/A3 report

Semantic/embedding search, a new graph UI, and new connectors are deferred.
Trigger to revisit semantic search: Experiment A failures where the correct
decision existed but lexical retrieval missed it on paraphrase. Trigger for
more automation: A3 timings where setup/review overhead exceeds task benefit.
Already-approved near-term work (from both reviews): near-automatic setup and
multi-project binding switching, in-place ADR/spec ingestion, stale detection
in the PR flow, and posting the existing check summary
(`src/checks.ts`, currently never posted and always neutral) via a GitHub App.
