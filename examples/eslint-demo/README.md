# Reproducible ESLint migration example

Use the [main setup guide](../../README.md) for an ordinary trial or the [public repository guide](../../docs/public-evidence-workspace.md) to import PR evidence. This isolated example uses a separate port and database; it is not an automatic repository connector.

This is a controlled consumer pinned to ESLint 10.0.0 with obsolete v9 configuration. Two genuine, revision-pinned upstream PR documents provide evidence for changing the guidance. It is an authored evaluation fixture, not an upstream ESLint project or a naturally occurring customer incident.

From the MemoryNet repository root, with Node.js 24 or newer:

```sh
npm ci --ignore-scripts
npm --prefix examples/eslint-demo/scenario/start ci --ignore-scripts --no-audit --no-fund
node examples/eslint-demo/verify.mjs
node examples/eslint-demo/serve.ts
```

Verification runs the actual pinned ESLint, confirms that the starting configuration fails, checks a scripted passing control, and rejects weakened lint policy and changed application behavior. These are evaluator controls, not new coding-agent results. They make no model requests. The frozen consumer's `lint` script is POSIX (`ESLINT_USE_FLAT_CONFIG=false eslint src`); on Windows the harness runs the same pinned ESLint with the same environment directly, because `cmd.exe` cannot parse a `NAME=value` prefix, and the control still fails only if ESLint 10 itself rejects the retained `.eslintrc.cjs`.

The app opens at [http://127.0.0.1:3062](http://127.0.0.1:3062). It creates its own database, binding, dispatch ledger, and evidence under ignored `.local/eslint-demo/`; it never uses the ordinary application database. Distribute the example source without generated local data.

## Review and extraction

Startup imports the two public evidence excerpts and creates a **pending** historical proposal. Select the owner in the local identity picker and inspect the exact proposal revision before approving it. Local review records an operator action; it is not authenticated organizational identity or upstream policy approval. For a recorded demonstration, the person doing the review should perform the review clicks themselves.

Model extraction is optional and requires an explicit action. To use an existing private environment file:

```sh
node --env-file=/absolute/path/to/private.env examples/eslint-demo/serve.ts
```

The file must define `MODEL_API_KEY`; do not copy it into the example. The demo permits one dispatch across restarts, including failed requests, with at most 4,096 output tokens. Its conservative estimate uses the retained October 31, 2026 rate assumptions and refuses estimates above $0.10. It does not verify account credit or actual charges. Recheck provider pricing before a paid run. Startup neither calls the model nor approves proposals. Do not delete the dispatch ledger to silently retry a call.

For MCP, `.local/eslint-demo/connection.json` describes the app URL and private binding path. Follow the [binding instructions](../../docs/agent-context.md#mcp-and-authenticated-loopback-bridge). A binding expires after 24 hours; stop the app and explicitly rotate it using the binding command if needed. Do not publish generated bindings or workflow snapshots.

## Coding comparison

Give each fresh coding agent its own copy of `scenario/start/`, the same [task](scenario/TASK.md), the same [source evidence](sources/README.md), and the same model, budget, and tool access. Install the pinned dependencies in each copy. Keep the oracle and scripted controls outside the coding agent's context. Include the [maintained-instructions control](controls/README.md) in any effectiveness comparison; its ready-to-copy `AGENTS.md` content states the same current policy as reviewed MemoryNet context.

Check each resulting consumer independently:

```sh
node examples/eslint-demo/scenario/oracle.mjs /absolute/path/to/changed-consumer
```

The oracle runs lint and the protected application test, checks the exact ESLint pin, preserves source/test/lockfile bytes, and probes undefined variables, unused variables, strict equality, and obsolete environment-switch behavior. See [scenario details](scenario/README.md).

This example verifies pinned source consistency and evaluator behavior. It does not establish coding-agent effectiveness or customer benefit.
