# Maintained-instructions control

This is one control inside the [portable example](../README.md). Freeze the input policy, model, budget, and expected checks before running a comparison; the example does not execute a study.

`MAINTAINED-AGENTS.md` is ready-to-copy context for the maintained-instructions arm. Its tracked filename avoids the repository's ignore rule for private operator `AGENTS.md` files. It contains current v10 policy and the same two source citations used by the example's review workflow. It is authored control material, not an agent result.

Prepare an isolated copy of `scenario/start/` under `.local/` for each arm, excluding `node_modules`. For the maintained-instructions arm:

```sh
cp examples/eslint-demo/controls/MAINTAINED-AGENTS.md /absolute/path/to/instructions-consumer/AGENTS.md
```

Give every arm the same `scenario/TASK.md`, pinned consumer, source evidence, model, budget, and tools. The MemoryNet arm must receive the same current policy after explicit review; do not compare current maintained instructions against stale or pending MemoryNet context. Keep the oracle and scripted controls outside all agent contexts. Record the instructions file hash and exact delivered MemoryNet revisions before each run.

If testing a decision change while tasks are active, update maintained instructions and reviewed MemoryNet guidance from the same change evidence at the preregistered point. Measure the operator's maintenance time for both paths and count implementations against the same current policy. Do not hide updates from the control, count a synthetic control as a customer incident, or claim results before executing the comparison.
