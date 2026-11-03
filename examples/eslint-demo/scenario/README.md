# Controlled consumer task

Scenario instructions belong to the [portable example](../README.md); the task text, starter hashes and oracle are evaluator inputs. Changing them creates a new fixture, not a replay of retained results.

The frozen starting consumer pins ESLint exactly to `10.0.0` but retains `.eslintrc.cjs` and `ESLINT_USE_FLAT_CONFIG=false`. With the pinned dependencies installed, lint fails because ESLint v10 requires flat configuration, while the application test passes. `START-SHA256.json` records this distributed fixture's bytes.

Copy `start/` without `node_modules` into a separate directory for every arm. Give each agent `TASK.md` and equivalent public evidence. Install each copy with `npm ci --ignore-scripts --no-audit --no-fund`. Keep the oracle, controls, expected solutions, and other arms' outputs out of agent context. Record the model, budget, tools, actual context, commands, diff, and independent oracle outcome for every arm. Report successful baselines and failed MemoryNet runs.

```sh
node examples/eslint-demo/scenario/oracle.mjs /absolute/path/to/agent-consumer
```

The oracle uses actual ESLint 10.0.0, runs lint and the protected application test, and checks positive code, undefined variables, unused variables, loose equality, and v10 behavior with the old environment switch. It refuses changed application source/test/lockfile bytes and downgraded ESLint. `../verify.mjs` checks the intentionally failing start, a scripted passing control, weakened policy, and changed application behavior. Controls are not agent results.

The source, application test, and legacy configuration were authored for MemoryNet. Upstream evidence is attributed in [sources](../sources/README.md), with its MIT license retained. No upstream repository was modified, and no historical internal policy approval is implied.
