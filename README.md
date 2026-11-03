# MemoryNet

MemoryNet keeps engineering decisions, constraints, lessons, and their source evidence in a reviewed, versioned store. People search it in a local web app; coding agents retrieve approved context through read-only MCP. When a decision changes, linked tasks can be revalidated against the versions they used.

**Current status: local prototype for public or synthetic evidence.** Private work repositories and shared production deployment are unsupported. See [security boundaries](SECURITY.md).

## What it does today

1. Import public merged-PR evidence or record it manually. Optional model extraction suggests candidates.
2. Propose guidance with citations and, for agent context, an exact repository, branch, and validity interval.
3. Have a different authorized human approve the exact proposal revision. Upstream PR merges and imported candidates are not local approval.
4. Search approved records or deliver bounded, permission-filtered context through MCP `get_context`, with version IDs, citations, and retrieval receipts.
5. Pin active tasks and spec/file hashes to approved decision versions. Revalidate after a change; stale baselines cannot be exported until explicitly refreshed.

The app also has organization/project roles, decision history, a network view, agent/skill definitions, JSON knowledge export, and offline database backup/restore. It does not run agents, monitor GitHub continuously, automatically patch specs, send task notifications, or establish that code follows a decision. Git reconciliation checks declared file bytes only.

## Start with an isolated example

Use Node.js 24 or newer, npm, and Git. A model account, API key, and database server are unnecessary for the basic workflow. From a MemoryNet source checkout:

```sh
npm ci --ignore-scripts
npm run check
MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/first-trial npm run app
```

Open [http://127.0.0.1:3050](http://127.0.0.1:3050), choose **System → Load synthetic example data**, then select a person. Follow the [usage guide](docs/usage.md) to capture evidence, propose, review, and retrieve a memory. Switching fixture personas demonstrates roles; it is not verified identity or independent human review.

Stop with Ctrl+C. The app creates the embedded PostgreSQL database and applies migrations automatically. One MemoryNet process can open a database at a time. Use a separate directory per trial; do not reset a database you want to keep. Port 3050 must be free.

**Why the explicit mode?** A fresh checkout uses a development identity picker and System fixtures. If a local `.local/prototype/config.json` exists, the app selects its access-key mode and database instead. `MEMORYNET_PROTOTYPE_CONFIG=off` makes these trial commands reproducible. See [configuration](docs/local-operations.md#configuration).

## Try your personal repository

Use an active **public GitHub repository**, preferably with a few merged PRs containing a meaningful decision. MemoryNet runs beside your repo; importing evidence does not install files in it, change its code, or post to GitHub.

Install and authenticate the GitHub CLI (`gh auth login`), then replace `YOUR_GITHUB_LOGIN` and `YOUR_REPO_NAME` below. Run these from the MemoryNet checkout with the app stopped:

```sh
npm run data:download:evidence -- --owner YOUR_GITHUB_LOGIN --repos YOUR_REPO_NAME --prs 20 --out .data/public/my-repo-evidence.json
MEMORYNET_DATA_DIR=.data/personal-trial npm run data:import:evidence -- .data/public/my-repo-evidence.json
MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/personal-trial npm run app
```

The importer prints organization, principal, and project IDs. Find the numeric repository ID in the proposal applicability selector. Select the local workspace owner/reviewer in the picker, inspect imported sources, and review what they actually establish. These are local test roles, not verified GitHub membership. No candidates are automatically approved; some PRs produce no candidate. This snapshot contains PR metadata and excerpts, not a full source checkout.

**To use an imported source with an agent:** create a new proposal citing it, set repository ID, exact branch, and validity interval, and have a separate reviewer approve it. Imported heuristic candidates have no applicability; approving one alone will not make it eligible for scoped MCP or Affected work. Then create an agent principal, grant project and repository access, and follow the [MCP binding setup](docs/agent-context.md#mcp-and-authenticated-loopback-bridge). MCP configuration is manual; a verified setup for every coding assistant is not available.

The [public evidence guide](docs/public-evidence-workspace.md) covers IDs, roles, scope, troubleshooting, and the difference between this evidence importer and `data:load`, which creates synthetic approvals for display testing. Refresh evidence into a new database; this importer does not synchronize an existing workspace. For an isolated prepared comparison, use the [ESLint example](examples/eslint-demo/README.md).

## Try it at work

Start with a public company repository or a synthetic example of a real migration problem. Use the same isolated trial, two real reviewers where possible, and compare one task against your team's maintained instructions/ADRs. Local persona switching remains a demonstration of the review rule.

**Private or internal work repositories are not supported for this trial.** The downloader deliberately skips private repositories. A private repository on a personal account has the same limitation. Shared identity/delegation, a GitHub App with live permissions, and record deletion/retention are still missing. A local access key does not fill those gaps. Optional model extraction also sends selected source text to its provider. See [unsupported use](SECURITY.md#unsupported-use).

The smallest useful test is: approve decision v1, pin one active task to it, approve a replacement, and check that Affected work flags the old baseline and refuses stale export. See [the affected-work workflow](docs/affected-work.md).

## Configuration

`npm run app` reads `.env.local` if present. Copy `.env.example` only when configuration is needed; other scripts require exported environment variables and do not load that file automatically.

| Variable | Purpose |
| --- | --- |
| `MEMORYNET_PROTOTYPE_CONFIG` | `off` selects the sandbox; otherwise use an owner-only config path or auto-detected `.local/prototype/config.json`. Its data directory takes precedence. |
| `MEMORYNET_DATA_DIR` | Embedded database directory, default `.data/memorynet`, unless overridden by prototype configuration. |
| `MODEL_API_KEY` | Optional Meta extraction credential; provider calls require an explicit extraction action. |
| `MEMORYNET_META_AGENT_ID` | Existing agent principal UUID used to propose extracted candidates; grants no roles. |
| `MEMORYNET_META_MAX_REQUESTS` | Process attempt limit, integer 1–20, default 5; resets on restart, not a billing cap. |
| `MEMORYNET_AGENT_BINDING_FILE` | Owner-only, expiring MCP credential file used by the app and stdio bridge. |
| `MEMORYNET_APP_URL` | MCP bridge loopback app URL, default `http://127.0.0.1:3050`. |

Keep credentials, generated bindings, local databases, and exports out of commits. The model settings form keeps credentials in server memory until exit. See [Decision Guard](docs/decision-guard.md) for extraction boundaries.

## Commands and documentation

| Goal | Command or guide |
| --- | --- |
| Verify code | `npm run check` (TypeScript and isolated Node tests) |
| Check MCP lifecycle / changed decisions | `npm run eval:smoke` / `npm run eval:work` (synthetic; no provider calls) |
| Back up / restore a stopped app | [Local operations](docs/local-operations.md); `db:backup` and `db:restore` |
| Reconcile declared artifacts with a commit | [Affected work](docs/affected-work.md#check-committed-artifact-bytes-locally); `work:reconcile` |
| Preview / validate the website | `npm run site:serve` / `npm run site:check`; [website guide](docs/github-pages.md) |
| Export reviewed public source | `npm run release:export -- .local/releases/run-001` |
| Connect a coding agent | [Agent context and MCP](docs/agent-context.md) |

Read documents by purpose:

- [Usage](docs/usage.md): capture, review, retrieval, and decision changes.
- [Architecture](docs/architecture.md): storage, access rules, and source layout.
- [Documentation index](docs/README.md): public guides and API schemas.
- [Security](SECURITY.md): trust boundaries and unsupported uses.
- [Changelog](CHANGELOG.md): changes after the initial public commit.

The static website source is `website/`; it explains the product and setup. GitHub Pages does not run the Node/PGlite app. Website source changes here do not publish a live website; see [manual publishing](docs/github-pages.md).

Source layout: `src/` contains domain/storage rules; `src/web/` the app; `src/agent-context/` and `src/mcp/` the context bridge; `src/decision-guard/` extraction/review staging; `src/evaluation/` and `src/benchmark/` experiments; `src/scripts/` CLI commands; `migrations/` ordered schema changes; `test/` isolated tests.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [third-party notices](THIRD_PARTY_NOTICES.md). Copyright 2026 MemoryNet contributors. Licensed under [Apache-2.0](LICENSE).
