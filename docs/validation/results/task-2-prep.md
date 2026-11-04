# Task 2 prep — ESLint Experiment A arms

- Date (UTC): 2026-11-03
- Status: **prepared, not executed.** No coding agent has run either arm.

## Arms staged and installed

| Arm | Directory | Guidance present | Deps |
| --- | --- | --- | --- |
| A — maintained instructions | `.local/experiment-a/eslint-maintained-instructions/` | `AGENTS.md` (current v10 policy) | 69 packages, ESLint 10.0.0 pinned |
| B — MemoryNet | `.local/experiment-a/eslint-memorynet/` | none (verified: no `AGENTS.md`) | 69 packages, ESLint 10.0.0 pinned |

Frozen-input hashes (SHA-256):

- Arm A `AGENTS.md`: `55cc3bb1e91051a9cc0d6edd7430cffe0a96b7958c2a55cad4e91731d0d64444`
- Both arms `TASK.md` (identical): `2d72450a36e516c4439ff1a55a31234352000e4638a724734f28b3d0dd26f839`

## Starting state verified (both arms identical)

- `npm run lint` -> exit 2: ESLint 10 cannot find `eslint.config.(js|mjs|cjs)`;
  the starter still has obsolete `.eslintrc.cjs` and
  `ESLINT_USE_FLAT_CONFIG=false` in the lint script.
- `npm test` -> 1/1 pass (application behavior intact before the task).

## MemoryNet demo state

`.local/eslint-demo/` was already bootstrapped in an earlier local session
(setup.json, binding, connection.json, database, evidence). Startup creates
pending proposals only — approval is still a human step in the UI and has
not been recorded here.

Starting the server from this sandbox fails: the sandbox denies loopback
binding, and `examples/eslint-demo/serve.ts` maps any listen error to
"port 3062 may already be in use" (serve.ts:140). That message in-sandbox
does **not** prove the port is taken. Run the server outside the sandbox:

```sh
! node examples/eslint-demo/serve.ts
```

Then approve the pending historical/current proposal flow in the browser at
http://127.0.0.1:3062 as the owner persona, and record the approved memory
ID + revision in the recording sheet before running Arm B.
