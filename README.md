# MemoryNet

MemoryNet helps stop AI coding agents from building on decisions your team already reversed.

Capture the evidence, approve an exact version, and give agents the decisions that apply to their repository and branch. When guidance changes, MemoryNet flags tasks pinned to the old decision and blocks stale context exports. Every delivery leaves an audit trail.

## See a decision change in three minutes

```sh
npm ci --ignore-scripts
npm run demo
```

Open `.local/decision-demo/index.html` for the generated walkthrough, or preview the prepared [read-only replay](website/demo.html) with `npm run site:serve`. The command exercises exact-quote validation, review, real MCP retrieval, a decision replacement and stale-export blocking in an isolated database. No account, API key, persona switching or existing workspace is needed. Extraction responses and approvals are explicitly labeled synthetic fixtures; this is a workflow demonstration, not a live Meta run or an effectiveness benchmark. For a timed presentation, see the [3-minute demo script](DEMO.md).

**AI Decision Extraction** (Decision Guard) checks quotes and stages suggestions for review. **Stale-Work Radar** (Affected work) finds tasks pinned to outdated guidance. The **Agent Audit Trail** records the versions and citations each retrieval delivered. [Evaluation evidence](docs/evaluation.md) explains what has and has not been measured.

## Try a folder of local Git projects

Run `npm run demo:workspace` for an end-to-end test with disposable repositories, no account and no model calls. The JSON output shows the original receipt, the observed revision after a change and the citation from a separate upstream repository. The demo starts and stops real loopback servers and deletes its fixture data.

To try your own public or synthetic checkouts, preview the folder with `npm run workspace -- preview --root /path/to/projects`. Then select a project and a single committed document. [Local workspace instructions](docs/usage.md#select-a-local-git-workspace) · [Release validation](RELEASE_VALIDATION.md)

## Quick start: your repository and your coding agent

Use Node.js 24 or newer, npm and Git. The GitHub CLI (`gh auth login`) lets setup look up the repository; without it, add `--repo-id <numeric id> --branch main`. Everything runs on this computer. From a MemoryNet source checkout:

```sh
npm ci --ignore-scripts
npm run setup -- --repo OWNER/REPO --reviewer "A teammate" --client vscode --project-dir ../REPO
npm start
```

- `setup` creates a separate local workspace (`.data/workspace`): an organization and project for the repository, you as owner, the reviewer you named, and a coding agent that may read approved guidance, propose and report, but never approve. It writes an owner-only, expiring agent binding under `.local/memorynet/` and, with `--client vscode|claude|cursor|codex`, adds a `memorynet` entry to that client's project MCP file. The entry holds paths only, never the credential.
- `npm start` serves [http://127.0.0.1:3050](http://127.0.0.1:3050), opens as your configured local operator, and first renews the agent binding and local access declarations. Existing access-key or GitHub sign-in configurations retain their login gate. Set `MEMORYNET_AUTH_MODE` to choose explicitly; see [runtime modes](docs/prototype.md).
- In your coding agent, ask it to call `get_task_context` with the task and the files it will touch. When it settles a durable decision, it can `propose_memory` with pull request evidence; a different person approves the exact version on the **Review** page, and the next task receives it with its reasons and citations.
- `npm run doctor -- --project-dir ../REPO` checks the path from workspace to agent without recording anything. `npm run connect -- --client claude --project-dir ../REPO` adds another client; [agent integration](docs/agent-integration.md) lists every tool and client format.

Identities in this workspace are local and unverified, and repository access is your declaration, not a GitHub permission check. A private repository needs `--allow-private`, which accepts that it is outside the supported trial boundary below.

## What it does today

1. Import public merged-PR evidence, record it manually, or let a coding agent propose a decision with pull request evidence through MCP. Optional model extraction suggests candidates.
2. Propose guidance with citations and, for agent context, an exact repository, branch and validity interval. A proposal may also name the paths it governs (`src/api/**`) and link to decisions it depends on, refines or conflicts with.
3. Have different authorized humans approve the exact proposal revision: one by default, up to three per project policy. Upstream PR merges, imported candidates and agents are never approval.
4. Search approved records, or deliver bounded, permission-filtered context through MCP: `get_context` (keyword search) or `get_task_context`, which starts from the task and the files being changed, follows reviewed links to dependencies and conflicts, and adds the reviewed rules, instructions and matching skills that apply to the project, all within a token budget. A definition whose based-on decision changed arrives flagged `reviewNeeded`. Every delivery, including each definition version, records a retrieval receipt.
5. Pin active tasks and spec/file hashes to approved decision versions. Revalidate after a change; stale baselines cannot be exported until explicitly refreshed.
6. Chain every audit event and retrieval receipt into a per-organization SHA-256 ledger; `npm run ledger:verify` detects edited, removed or inserted history, and checkpoints stored elsewhere detect a rewritten chain.
7. Recommend changes without a model: definitions based on decisions that changed, decisions with repeated outdated reports, decisions agents keep proposing that reviewers reject, and current decisions linked as conflicting. Each recommendation links to existing pages and propose forms; a different person still approves. See [Brain recommendations](docs/usage.md#brain-recommendations).

The app also has organization/project roles, decision history, a network view, agent/skill definitions (delivered to agents in task context, flagged when the decisions they rely on change), JSON knowledge export, and offline database backup/restore. It does not run agents, monitor GitHub continuously, automatically patch specs, send task notifications, or establish that code follows a decision. Git reconciliation checks declared file bytes only.

## Start with an isolated example

Use Node.js 24 or newer, npm, and Git. A model account, API key, and database server are unnecessary for the basic workflow. From a MemoryNet source checkout:

```sh
npm ci --ignore-scripts
npm run check
MEMORYNET_AUTH_MODE=sandbox MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/first-trial npm run app
```

Open [http://127.0.0.1:3050](http://127.0.0.1:3050), choose **System → Load synthetic example data**, then select a person. Follow the [usage guide](docs/usage.md) to capture evidence, propose, review, and retrieve a memory. Switching fixture personas demonstrates roles; it is not verified identity or independent human review.

Stop with Ctrl+C. The app creates the embedded PostgreSQL database and applies migrations automatically. One MemoryNet process can open a database at a time. Use a separate directory per trial; do not reset a database you want to keep. Port 3050 must be free.

**Why the explicit mode?** `MEMORYNET_AUTH_MODE=sandbox` selects test personas; `MEMORYNET_PROTOTYPE_CONFIG=off` disables any prepared configuration that would override the trial database. A configured setup workspace otherwise opens as its local operator. Existing key and GitHub configurations preserve their login gate. See [runtime modes](docs/prototype.md).

## Try your personal repository

Use an active **public GitHub repository**, preferably with a few merged PRs containing a meaningful decision. MemoryNet runs beside your repo; importing evidence does not install files in it, change its code, or post to GitHub.

Install and authenticate the GitHub CLI (`gh auth login`), then replace `YOUR_GITHUB_LOGIN` and `YOUR_REPO_NAME` below. Run these from the MemoryNet checkout with the app stopped:

```sh
npm run data:download:evidence -- --owner YOUR_GITHUB_LOGIN --repos YOUR_REPO_NAME --prs 20 --out .data/public/my-repo-evidence.json
MEMORYNET_DATA_DIR=.data/personal-trial npm run data:import:evidence -- .data/public/my-repo-evidence.json
MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/personal-trial npm run app
```

The importer prints the organization, principal, project, and repository IDs. Select the local workspace owner/reviewer in the picker, inspect imported sources, and review what they actually establish. These are local test roles, not verified GitHub membership. No candidates are automatically approved; some PRs produce no candidate. This snapshot contains PR metadata and excerpts, not a full source checkout.

**To use an imported source with an agent:** create a new proposal citing it, set repository ID, exact branch, and validity interval, and have a separate reviewer approve it. Imported heuristic candidates have no applicability; approving one alone will not make it eligible for scoped MCP or Affected work. Then create an agent principal, grant project and repository access, and follow the [MCP binding setup](docs/agent-context.md#mcp-and-authenticated-loopback-bridge), or use the [quick start](#quick-start-your-repository-and-your-coding-agent), which does all of this for one repository. `npm run connect` writes each client's documented project format; launches were verified with the official MCP SDK client, not inside every coding application.

The [public evidence guide](docs/public-evidence-workspace.md) covers IDs, roles, scope, troubleshooting, and the difference between this evidence importer and `data:load`, which creates synthetic approvals for display testing. Refresh evidence into a new database; this importer does not synchronize an existing workspace. For an isolated prepared comparison, use the [ESLint example](examples/eslint-demo/README.md).

## Supported use and work trials

This build supports local trials with public or synthetic evidence. Shared production deployment and private work repositories remain unsupported; see the [trust model](docs/trust.md) and [security boundaries](SECURITY.md).

Start with a public company repository or a synthetic example of a real migration problem. Use the same isolated trial, two real reviewers where possible, and compare one task against your team's maintained instructions/ADRs. Local persona switching remains a demonstration of the review rule.

**Private or internal work repositories are not supported for this trial.** The downloader deliberately skips private repositories. A private repository on a personal account has the same limitation. Hosted identity/delegation, signed GitHub ingestion, and record deletion/retention are still missing. Optional GitHub sign-in checks repository access for signed-in people but does not provide shared hosting or organization membership synchronization. A local access key does not fill those gaps. Optional model extraction also sends selected source text to its provider. See [production prerequisites and acceptance checks](docs/production-readiness.md).

The smallest useful test is: approve decision v1, pin one active task to it, approve a replacement, and check that Affected work flags the old baseline and refuses stale export. See [the affected-work workflow](docs/affected-work.md).

## Configuration

`npm run app` and `npm start` read `.env.local` if present. Copy `.env.example` only when configuration is needed; other scripts require exported environment variables and do not load that file automatically. `npm start` also reads the workspace profile that `npm run setup` writes to `.local/memorynet/workspace.json` (paths and IDs only); explicit environment variables still take precedence, and `npm start` disables prepared prototype selection (`MEMORYNET_PROTOTYPE_CONFIG=off`) unless you set it; a matching setup profile supplies the local operator.

| Variable | Purpose |
| --- | --- |
| `MEMORYNET_AUTH_MODE` | `local`, `sandbox`, `access-key`, or `github`. Defaults preserve existing GitHub/key gates; otherwise a matching operator profile opens locally, or a fresh checkout uses the sandbox. |
| `MEMORYNET_PROTOTYPE_CONFIG` | `off` disables prepared configuration; otherwise use an owner-only config path or auto-detected `.local/prototype/config.json`. Its data directory takes precedence. |
| `MEMORYNET_DATA_DIR` | Embedded database directory, default `.data/memorynet`, unless overridden by prototype configuration. |
| `MODEL_API_KEY` | Optional Meta extraction credential; provider calls require an explicit extraction action. |
| `MEMORYNET_META_AGENT_ID` | Existing agent principal UUID used to propose extracted candidates; grants no roles. |
| `MEMORYNET_META_MAX_REQUESTS` | Process attempt limit, integer 1–20, default 5; resets on restart, not a billing cap. |
| `MEMORYNET_AGENT_BINDING_FILE` | Owner-only, expiring MCP credential file used by the app and stdio bridge. Version 2 bindings name their capabilities (`context`, `propose`, `report`) and the person accountable for agent proposals. |
| `MEMORYNET_APP_URL` | MCP bridge loopback app URL, default `http://127.0.0.1:3050`. |
| `MEMORYNET_GITHUB_CLIENT_ID` | Defaults to **Sign in with GitHub** (device flow); explicit `MEMORYNET_AUTH_MODE=local` enables optional account connection instead. The client ID of a GitHub App, or of an OAuth App with device flow enabled. Persona selection, the prototype access key and System controls are turned off; see [GitHub sign-in](docs/prototype.md#github-sign-in). |
| `MEMORYNET_GITHUB_SCOPE` | OAuth App scopes requested at sign-in, for example `repo` to check private repositories. Leave empty for a GitHub App. |
| `MEMORYNET_UPGRADE_BACKUP` | `off` skips the automatic verified backup taken before pending database upgrades. |

Keep credentials, generated bindings, local databases, and exports out of commits. The model settings form keeps credentials in server memory until exit. See [Decision Guard](docs/decision-guard.md) for extraction boundaries.

## Commands and documentation

| Goal | Command or guide |
| --- | --- |
| Set up, run and check a workspace | `npm run setup`, `npm start`, `npm run connect`, `npm run doctor`; [quick start](#quick-start-your-repository-and-your-coding-agent) |
| Sign in with GitHub instead of the local picker | `npm run github:link -- --login YOU`, then set `MEMORYNET_GITHUB_CLIENT_ID`; [GitHub sign-in](docs/prototype.md#github-sign-in) |
| Run the decision-change walkthrough | `npm run demo`; [evidence and limits](docs/evaluation.md) |
| Verify code | `npm run check` (TypeScript and isolated Node tests) |
| Verify audit and receipt history (app stopped) | `npm run ledger:verify` / `npm run ledger:checkpoint`; [trust model](docs/trust.md#verify-the-history-yourself) |
| Check MCP lifecycle / changed decisions | `npm run eval:smoke` / `npm run eval:work` (synthetic; no provider calls) |
| Compare what retrieval paths hand an agent | `npm run eval:brain` (synthetic, no model calls; not an effectiveness measure); [brain benchmark](docs/evaluation.md#brain-benchmark-what-each-retrieval-path-delivers) |
| Back up / restore a stopped app | [Local operations](docs/local-operations.md); `db:backup` and `db:restore` |
| Reconcile declared artifacts with a commit | [Affected work](docs/affected-work.md#check-committed-artifact-bytes-locally); `work:reconcile` |
| Preview / validate the website | `npm run site:serve` / `npm run site:check`; [website guide](docs/github-pages.md) |
| Export reviewed public source | `npm run release:export -- .local/releases/run-001` |

Read documents by purpose:

- [Usage](docs/usage.md): capture, review, retrieval, and decision changes.
- [Architecture](docs/architecture.md): storage, access rules, runtime boundaries, and source layout.
- [Trust model](docs/trust.md): review policies, audit verification, and data handling.
- [Agent integration](docs/agent-integration.md): MCP tools, bindings, and coding-client configuration.
- [Documentation index](docs/README.md): public guides and API schemas.
- [Production readiness](docs/production-readiness.md): limits on private or shared use.
- [Changelog](CHANGELOG.md): public implementation changes.

The static website source is `website/`; it explains the product and setup. GitHub Pages does not run the Node/PGlite app. Website source changes here do not publish a live website; see [manual publishing](docs/github-pages.md).

Source layout: `src/` contains domain/storage rules; `src/web/` the app; `src/agent-context/` and `src/mcp/` the context bridge; `src/decision-guard/` extraction/review staging; `src/evaluation/` and `src/benchmark/` experiments; `src/scripts/` CLI commands; `migrations/` ordered schema changes; `test/` isolated tests.

See [CONTRIBUTING.md](CONTRIBUTING.md) (pull requests require the [contributor license agreement](CLA.md)), [SECURITY.md](SECURITY.md), and [third-party notices](THIRD_PARTY_NOTICES.md). Copyright 2026 Viraj Sabhaya and the MemoryNet contributors. Licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE).
