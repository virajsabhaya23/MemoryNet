# Experiment A — execution status

- Updated (UTC): 2026-11-04
- Status: **baseline verified; agent runs not yet executed.**

## Completed

- Task 1 quality floor: see `a1-quality-floor.md` (conditional pass in
  sandbox; loopback tests need an unrestricted run).
- Task 2 prep: both ESLint arms installed and verified broken
  (`task-2-prep.md`). Frozen-input hashes recorded.
- MemoryNet demo approved guidance exists: proposal
  "Controlled consumer: historical ESLint v9 compatibility" is **approved**,
  memory `3b363a47-8c36-43fd-894a-c136757f3169` revision 1
  (demo snapshot 2026-11-04T01:30:10Z). Demo server runs on :3062.
- Baseline oracle scores (untouched starters, both expected to fail):
  - Arm A `.local/experiment-a/eslint-maintained-instructions`:
    `outcome: fail`, reason "remove obsolete switches without disabling
    lookup", 2026-11-04T01:56:54Z, exit 1.
  - Arm B `.local/experiment-a/eslint-memorynet`:
    `outcome: fail`, same reason, 2026-11-04T01:56:50Z, exit 1.

## Not executed — and why

No coding-agent run has touched either arm (verified: no
`eslint.config.js` in either directory). Three in-session launch paths were
attempted repeatedly:

1. Agent tool — platform classifier unavailable on every spawn.
2. Workflow tool — same classifier error (it succeeded once earlier for the
   read-only second-opinion review, then regressed).
3. Nested `claude -p` fresh session via shell — sandbox proxy denies
   `api.anthropic.com` / `api.meta.ai`; declaring those domains routes the
   command through the unavailable classifier instead.

Running the migration from the main session would contaminate the
comparison (this session knows the oracle and both guidance channels), so
it was deliberately not done.

## Exact commands to execute the arms (outside the sandbox)

Run each in a fresh Claude Code session (`!` prefix here, or your own
terminal). Same model and settings for both; time each run.

Arm B first:

```sh
! cd /Users/virajsabhaya/Desktop/MemoryNet/.local/experiment-a/eslint-memorynet && claude -p "Work only in this directory. Do not read the other arm, any AGENTS.md, oracle.mjs, controls, or evaluator files. Task is in TASK.md in this directory: execute it exactly, run lint and tests, report files changed and evidence." --permission-mode acceptEdits
```

Then Arm A (fresh session, its AGENTS.md is its guidance):

```sh
! cd /Users/virajsabhaya/Desktop/MemoryNet/.local/experiment-a/eslint-maintained-instructions && claude -p "Work only in this directory; you may read AGENTS.md in this directory. Do not read the other arm, oracle.mjs, or evaluator files. Task is in TASK.md in this directory: execute it exactly, run lint and tests, report files changed and evidence." --permission-mode acceptEdits
```

Score both afterwards (this part works in-session):

```sh
node examples/eslint-demo/scenario/oracle.mjs $PWD/.local/experiment-a/eslint-memorynet
node examples/eslint-demo/scenario/oracle.mjs $PWD/.local/experiment-a/eslint-maintained-instructions
```

Record per arm in the `experiment-a-smoke.md` sheet: oracle outcome, wall
time, interventions, human maintenance minutes (demo approval time counts
against Arm B; Arm A has none). Then complete Task 3 (paired Affected Work
loop, needs a second human), Task 4 (commit + CI hardening), and Task 5
(decision memo) per `audit-assignments.md`.
