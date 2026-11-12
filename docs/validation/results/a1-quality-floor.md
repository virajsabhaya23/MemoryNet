# A1 — Quality floor results

- Date (UTC): 2026-11-03T23:37Z
- Commit: `2ef4064058e02e284603e1d7cebcc1b92bd1d13e` (working tree has extensive uncommitted changes; this run tests the working tree, not HEAD)
- Node: v26.3.0
- Environment: Claude Code sandbox — local port binding is denied
  (`listen EPERM: operation not permitted 127.0.0.1`). Loopback-dependent
  checks must be re-run in an unrestricted terminal or CI to count as green.

## Commands and observed results

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | PASS — 19 packages added (from local cache) |
| `npm run typecheck` | PASS — `tsc --noEmit` clean |
| `npm test` (via `npm run check`) | 456 tests: 445 pass, 11 fail — **all 11 failures are sandbox `listen EPERM` on 127.0.0.1**, not assertion failures |
| `npm run eval:work` | PASS — `changedDecisionDetected: true`, `staleExportBlocked: true`, `metaCalls: 0` (synthetic) |
| `node examples/eslint-demo/verify.mjs` | PASS — scripted controls only; frozen lint fails as expected (exit 2), positive control passes 8 checks, weakened/changed controls fail as expected; no agent or model ran |
| `npm run site:check` | PASS — 26 public files, links and anchors resolve |
| `npm run eval:smoke` | FAIL in this sandbox — loopback server cannot bind (`listen EPERM` path); re-run outside the sandbox |

## The 11 failing tests (all `listen EPERM`)

- `test/web-http.test.ts` (6): body-at-limit/transport inputs, oversized
  chunked upload 413, host/body rejection, compression exclusions, shutdown
  waits for handlers, shutdown aborts incomplete uploads
- `test/agent-tools.test.ts`: fresh MCP SDK client through stdio
- `test/scoped-context.test.ts`: fresh official SDK stdio clients
- coding collector (source parity / MCP receipts / oracle)
- static preview serving project-relative pages
- repeatable demo stale-work blocking through real MCP

Each failure was inspected: every one throws
`Error: listen EPERM: operation not permitted 127.0.0.1` from
`Server.setupListenHandle`. No non-EPERM assertion failure was observed.

## Verdict

CONDITIONAL PASS for the sandbox run: typecheck, 445/456 tests, eval:work,
ESLint scripted controls, and site check are green. The A1 exit criterion
(CI green on a clean clone) is **not yet met** — it requires re-running the
11 loopback tests and `eval:smoke` in an unrestricted environment (Task 4's
GitHub CI will provide exactly this evidence once committed).
