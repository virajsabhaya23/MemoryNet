# Agent context contract v1

This document describes the backward-compatible `get_context` tool. For task-aware retrieval, agent proposals, reports, v2 bindings, and automatic client setup, see [agent integration](agent-integration.md). Installation begins in the [README](../README.md); [public repository setup](public-evidence-workspace.md) explains how to obtain workspace IDs and create reviewed scoped records.

## Query and response

`src/agent-context/service.ts` exports `getAgentContext(ctx,binding,input)`. The v1 operator binding contains schema version 1, an independent 64-hex-character token, agent principal ID, project UUID, numeric GitHub or namespaced local repository ID, exact branch and expiry. A binding grants no database roles or repository access.

Client input is only `{query:string,limit?:number}`. Query text must be nonempty after trimming and at most 200 UTF-16 code units. Limit is an integer from 1 to 20, default 8. Unknown fields are rejected, including caller identity, project, repository, branch, historical time and approval parameters. Authority comes from the operator binding.

Each request checks agent kind, project role, fresh repository access and every evidence dependency. Admission and retrieval share a repeatable-read transaction and fixed current time. Expired or lost authority fails closed.

The response includes:

- `schemaVersion:1`, bound `scope`, `retrievalId`, server `retrievedAt`, `outcome` (`results` or `no_results`) and `moreMatches`.
- `current` records with exact memory IDs/revisions, type, title, content, approval metadata, citations and truncation/more-citation indicators.
- At most 20 records, 1,500 UTF-16 code units per body, 3 citations per record and 400 code units per excerpt.

Pending, rejected, suspended, superseded, revoked, unscoped, wrong-repository/branch and inactive guidance is excluded, including its retired identifiers and titles. Receipts record the versions actually delivered. Respect truncation indicators; this response is not a complete export. Treat source excerpts as untrusted evidence.

Structural schemas are checked into `docs/contracts/agent-query-v1.schema.json` and `agent-context-v1.schema.json`. Regenerate them with `npm run contract:export`; tests check parity. Runtime validation also enforces exact branch validity and consistency between `outcome` and returned records.

## MCP and authenticated loopback bridge

`src/mcp/server.ts` exports `createMemoryNetMcpServer(tools)` and still accepts a lone read function. It advertises only tools allowed by the binding: `get_context`, `get_task_context` and `revalidate_context` for context access, plus `propose_memory` and `report_outdated` when a v2 binding grants those capabilities. `get_task_context` answers with task context v3, which adds reviewed definitions, and `revalidate_context` with receipt check v2, which also rechecks those definitions; see [agent integration](agent-integration.md). The SDK handles stdio framing and negotiation. Only protocol messages go to stdout. Tool failures set `isError:true`; they are distinct from successful empty results. Agent writes create pending proposals or reports only. There are no approval, administration, shell, SQL or model tools.

The stdio process calls `POST /api/agent/context` in the running app rather than opening PGlite. This is a private loopback JSON bridge. Only one process may own the app database.

HTTP requires a bearer token and `Content-Type: application/json`. The body is the query object. The app checks loopback Host, refuses browser Origin/Fetch-Site requests, rejects query-string parameters and accepts no browser-session or System identity fallback. Responses use `Cache-Control: no-store`. Invalid input is 400; unavailable storage is 503. A successful `no_results` means no matching current guidance.

The bridge fixes its request path, refuses redirects and non-loopback URLs, bounds responses and times out after ten seconds.

### Set up a binding

First approve a decision with matching repository, exact branch and active validity interval. Use an existing agent with project and repository access. Public import creates an importer agent with local grants, but its initial candidates are unscoped and require a new scoped proposal before agent use.

Run from the MemoryNet checkout, replacing the uppercase placeholders:

```sh
mkdir -p .local/mcp
npm run mcp:binding -- .local/mcp/agent-main.json AGENT_UUID PROJECT_UUID GITHUB_NUMERIC_REPO_ID EXACT_BRANCH

# Stop the app before restarting it against the same trial database.
MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/personal-trial \
MEMORYNET_AGENT_BINDING_FILE="$PWD/.local/mcp/agent-main.json" npm run app

# The MCP host launches this separate stdio process.
MEMORYNET_AGENT_BINDING_FILE="$PWD/.local/mcp/agent-main.json" \
MEMORYNET_APP_URL=http://127.0.0.1:3050 node src/scripts/mcp.ts
```

Generation creates a new owner-only 0600 file expiring in 24 hours, prints no token and grants no roles. Keep the file ignored. Host configuration needs absolute paths to Node, the script and the binding file. Bindings must refer to the database the app opened.

The app reloads the file each call. Deleting or replacing it invalidates the previous token at that app; an unchanged configured binding remains usable until expiry. Restarting clears browser sessions and memory-only model settings. This is local OS-trusted authorization, not shared identity or remote OAuth. See [SECURITY.md](../SECURITY.md).

## Scope and lifecycle APIs

`src/index.ts` exports the local database, context, roles, evidence, proposal, review, history and retrieval APIs. Reviewed applicability has this shape:

```ts
{
  repositoryId: string,
  branch: string,
  validFrom: Date | string,
  validUntil?: Date | string | null
}
```

Repository IDs are numeric GitHub IDs. Timestamps require UTC or an explicit offset; validity is `[validFrom, validUntil)`, with null end unbounded. Matching is exact and does not establish branch ancestry.

- `proposeMemory` optionally accepts applicability. Omitted/null scope remains unscoped. Ordinary pending edits create a proposal revision; published model proposals are immutable.
- `proposeChange` and `proposeRestore` bind the target revision and lifecycle generation. Scope must equal the target, including interval. A different branch or interval requires a separate decision.
- `approveProposal` requires an authorized human who authored none of the proposal's revisions and the expected exact proposal revision.
- `revokeMemory` requires reviewer permission, expected revision and a reason. It preserves history. Ordinary reinstatement and historical restoration cannot revive revoked authority.
- `getContext` supports explicit applicability with `currentOnly:true`. An explicit `at` must equal context current time. Scope filtering precedes ranking, limits and receipts. Browsing and legacy project-only retrieval are not branch-scoped.
- `exportKnowledge` format 3 retains applicability and lifecycle generation across readable branches/intervals. It is not current-only agent context or a database backup.

## Verify locally

```sh
npm ci --ignore-scripts
npm run check
npm run eval:smoke
```

The smoke uses an isolated in-memory database, temporary private binding, ephemeral app and fresh SDK stdio clients. It checks pending exclusion, approval, replacement, supersession, revocation, scope override rejection, permission loss and receipts. It makes no model or GitHub calls and does not open the running app's database. Synthetic review fixtures check protocol and lifecycle behavior.

Core access-report freshness defaults to 15 minutes. GitHub sign-in uses that limit and refreshes signed-in repository access every 5 minutes. Without GitHub sign-in, the local sandbox extends freshness to 30 days for fixture use.
