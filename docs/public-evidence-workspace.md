# Try a public repository with real PR evidence

This guide imports metadata and merged PR descriptions from a personal **public** GitHub repository or an employer's public repository that you are allowed to evaluate. It does not clone code, install a GitHub App, write to GitHub, or continuously synchronize changes. Private repositories and shared deployment are unsupported; see [security boundaries](../SECURITY.md).

Start with the [README](../README.md) for installation or the [synthetic walkthrough](usage.md) to learn the workflow without GitHub access. The commands below create a separate local workspace.

## Download and import your public repository

Install Node.js 24+, npm, Git, and the GitHub CLI. Run `npm ci --ignore-scripts` from MemoryNet's checkout. Authenticate `gh` through its normal login and check `gh auth status`. The downloader uses that existing account for read-only GitHub API requests; MemoryNet does not receive a GitHub App installation or infer your organization's membership from it.

Stop any MemoryNet app using the target database. Replace `YOUR_OWNER` and `YOUR_REPO` with the public repository's actual owner and name:

```sh
npm run data:download:evidence -- --owner YOUR_OWNER --repos YOUR_REPO --prs 20 --out .data/public/my-repo-evidence.json
MEMORYNET_DATA_DIR=.data/personal-trial npm run data:import:evidence -- .data/public/my-repo-evidence.json
MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/personal-trial npm run app
```

Open [http://127.0.0.1:3050](http://127.0.0.1:3050). Choose **YOUR_OWNER: local workspace owner**. Open the imported organization, its **Public repository collection**, and the repository project. The evidence network can show all imported sources, including ones with no approved memory.

The explicit `MEMORYNET_PROTOTYPE_CONFIG=off` matters in an existing checkout: a private `.local/prototype/config.json`, if present, otherwise selects its own database and operator even when `MEMORYNET_DATA_DIR` is set. A clean source checkout has no such private configuration. This new workspace uses the development identity picker and simulated System controls; keep it on loopback and use only public/synthetic data.

The importer prints organization, owner, reviewer, importer-agent and project UUIDs. Keep that summary locally for MCP setup. It creates locally named accounts and roles, records repository access as a local report, imports PR excerpts as **manual evidence**, and creates heuristic **pending** candidates. These accounts are not the upstream maintainers. Nothing is approved automatically. The report's `approvedMemories` starts at zero; candidate counts depend on PR labels/titles and may also be zero.

The downloader accepts up to 100 named repositories and `--prs` from 1 to 200 per repository. It examines at most four pages of recent closed PRs, so it can return fewer merged PRs than requested. It skips archived/private repositories and notes unavailable PR endpoints. It is a bounded snapshot rather than a complete history. Keep the model API key unset for a manual trial with no provider calls.

## Establish one useful, scoped decision

1. Open an imported source. Check its original PR URL, recorded merge SHA, merge date and excerpt against the upstream discussion. A merged PR or its description alone does not establish current policy or prove code behavior.
2. On the project page, choose **Propose a memory**. Write one decision that matters to a real task, cite the imported PR, and set **Reviewed applicability**: the numeric GitHub repository ID, exact branch, and an inclusive UTC valid-from timestamp ending in `Z`. An optional valid-until timestamp is exclusive. Use a time/branch you have actually checked; MemoryNet does not infer branch ancestry or determine applicability for you.
3. Have a different authorized human review the exact proposal revision and its evidence. In the local sandbox, **YOUR_OWNER: local evidence reviewer** is a test identity for exercising this flow. Switching personas by yourself demonstrates the checks; it does not establish independent review or authenticate a second person.
4. Confirm the approved record's scope and history, then search for it on the project page. Pending, suspended, replaced and revoked records are kept separate from current guidance.
5. Open **Affected work**, pin the approved decision to a task/spec baseline, approve a later revision through the same review flow, and revalidate the task. It should need review and refuse an export that claims current context. Follow the [affected-work guide](affected-work.md) for exact artifact fields and limits.

**Imported candidates have no reviewed applicability.** Approving one as imported leaves it legacy project-only and excludes it from scoped MCP and affected-work baselines. The recipe above creates a new scoped proposal citing its source; explicitly configured scoped [Decision Guard extraction](decision-guard.md) is another option. An ordinary candidate that is still pending may instead be edited to add applicability as a new reviewable proposal revision, after which a human who authored no revision must approve it. Once legacy unscoped guidance is approved, targeted changes preserve its scope; create a new decision for scoped authority. Do not silently attach repository/branch authority to historical records.

If the repository has no merged PR evidence, use the [synthetic walkthrough](usage.md#start-a-new-workspace) or record an existing public PR manually. A repository connection alone does not crawl code or manufacture decision records.

## Retrieve from a coding agent

Use the import summary's `importerId` as an existing agent principal, the desired project's `id`, that repository's numeric GitHub ID, and the exact branch approved above. The importer already has local contributor and repository-read grants. These are local evaluation grants, not live upstream permissions.

Stop the app, create a new private binding, and restart the same workspace:

```sh
mkdir -p .local/mcp
npm run mcp:binding -- .local/mcp/personal-trial.json AGENT_UUID PROJECT_UUID GITHUB_NUMERIC_REPO_ID EXACT_BRANCH
MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/personal-trial MEMORYNET_AGENT_BINDING_FILE="$PWD/.local/mcp/personal-trial.json" npm run app
```

Configure an MCP host to launch MemoryNet's `src/scripts/mcp.ts` over stdio with an absolute script path and `MEMORYNET_AGENT_BINDING_FILE` pointing to that same absolute binding path. Set `MEMORYNET_APP_URL=http://127.0.0.1:3050`. The host connects to the running app; it must not open the app database. The sole tool is `get_context`, accepting only `query` and optional `limit`. Ask for words present in your approved decision and check returned IDs, revisions and citations. See the [exact MCP setup and contract](agent-context.md#mcp-and-authenticated-loopback-bridge).

Bindings expire after 24 hours, grant no database permissions by themselves, and must stay private. Host-specific configuration is still manual. A successful retrieval receipt proves delivery of those versions, not that the coding agent used them. A successful empty result means no matching current scoped guidance; an authorization or storage failure is an error, not an empty success.

## Refresh and preserve your evaluation

The importer refuses another snapshot of the same upstream owner in the same database. Download again and import into a **new** database, such as `.data/personal-trial-refresh`, to retain the original evidence and reviews. Reviews are not automatically migrated or merged into that refreshed snapshot. There is no watcher or incremental review-preserving sync yet.

Stop the app and use the [backup/restore commands](local-operations.md), with `MEMORYNET_DATA_DIR=.data/personal-trial` explicitly set for backup. JSON knowledge export is useful for portability; it is not a full database backup. Do not reset an existing evaluation merely to refresh evidence.

The separate `data:download` / `data:load` commands create synthetic stand-in approvals for display testing. Use `data:download:evidence` / `data:import:evidence` when imported records must await review. Neither importer creates a source-checkout catalog or access-key configuration.
