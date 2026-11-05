# Use the local app

This walkthrough covers evidence, review, search, and changed decisions using synthetic data. It requires Node.js 24 or newer and no API key or GitHub account. For real public PR evidence, use the [public repository guide](public-evidence-workspace.md). Keep the app on loopback and use public or synthetic material; see [security boundaries](../SECURITY.md).

## Start a new workspace

From the MemoryNet checkout:

```sh
npm ci --ignore-scripts
MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/walkthrough npm run app
```

Use a new directory if `.data/walkthrough` already contains data. Only one process can open a database, and port 3050 must be free. The app applies migrations at startup. `MEMORYNET_PROTOTYPE_CONFIG=off` selects the development sandbox even when a local prototype configuration exists; a selected prototype configuration otherwise overrides `MEMORYNET_DATA_DIR`.

Open [http://127.0.0.1:3050](http://127.0.0.1:3050), then choose **System → Overview → Load synthetic example data**. The loader requires an empty database. Select **Cody Contributor** and open **Acme (synthetic) → Platform → Checkout**.

The example also includes **Rhea Reviewer**, who can review Checkout proposals, and **Rudy Reader**, who can read approved knowledge. **Switch person** exercises their local roles; it does not authenticate separate people or establish independent review.

## Record evidence and propose a decision

1. On Checkout, find **Record pull request evidence**. Select `acme-synthetic/checkout-service`, enter PR number `42`, leave the optional link and commit fields blank, and enter this excerpt:

   ```text
   Synthetic walkthrough evidence: retry a failed request at most two times.
   ```

   Choose **Record evidence**. The generated GitHub URL is a fixture reference, not a real PR.
2. In **Propose a memory**, select type `decision`, title `Synthetic retry limit`, and text `Retry a failed request at most two times.` Cite `pull/42`.
3. Under **Reviewed applicability**, choose repository `1001`, enter exact branch `main`, and use a valid UTC timestamp in the past ending in `Z` for **Valid from**. Leave **Valid until** blank. Keep yourself as owner and choose **Propose**.
4. Open the pending proposal and inspect its text, citation, and applicability. It supplies no current guidance until approved. A proposal without reviewed applicability remains project-only and cannot be used for scoped MCP or an affected-work baseline.

## Review and retrieve

1. Switch to **Rhea Reviewer**, open **Review**, and select the proposal. Inspect the exact revision and evidence, then approve it. A human who authored any proposal revision cannot approve it.
2. Switch to **Rudy Reader**, open Checkout, and search for `Synthetic retry limit`. The result includes the approved version and evidence. Open the record and **History** to inspect its review and versions.
3. Open the organization's **Network** to inspect the record and its source connections. The map and search remain permission filtered.

For coding-agent retrieval, use the [MCP setup and API contract](agent-context.md#mcp-and-authenticated-loopback-bridge). It requires an existing permitted agent, a private binding, and a scoped approved decision. The agent receives bounded context with version IDs and citations; a retrieval receipt records delivery rather than code compliance.

## Track work through a decision change

1. Switch to **Cody**, open Checkout's **Affected work**, and create a context baseline. Use repository `1001`, branch `main`, a task title, spec path `docs/retry-policy.md`, requirement ID `RETRY-001`, and spec text `Retry a failed request at most two times.` For this fixture only, enter `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` as the full source commit. Select the approved decision and choose **Create context baseline**.
2. Confirm **Context current** and download the JSON or Markdown bundle. The commit and spec are declarations in this walkthrough, not files MemoryNet has checked out or verified.
3. Record another synthetic source, PR `43`, with excerpt `Synthetic walkthrough update: retry a failed request at most one time.` Open the approved decision and choose **Propose a change → A new version of this memory**. Change its text to the one-retry rule and cite `pull/43` instead of `pull/42`.
4. Switch to **Rhea**, inspect the proposed revision and approve it. Switch back to **Cody** and reopen **Affected work**. The original task now needs review, and its stale context cannot be exported.
5. Inspect the decision history, update the task's spec and implementation, and run the target repository's checks. Create a fresh baseline explicitly and close the old tracked task when its follow-up is complete. See [Affected work](affected-work.md) for artifact reconciliation and export limits.

## Stop and preserve data

Stop the app with Ctrl+C. Restart it with the same command to reopen the workspace. Use a new database directory to repeat the walkthrough independently. See [local operations](local-operations.md) for backup, restore, locking, and permanent reset.

## Select a local Git workspace

Run these commands from the MemoryNet checkout. Start with public or disposable synthetic repositories on a trusted machine. If you want an automatic walkthrough first, run `npm run demo:workspace`.

```sh
npm run workspace -- preview --root /path/to/projects
npm run workspace -- register --root /path/to/projects --project consumer --at PREVIEW_COMMIT --fixture
npm run workspace -- import --root /path/to/projects --project consumer --at PREVIEW_COMMIT --document docs/adr/retries.md --fixture
npm run workspace -- start --root /path/to/projects --project consumer --sandbox
```

Use the exact project path, commit and document printed by preview. The preview lists filenames and the origin host or a redacted presence indicator. It reads committed Git trees. Uncommitted edits do not enter a citation. Registration is idempotent for the same checkout and branch. Run register for each selected project. Each receives its own database, reader identity and read-only credential. Use an optional `--port 3051` at first registration to run a second project simultaneously. Status shows the chosen port.

Open the loopback URL printed at startup. In the synthetic sandbox choose **Fixture operator**, open the project, create a proposal, choose the imported source and set the target repository, exact branch and active validity interval. Switch to **Fixture reviewer** to approve the displayed version. Those personas simulate separate principals on one machine. Starting without `--sandbox` uses the fixed local operator. Stop the app before importing new evidence. A new file revision becomes evidence and requires another reviewed proposal to change a decision.

For a public upstream specification, select the consumer as the target and the dependency as the origin. Supply the upstream commit. Review this access decision before running the command. It connects the upstream checkout as an evidence source in the consumer database and declares read access for that fixture's operator, reviewers and agent. The decision still needs explicit consumer applicability. Revocation in a different isolated database is independent. A retry preserves withdrawals in the target database. Upstream access declarations can expire after 30 days and then fail closed.

```sh
npm run workspace -- import --root /path/to/projects --project consumer --from upstream --at UPSTREAM_COMMIT --document docs/adr/retries.md --fixture --share-public-source
npm run workspace -- status --root /path/to/projects --project consumer
npm run --silent workspace -- connect --root /path/to/projects --project consumer --client codex
```

The last command prints the client configuration. Add its named table to the trusted consumer project's local Codex config, or select `vscode` or `cursor` for their configuration format. The snippet contains local paths. The bearer token stays in its owner-only binding file. Keep the app running for the selected project. Restart that project's app near expiry, then reload the client's MCP server. If the checkout switches branches, select the new branch explicitly. The old binding continues to mean its original branch until expiry or removal. Moving or recreating the checkout gets a new local identity.

For an installed Codex CLI that does not pick up project TOML, use its process-scoped `-c` option. Keep the app running. From the MemoryNet checkout, run:

```sh
option=$(npm run --silent workspace -- connect --root /path/to/projects --project consumer --client codex --session-option)
codex -c "$option" mcp get memorynet
```

Launch Codex for the consumer with that same `-c "$option"` option when you intend to run a coding session. The inventory command above makes no model request. The installed Codex app server recognized the binding path and advertised all three read-only tools with an explicit override.

Ask the agent to call `get_task_context` before changing code and save the returned `retrievalId`. Before finishing, call `revalidate_context` with that ID. A stale result identifies the pinned and observed revision and gives the reasons. Fetch fresh guidance and review the actual changes. An empty receipt or one created before lifecycle generations were recorded can return UNKNOWN. An error or denial is a failed check. CURRENT covers the delivered decisions only. Newly relevant decisions require a fresh query. **Affected work** separately lists tasks with explicitly declared pins and can refuse their stale exports.

Discovery stops at checkout boundaries, depth three, 32 candidates, 4,096 workspace entries and 20,000 inspected Git entries. It supports regular SHA-1 checkouts with a committed named branch, loose or packed objects, root README/README.md and AGENTS.md, and Markdown directly in docs/adr, docs/decisions and docs/specs. Only the selected blob is imported, up to 64 KiB, with a 4,000-character excerpt and the SHA-256 of the full committed bytes. Its citation identifies the origin checkout, path and commit without disclosing its absolute path. Dot directories, common build, dependency and secret directories, links, worktree pointers, bare/alternate stores and detached heads are excluded or reported as unsupported.
