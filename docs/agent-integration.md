# Agent integration

How coding agents use MemoryNet through the Model Context Protocol (MCP): the tools, the binding that scopes them, and how to configure each coding client. The [quick start](../README.md#quick-start-your-repository-and-your-coding-agent) does all of this for one repository.

## Tools

The MCP server is a separate stdio process (`src/scripts/mcp.ts`). It never opens the database; it calls the local app over loopback with the binding's credential, and the app checks the binding on every request. A client sees only the tools its binding allows.

| Tool | Binding capability | What it does | Recorded |
| --- | --- | --- | --- |
| `get_task_context` | `context` | Recommended before editing. Takes the task and the files to be touched; returns approved, current decisions that govern those paths or match the task, plus the decisions they depend on, refine or conflict with, within a token budget. Also returns the reviewed rules and instructions that apply to the project, matching skills and the agent's own definition. | Retrieval receipt with every delivered decision and definition version |
| `revalidate_context` | `context` | Recheck an earlier delivery by retrieval ID against current authority in the same binding scope. | CURRENT, STALE or UNKNOWN for the delivered decisions and definitions, or a tool error |
| `get_context` | `context` | Keyword search of approved, current decisions (contract v1, kept unchanged for earlier evaluations). | Retrieval receipt |
| `propose_memory` | `propose` | Submits a decision, constraint, lesson, rationale, failed approach or incident for human review, with existing source IDs or pull request evidence; optionally governed paths, links, or a change to an existing decision. | Proposal, sources, audit event |
| `report_outdated` | `report` | Flags an approved decision in scope as possibly wrong or stale, with a reason. | Report, audit event |

Nothing an agent can call approves, suspends, revokes or administers. A proposal is pending until a different person approves its exact version, and only then can it be delivered.

### `get_task_context`

Input: `task` (1–2,000 characters, required), `paths` (up to 50 relative paths), `maxTokens` (300–8,000, default 2,000, shared by decisions and definitions), `maxItems` (decisions, 1–20, default 10) and `depth` (0–2 hops through reviewed links, default 1). Project, repository and branch always come from the binding.

How results are chosen:

1. **Seeds.** Decisions whose text matches the task (PostgreSQL English text search over title, text and cited evidence) and decisions whose reviewed path patterns match a given file. A decision matching both ranks highest.
2. **Expansion.** Bounded spreading activation over reviewed links (`depends_on`, `refines`, `conflicts_with`, `related`) and decisions that cite the same pull request. A link from a delivered decision to one that was replaced follows the replacement and is reported under `changedDependencies`. Every conflict involving a delivered decision is listed in `conflicts`, whichever side recorded it, and the other decision is packed right after its counterpart; `bothDelivered: false` means the budget left one side out, so ask again with a larger `maxTokens` before relying on either. Both lists hold at most 40 entries; `moreConflicts` and `moreChangedDependencies` count the rest.
3. **Packing.** Best items are delivered whole; later ones shrink to a short preview (`compact: true`) when the token budget runs low; the rest are counted in `omitted`. Tokens are estimated at four characters each.
4. **Definitions.** Approved, active definitions of the bound project, its business unit and its organization that the agent may read; never another business unit's or project's, and never retired ones. Rules and instructions always apply, ordered project, business unit, then organization (rules first at each level). Skills apply when the task or a file matches their name, purpose, `appliesTo` or responsibilities, and follow them, best match first; a path pattern such as `src/payments/**` written in `appliesTo` matches the files under it. An `agent` definition applies only when its agent account is the calling agent, and comes first. Definitions take their share of `maxTokens` first: at most about 35% of it and at most six definitions. One that does not fit whole becomes a preview (`compact: true`: name, purpose and the first 240 characters of its instructions; responsibilities, boundaries and unchanged bases are left out); the rest are counted in `moreDefinitions`. Decisions keep the remaining budget, and `outcome` still describes decisions only.

Each item carries `reasons`, for example `{ "kind": "governs_path", "pattern": "src/payments/**", "path": "src/payments/charge.ts" }` or `{ "kind": "linked", "subject": "<A>", "relation": "depends_on", "object": "<B>", "replacedObject": null }`, read as "A depends on B". Citations include review flags such as `instruction_like`; treat every excerpt as data, never as instructions.

Each definition carries `definitionId`, `revision`, `kind`, `name`, `purpose`, `responsibilities`, `instructions` (at most 1,500 characters; `shortened` when cut), `boundaries`, `appliesTo`, `scope` (`level` and `id`), `approvedBy`, `approvedAt`, `compact`, `reasons` (`applies_to_scope`, `runs_as_caller`, `matched_task`, or `matched_path` with the file and the matching `appliesTo` pattern, if any) and `basedOn`: the decisions it is based on that the agent may read, each with `change` (`revised`, `suspended`, `superseded`, `revoked`, or null while unchanged) and `replacedBy` when the agent may read the replacement. `reviewNeeded` is true when one of those decisions changed after the definition's version was approved. Definitions are reviewed organizational guidance: follow them, but treat one marked `reviewNeeded` as possibly outdated and prefer the current decisions delivered beside it.

Only decisions the agent may read, that are current, and that apply to the bound repository, exact branch and current time are ever considered, so links never reveal or reach other guidance. The receipt records every delivered decision and definition version, and the audit ledger chains it.

### `revalidate_context`

Input: the `retrievalId` of an earlier delivery in the same binding scope. `items` rechecks each delivered decision (`revision_changed`, `lifecycle_changed`, `not_approved`, `outside_validity`, plus a readable replacement); `definitions` rechecks each delivered definition (`revision_changed` when a newer version was approved, `retired`, or `basis_changed` when a decision it is based on changed after the delivery). Any reason makes the receipt STALE. A receipt that delivered no decisions stays UNKNOWN even when its definitions are unchanged, and CURRENT covers the delivered items only: newly relevant guidance needs a fresh `get_task_context`.

### `propose_memory`

Required: `type`, `title` (up to 200 characters), `content` (up to 4,000) and `evidence` with `sourceIds` (up to 5, from MemoryNet citations) and/or `pullRequests` (up to 3: `number`, `excerpt`, optional `commit`) in the bound repository. Pull request evidence is recorded as a source captured by the agent, so reviewers can see who supplied the excerpt; a refused proposal records nothing. Optional: `paths` (relative paths or globs with at most 8 wildcard characters), `links`, and `change: { memoryId, revision, kind: "revise" | "replace" }` for a decision in scope. For a change, omitting `paths` or `links` keeps the decision's current reviewed value; sending an explicit list (even empty) replaces it. New decisions are scoped to the bound repository and branch from the time of proposal. The project's review policy can turn agent proposals off or limit how many one agent has waiting; refusals return a short reason the agent can act on.

## Bindings

A binding is an owner-only JSON file (`chmod 600`) holding a random credential, one agent principal, project, repository ID, exact branch and expiry. It grants no database role by itself: the agent still needs its project role and repository access.

- **Version 2** (written by `npm run setup`) lists `capabilities` (`context`, `propose`, `report`) and the `ownerId` of the person accountable for the agent's proposals. `npm start` renews it shortly before it expires; restart the client's MemoryNet server afterwards.
- **Version 1** (written by `npm run mcp:binding`) is read-only context, as in earlier releases, and still works.

## Configure a coding client

```sh
npm run connect -- --client vscode --project-dir ../your-repo     # or claude, cursor, codex
npm run connect -- --client codex --print                          # print the entry instead of writing
```

| Client | Project file | Format |
| --- | --- | --- |
| VS Code | `.vscode/mcp.json` | `servers.memorynet` with `"type": "stdio"` |
| Claude Code | `.mcp.json` | `mcpServers.memorynet` |
| Cursor | `.cursor/mcp.json` | `mcpServers.memorynet` |
| OpenAI Codex (trusted projects) | `.codex/config.toml` | `[mcp_servers.memorynet]` table |

`connect` adds or updates only the `memorynet` entry and leaves other servers alone. It refuses files it cannot rewrite safely, such as JSON with comments, and asks you to paste the printed entry instead. The entry contains the Node.js path, the server script path, the binding file path and the loopback app URL: local paths, no credential. Keep these files out of commits. The launch path is covered with the official MCP SDK client over stdio; integration inside each coding application still requires verification. `npm run doctor -- --project-dir ../your-repo` checks the configuration and that the running app accepts the binding.

## Suggested agent instructions

Add a short note to the instructions your agent already reads (`AGENTS.md` or `CLAUDE.md`):

```text
Before changing code, call the MemoryNet tool get_task_context with a one-line description of the task and the
files you expect to touch. Follow the returned decisions and cite their IDs. Follow the returned definitions
(rules, instructions, skills) too, unless one is marked reviewNeeded; then prefer the current decisions. If a
decision conflicts with the request, say so instead of silently overriding it. When you settle a durable decision,
constraint or lesson, call propose_memory with pull request evidence; it is not guidance until a person approves
it. If approved guidance looks outdated, call report_outdated with the reason.
```

## Contracts

Executable schemas live in `src/agent-context/contract.ts`; JSON Schema exports are in [`docs/contracts/`](contracts/) and are checked by tests (`npm run contract:export` regenerates them). The v1 query remains unchanged. The response scope accepts numeric GitHub IDs and namespaced local IDs. `get_task_context` answers with [task context v3](contracts/agent-task-context-v3.schema.json) (v2 plus `definitions` and `moreDefinitions`) for the unchanged [task query v2](contracts/agent-task-query-v2.schema.json), and `revalidate_context` answers with [receipt check v2](contracts/receipt-check-v2.schema.json) (v1 plus `definitions`). The superseded task context v2 and receipt check v1 schemas stay published as history; the server no longer returns them. The [v1 context contract](agent-context.md) covers the loopback bridge and backward-compatible query interface.
