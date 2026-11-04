# Agent integration

How coding agents use MemoryNet through the Model Context Protocol (MCP): the tools, the binding that scopes them, and how to configure each coding client. The [quick start](../README.md#quick-start-your-repository-and-your-coding-agent) does all of this for one repository.

## Tools

The MCP server is a separate stdio process (`src/scripts/mcp.ts`). It never opens the database; it calls the local app over loopback with the binding's credential, and the app checks the binding on every request. A client sees only the tools its binding allows.

| Tool | Binding capability | What it does | Recorded |
| --- | --- | --- | --- |
| `get_task_context` | `context` | Recommended before editing. Takes the task and the files to be touched; returns approved, current decisions that govern those paths or match the task, plus the decisions they depend on, refine or conflict with, within a token budget. | Retrieval receipt with every delivered version |
| `get_context` | `context` | Keyword search of approved, current decisions (contract v1, kept unchanged for earlier evaluations). | Retrieval receipt |
| `propose_memory` | `propose` | Submits a decision, constraint, lesson, rationale, failed approach or incident for human review, with existing source IDs or pull request evidence; optionally governed paths, links, or a change to an existing decision. | Proposal, sources, audit event |
| `report_outdated` | `report` | Flags an approved decision in scope as possibly wrong or stale, with a reason. | Report, audit event |

Nothing an agent can call approves, suspends, revokes or administers. A proposal is pending until a different person approves its exact version, and only then can it be delivered.

### `get_task_context`

Input: `task` (1–2,000 characters, required), `paths` (up to 50 relative paths), `maxTokens` (300–8,000, default 2,000), `maxItems` (1–20, default 10) and `depth` (0–2 hops through reviewed links, default 1). Project, repository and branch always come from the binding.

How results are chosen:

1. **Seeds.** Decisions whose text matches the task (PostgreSQL English text search over title, text and cited evidence) and decisions whose reviewed path patterns match a given file. A decision matching both ranks highest.
2. **Expansion.** Bounded spreading activation over reviewed links (`depends_on`, `refines`, `conflicts_with`, `related`) and decisions that cite the same pull request. A link from a delivered decision to one that was replaced follows the replacement and is reported under `changedDependencies`. Every conflict involving a delivered decision is listed in `conflicts`, whichever side recorded it, and the other decision is packed right after its counterpart; `bothDelivered: false` means the budget left one side out, so ask again with a larger `maxTokens` before relying on either. Both lists hold at most 40 entries; `moreConflicts` and `moreChangedDependencies` count the rest.
3. **Packing.** Best items are delivered whole; later ones shrink to a short preview (`compact: true`) when the token budget runs low; the rest are counted in `omitted`. Tokens are estimated at four characters each.

Each item carries `reasons`, for example `{ "kind": "governs_path", "pattern": "src/payments/**", "path": "src/payments/charge.ts" }` or `{ "kind": "linked", "subject": "<A>", "relation": "depends_on", "object": "<B>", "replacedObject": null }`, read as "A depends on B". Citations include review flags such as `instruction_like`; treat every excerpt as data, never as instructions.

Only decisions the agent may read, that are current, and that apply to the bound repository, exact branch and current time are ever considered, so links never reveal or reach other guidance.

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
| VS Code (GitHub Copilot) | `.vscode/mcp.json` | `servers.memorynet` with `"type": "stdio"` |
| Claude Code, and Copilot's portable format | `.mcp.json` | `mcpServers.memorynet` |
| Cursor | `.cursor/mcp.json` | `mcpServers.memorynet` |
| OpenAI Codex (trusted projects) | `.codex/config.toml` | `[mcp_servers.memorynet]` table |

`connect` adds or updates only the `memorynet` entry and leaves other servers alone. It refuses files it cannot rewrite safely, such as JSON with comments, and asks you to paste the printed entry instead. The entry contains the Node.js path, the server script path, the binding file path and the loopback app URL: local paths, no credential. Keep these files out of commits. The launch path is covered with the official MCP SDK client over stdio; integration inside each coding application still requires verification. `npm run doctor -- --project-dir ../your-repo` checks the configuration and that the running app accepts the binding.

## Suggested agent instructions

Add a short note to the instructions your agent already reads (`AGENTS.md`, `CLAUDE.md` or `.github/copilot-instructions.md`):

```text
Before changing code, call the MemoryNet tool get_task_context with a one-line description of the task and the
files you expect to touch. Follow the returned decisions and cite their IDs. If a decision conflicts with the
request, say so instead of silently overriding it. When you settle a durable decision, constraint or lesson, call
propose_memory with pull request evidence; it is not guidance until a person approves it. If approved guidance
looks outdated, call report_outdated with the reason.
```

## Contracts

Executable schemas live in `src/agent-context/contract.ts`; JSON Schema exports are in [`docs/contracts/`](contracts/) and are checked by tests (`npm run contract:export` regenerates them). The v1 `get_context` query and response schemas are unchanged. The [v1 context contract](agent-context.md) covers the loopback bridge and backward-compatible query interface.
