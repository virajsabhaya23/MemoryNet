# A2 — Experiment A smoke: next public migration trial (ESLint v9→v10)

- Date (UTC): 2026-11-04 20:36–20:40
- Classification: **authored-fixture** (controlled consumer, genuine upstream
  evidence). n=1 per arm. This is a smoke run, not a study; it does not
  establish superiority over maintained instructions.
- Executors: two fresh subagent sessions, each confined to its own arm
  directory, same task text, same frozen starter, oracle kept out of both
  contexts. Orchestrator scored afterwards.

## Trial design

- **Old code gives a wrong result:** frozen starter pins ESLint 10.0.0 but
  keeps `.eslintrc.cjs` + `ESLINT_USE_FLAT_CONFIG=false`. `npm run lint`
  exits 2 ("couldn't find eslint.config"); baseline oracle on both untouched
  arms: `outcome: fail`, reason "remove obsolete switches without disabling
  lookup" (2026-11-04T20:36:44Z).
- **Already-compatible case kept:** `src/greet.js` is valid under the current
  policy and had to survive untouched. SHA-256 before = after, both arms:
  `fe1997a23416f1b8ac53af929c63716e89a3d97404cf94e0d49b9f8f5f9da275`.
  Oracle "valid module" probe: 0 errors, both arms. `npm test` passed
  before (frozen controls) and after the migration, both arms.
- **Arm A — maintained AGENTS.md:** `controls/MAINTAINED-AGENTS.md` copied in
  as the arm's only guidance.
- **Arm B — MemoryNet:** current v10 decision proposed (agent) → approved
  (owner) → retrieved current-only with receipt, in an isolated trial
  database via the service layer. Delivery channel deviation, recorded:
  in-process service retrieval, not MCP loopback — the sandbox cannot bind
  loopback and the demo DB on :3062 is locked by an external process
  (PID 27860). Approved memory `3f25d0bb-2096-4e1d-84a2-194f234002f0`
  revision 1; receipt `53e58886-0239-47fa-8d20-9412e32d2854`; citation
  ESLint PR #20037 @ `c69fdacdb2e886b9d965568a397aa8220db3fe90`.
  Approval was operator-scripted, **not** human UI review (see review time).

## Results

| | Arm A maintained | Arm B MemoryNet |
| --- | --- | --- |
| Oracle | **pass** (8 checks) | **pass** (8 checks) |
| Agent wall time | 147.6 s | 64.0 s |
| Agent tokens / tool uses | 31,333 / 16 | 28,445 / 14 |
| Oracle runtime | 1.76 s | 1.80 s |
| Lint script produced | `eslint .` | `eslint src` |
| Stale implementation | no | no |

Both agents made the same repair: created `eslint.config.js` (flat,
`no-undef`/`no-unused-vars` errors, `eqeqeq: always`), deleted
`.eslintrc.cjs`, removed the env switch. Arm A's broader `eslint .` still
passes the oracle; noted as a scope deviation, not a failure. Arm A's wall
time includes a non-guidance false start (`npm error Missing script` from a
cwd reset, self-repaired) — do not read the 83 s delta as a guidance effect
at n=1.

Scripted controls (`verify.mjs`, 4.41 s): frozen lint exit 2 / test exit 0,
obsolete config **fail**, scripted positive **pass**, weakened-policy
(`eqeqeq: off`) **fail**, changed-application **fail** — all as expected.
Controls are evaluator checks, not agent results.

## Which warnings led to which repair

| Warning / signal | Source | Repair it led to |
| --- | --- | --- |
| "ESLint couldn't find an eslint.config.(js\|mjs\|cjs) file", exit 2 | `npm run lint` on frozen starter, both arms | Create flat `eslint.config.js`; delete `.eslintrc.cjs` |
| Lint script carries `ESLINT_USE_FLAT_CONFIG=false` (v9-only, per PR #17927; removed in v10, PR #20037) | Starter `package.json`; oracle pre-check | Remove switch → `eslint src` (B) / `eslint .` (A) |
| Probe `'unknownValue' is not defined` (`no-undef`, severity 2) | Oracle stdin probe | Rule preserved as error in new flat config |
| Probe `'unused' is assigned a value but never used` (`no-unused-vars`, severity 2) | Oracle stdin probe | Rule preserved as error |
| Probe `Expected '===' and instead saw '=='` (`eqeqeq`, severity 2) | Oracle stdin probe | `eqeqeq: ["error","always"]` preserved |
| `v10 ignores legacy environment switch` check | Oracle with `ESLINT_USE_FLAT_CONFIG=false` in env | Passes post-repair; confirms no reliance on the switch |
| `npm error Missing script: "lint"` | Arm A only (cwd reset) | Re-ran inside arm dir; process slip, no code effect |

No warning touched `src/greet.js`, `test/greet.test.js`, or
`package-lock.json` — the compatible case stayed compatible and byte-exact.

## Review time — what could and could not be measured

Measured (this run):

- MemoryNet service time, isolated DB: setup 1.61 s; historical proposal +
  approval cumulative 1.66 s; current proposal at 1.68 s; **scripted
  propose→approve gap: 33 ms**; retrieval with receipt inside 1.74 s total.
- Human-equivalent verification in-session: baseline oracle 0.1 s/arm,
  control suite 4.41 s, scoring oracle 1.8 s/arm. Whole trial wall clock:
  ~4 min (20:36:35Z → 20:40:40Z).

Not measured (do not quote the 33 ms as review time):

- Genuine human review time. This run's approval was operator-scripted
  after the orchestrator read the proposal against
  `MAINTAINED-AGENTS.md`; no human UI approval was timed. The earlier demo
  approval (2026-11-04T01:30:10Z, memory `3b363a47…`) likewise has no
  duration on record. `human_maintenance_minutes` for A2 still requires a
  human at :3062 approving the pending current-guidance proposal with a
  stopwatch — that number does not exist yet.

## Limits

- n=1 per arm, one task, same model family for both agents; token counts
  are subagent-session totals, cost not recorded.
- MemoryNet delivery was service-layer, not the MCP loopback bridge, and
  its approval was scripted — the arm tests guidance content + receipt,
  not the end-to-end MCP/UI path.
- Per `evaluation.md`: this supports no stale-code-reduction or
  superiority claim. A2 study (≥10 tasks, preregistered) remains open.

Artifacts: `.local/trial-results/` (oracle JSON ×2, delivery/receipt JSON,
both agent-notes). Raw lab traces are not part of the public distribution.
