# Experiment A — smoke run setup (AGENTS.md baseline vs MemoryNet)

Status: **prepared, not executed.** No coding-agent comparison has been run;
controls in this repo are scripted controls, not agent results
(`examples/eslint-demo/controls/README.md`). Executing the arms requires a
coding agent with a model budget and, for the MemoryNet loopback server, a
shell that may bind `127.0.0.1` (sandboxes without local port permission fail
with `listen EPERM` — run with the `!` prefix in your own terminal if needed).

## What already exists (do not rebuild)

| Piece | Location |
| --- | --- |
| Frozen coding arms (6) | `src/evaluation/coding-demo.ts` — `CODING_ARMS` |
| Retry-policy oracle (3,020 cases) | `src/evaluation/retry-policy-oracle.mjs` |
| ESLint flat-config task + oracle | `examples/eslint-demo/scenario/` (`TASK.md`, `oracle.mjs`) |
| Maintained-instructions control | `examples/eslint-demo/controls/MAINTAINED-AGENTS.md` |
| Preregistration freeze | `npm run eval:preregister` (`src/evaluation/preregistration.ts`) |
| Synthetic Affected Work check | `npm run eval:work` (verified passing 2026-11-03) |
| Synthetic scoped-context check | `npm run eval:smoke` (needs loopback bind) |

Smoke vs study: a preregistered `purpose: "study"` requires at least 10
decision-change tasks (`preregistration.ts`); 3 tasks is a smoke run and must
be reported as one.

## Primary metrics (from the preregistration schema)

1. `stale_implementation_rate` — implementations matching a superseded decision.
2. `human_maintenance_minutes` — all human time: MemoryNet setup + capture +
   review on the MemoryNet arm; editing `AGENTS.md`/instructions on control arms.

Secondary: total task time, agent tokens/cost, manual interventions, oracle pass.

## Runbook — synthetic retry-policy arms (fastest smoke)

```sh
npm ci --ignore-scripts
npm run eval:work        # synthetic affected-work gate, no server needed

# Prepare the frozen arm directories and binding (starts a loopback server;
# keep it running while agents work, Ctrl+C saves receipts):
npm run eval:coding -- serve .local/experiment-a/retry-v1
```

This creates one directory per arm under `.local/experiment-a/retry-v1/`
(each with `TASK.md`, starter `retry-policy.mjs`, frozen evidence files) plus
`connection.json` for the MemoryNet arms. Give each arm to a fresh agent
session with the same model, budget, and tools; keep the oracle and other
arms out of agent context. Verify each result:

```sh
npm run eval:coding -- verify .local/experiment-a/retry-v1 <arm-name>
```

## Runbook — ESLint arms (real-toolchain smoke)

```sh
# Per arm: copy the starter without node_modules, install pinned deps
cp -R examples/eslint-demo/scenario/start .local/experiment-a/eslint-<arm>
npm --prefix .local/experiment-a/eslint-<arm> ci --ignore-scripts --no-audit --no-fund

# Maintained-instructions arm only:
cp examples/eslint-demo/controls/MAINTAINED-AGENTS.md .local/experiment-a/eslint-maintained/AGENTS.md

# MemoryNet arm: same starter, plus MemoryNet running for the demo workspace
# with the flat-config decision approved (see examples/eslint-demo/README.md).

# Score every arm identically:
node examples/eslint-demo/scenario/oracle.mjs /absolute/path/to/eslint-<arm>
```

## Recording sheet (one row per arm run)

| Field | Value |
| --- | --- |
| Arm / task / repetition | |
| Model + parameters, budget | |
| Human maintenance minutes (setup, capture, review / instruction edits) | |
| Total wall time, agent tokens, cost | |
| Oracle pass? Stale implementation? | |
| Manual interventions (count + what) | |
| Retrieval IDs / approved revisions delivered (MemoryNet arms) | |

Record failed MemoryNet runs with the same detail as passing controls.
Label every report `synthetic` (retry arms) or `authored-fixture` (ESLint)
until a naturally occurring repository task is run — see assignment A2 in
`audit-assignments.md`.
