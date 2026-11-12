# Documentation

MemoryNet is a local prototype for public or synthetic evidence. Start with the [repository README](../README.md) and [security boundaries](../SECURITY.md).

| Guide | Purpose |
| --- | --- |
| [Demo and evaluation](evaluation.md) | Run the three-minute walkthrough and inspect the limits of current evidence. |
| [Usage](usage.md) | Capture evidence, propose and review a decision, search, and revalidate linked work. |
| [Public repositories](public-evidence-workspace.md) | Import public merged-PR evidence and create scoped decisions. |
| [Affected work](affected-work.md) | Pin decision versions, detect stale context, and reconcile artifact hashes. |
| [Agent integration](agent-integration.md) | Set up coding clients, task context, agent proposals, reports, and bindings. |
| [Context contract v1](agent-context.md) | Understand the backward-compatible query and loopback bridge. |
| [Trust model](trust.md) | Review policies, access rules, and audit integrity. |
| [Runtime modes](prototype.md) | Local workspace, sandbox, access-key configuration, and GitHub sign-in. |
| [Deployment boundaries](production-readiness.md) | Requirements for shared or private-data use. |
| [Decision Guard](decision-guard.md) | Configure optional model extraction and review proposed guidance. |
| [Local operations](local-operations.md) | Select configuration, back up, restore, reset, and export source. |
| [Architecture](architecture.md) | Understand storage, access rules, runtime boundaries, and code layout. |
| [Website](github-pages.md) | Check, preview, build, and publish the static website. |
| [Validation assignments](validation/audit-assignments.md) | Split product/security/usability audit into executable assignments with exit criteria. |
| [Experiment A smoke](validation/experiment-a-smoke.md) | Prepared AGENTS.md-vs-MemoryNet comparison: arms, metrics, and runbook. |

Machine-readable contracts: [v1 query](contracts/agent-query-v1.schema.json), [v1 response](contracts/agent-context-v1.schema.json), [task query](contracts/agent-task-query-v2.schema.json), [task response](contracts/agent-task-context-v3.schema.json), [receipt query](contracts/receipt-query-v1.schema.json), [receipt check](contracts/receipt-check-v2.schema.json), [proposal](contracts/agent-proposal-v1.schema.json), [proposal receipt](contracts/agent-proposal-receipt-v1.schema.json), [report](contracts/agent-report-v1.schema.json), and [report receipt](contracts/agent-report-receipt-v1.schema.json). Superseded versions (task response v2, receipt check v1) stay in the same folder as history. Regenerate them with `npm run contract:export` when their source definitions change.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development checks and documentation policy.
