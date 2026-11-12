# Architecture

MemoryNet is a local TypeScript application on Node.js 24 or newer. It runs directly from source, stores records in embedded PostgreSQL through PGlite, and serves HTML from a loopback HTTP server. See the [README](../README.md) for installation and [usage](usage.md) for the review workflow.

## Data flow

```text
Public PR snapshot / manual evidence / synthetic event
                         |
                  pending proposal
                         |
               exact-version human review
                         |
              approved versioned memory
                 /       |       \
           web search  affected work  scoped agent context
                                          |
                              authenticated loopback bridge
                                          |
                                  scoped stdio MCP
```

The web app owns the database. The separate MCP process calls the app over loopback; it never opens that database. Network views use the same permission-filtered records as ordinary pages. While a network map is open it asks `/orgs/:id/network/live` for that same payload every 15 seconds; the answer is built with the same checks and is `304 Not Modified` while nothing it may show has changed.

## Source map

| Path                                                          | Responsibility                                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/`                                                 | Ordered PostgreSQL schema migrations                                                                                               |
| `src/organizations.ts`, `members.ts`, `roles.ts`, `access.ts` | Organization hierarchy, membership, roles and scope checks                                                                         |
| `src/repositories.ts`, `capture.ts`, `public-evidence.ts`     | Repository access reports, evidence capture and public snapshot import                                                             |
| `src/knowledge.ts`, `history.ts`                              | Sources, proposals, exact-version review, memory revisions and lifecycle                                                           |
| `src/retrieval.ts`, `export.ts`                               | Search, retrieval receipts and readable knowledge export                                                                           |
| `src/decision-guard/`                                         | Optional model extraction, provenance and pending-proposal publication                                                             |
| `src/agent-context/`, `src/mcp/`, `src/task-context.ts`       | Scoped context, reviewed-link expansion, reviewed definitions in task context, agent proposals/reports, bindings and MCP transport |
| `src/policy.ts`, `src/relations.ts`, `src/ledger.ts`          | Review thresholds, decision links and audit integrity                                                                              |
| `src/setup.ts`, `src/workspace.ts`, `src/client-config.ts`    | Repository onboarding, workspace profiles and coding-client configuration                                                          |
| `src/github.ts`, `src/web/github-sign-in.ts`                  | Optional GitHub device-flow sign-in and repository access refresh                                                                  |
| `src/work.ts`, `work-git.ts`                                  | Immutable task baselines, decision revalidation and Git artifact observations                                                      |
| `src/definitions.ts`, `definition-freshness.ts`, `prompt.ts`  | Reviewed agent/skill/rule definitions, whether the decisions they are based on changed, and prompt assembly                        |
| `src/network.ts`, `src/web/my-network.ts`                     | Permission-filtered network data                                                                                                   |
| `src/repository-checkouts.ts`                                 | Optional pinned Git-object source browser                                                                                          |
| `src/database-*.ts`, `db.ts`                                  | Database ownership, migrations, backup, restore and reset                                                                          |
| `src/web/`                                                    | HTTP handling, in-memory sessions, escaped templates, routes and browser assets                                                    |
| `src/scripts/`                                                | Local CLI entry points                                                                                                             |
| `test/`                                                       | Domain, database, HTTP, browser-helper and protocol tests                                                                          |
| `website/`                                                    | Separate static informational website                                                                                              |

## Access and review

Role inheritance is defined by database views. Read access requires a MemoryNet role and a fresh repository-access report for every evidence dependency. Checks run on list, direct-ID, history, retrieval and export operations. Revoked access is evaluated again on each request; previously downloaded files cannot be recalled.

Sources, proposal revisions and approved memory revisions are separate records. A project may require one to three distinct human approvals; publication commits the exact proposal revision, evidence, governed paths, and reviewed links in one transaction. A reviewer must be an authorized human who authored none of that proposal's revisions. Agents can propose and retrieve but cannot approve. Optimistic revision checks reject conflicting edits; replacements atomically supersede the previous memory. Revocation preserves history and cannot be undone through ordinary reinstatement.

Scoped guidance binds a numeric repository ID, exact branch and validity interval to the reviewed version. Scoped retrieval filters authority before ranking and logging. Legacy unscoped records remain available in project browsing but cannot become scoped guidance through inferred metadata. See the [agent context contract](agent-context.md).

Retrieval receipts identify the exact returned memory versions and, for task context, the exact delivered definition versions. The audit log and retrieval records are append-only and chained into a per-organization SHA-256 ledger. Verification detects changed history; external checkpoints detect a rebuilt chain. Reads of historical receipts still require current access to their underlying records.

## Local runtime

`npm run app` listens on `127.0.0.1:3050`. A fresh checkout uses development personas and synthetic System controls. A matching setup profile opens as its local operator, disabling persona switching and System controls. Existing GitHub and access-key configurations preserve their login gate; `MEMORYNET_AUTH_MODE` selects a mode explicitly. Use `MEMORYNET_AUTH_MODE=sandbox MEMORYNET_PROTOTYPE_CONFIG=off` for sandbox commands; an explicitly selected prototype configuration takes precedence over `MEMORYNET_DATA_DIR`.

Sessions stay in server memory. Sign-in creates a fresh HttpOnly/SameSite cookie; protected forms check request origin and CSRF tokens. Host checks reject non-loopback names, response templates escape inserted values, and the content policy restricts scripts and styles to local assets. Domain functions enforce permissions independently of visible controls.

The database has one process owner, enforced by an adjacent lock directory. Startup takes a verified backup before upgrading an existing database, applies pending migrations, and gathers planning statistics. Offline backup/restore verifies a SHA-256 inventory; reset accepts only a stopped database below `.data/`. See [local operations](local-operations.md).

The app is intended for public or synthetic data on one trusted computer. Development personas are not verified identity; the optional access key is single-operator authentication. Optional GitHub sign-in verifies linked accounts and refreshes access for signed-in people. Signed GitHub ingestion, organization/team synchronization, hosted identity, record-level deletion and hosted operations are unavailable. See [SECURITY.md](../SECURITY.md).

## Other workflows

- [Decision Guard](decision-guard.md) records optional model suggestions as immutable drafts. Publication creates a pending proposal; human review remains required.
- [Affected work](affected-work.md) pins tasks to decision versions, revalidates them and refuses stale exports. Git reconciliation compares declared hashes with committed bytes without executing repository code.
- The network graph is derived from readable records and supports server-rendered list/table views. Imported evidence can be displayed before approval without becoming authoritative.
- Definitions are reviewed local data; MemoryNet never runs them. `get_task_context` delivers the active rules and instructions of the bound project, its business unit and its organization, skills that match the task or files, and the calling agent's own definition, within part of the token budget. Each is flagged `reviewNeeded` when a decision it is based on changed after its approval. Prompt assembly estimates tokens from text length.
- The static website has its own build and preview commands. It does not run the application backend.
