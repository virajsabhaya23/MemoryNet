# Documentation

MemoryNet is a local prototype for public or synthetic evidence. Start with the [repository README](../README.md) and [security boundaries](../SECURITY.md).

| Guide | Purpose |
| --- | --- |
| [Usage](usage.md) | Capture evidence, propose and review a decision, search, and revalidate linked work. |
| [Public repositories](public-evidence-workspace.md) | Import public merged-PR evidence and create scoped decisions. |
| [Affected work](affected-work.md) | Pin decision versions, detect stale context, and reconcile artifact hashes. |
| [Agent context and MCP](agent-context.md) | Configure the local read-only bridge and understand its contracts. |
| [Decision Guard](decision-guard.md) | Configure optional model extraction and review proposed guidance. |
| [Local operations](local-operations.md) | Select configuration, back up, restore, reset, and export source. |
| [Architecture](architecture.md) | Understand storage, access rules, runtime boundaries, and code layout. |
| [Website](github-pages.md) | Check, preview, build, and publish the static website. |

Machine-readable contracts: [query schema](contracts/agent-query-v1.schema.json) and [response schema](contracts/agent-context-v1.schema.json). Regenerate them with `npm run contract:export` when their source definitions change.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development checks and documentation policy.
