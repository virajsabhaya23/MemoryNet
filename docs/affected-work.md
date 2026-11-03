# Decision changes and affected work

Affected work tracks explicit task dependencies on approved decisions. It checks whether pinned context remains current and exports a portable JSON or Markdown bundle. Start with the [README](../README.md) and [usage guide](usage.md).

## Use the web workflow

1. Start the intended workspace. For a separate trial use `MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/personal-trial npm run app`.
2. Propose a decision with a repository, exact branch and validity interval. Have a separate authorized reviewer approve it. Legacy unscoped memories cannot be pinned.
3. Open **Affected work** in the project. Create a task baseline with its repository ID, exact branch, full Git commit, spec path, stable requirement ID and spec text. Select the approved decision versions the task depends on.
4. Download the JSON bundle or Markdown context. For an OpenSpec change, manually place the Markdown beside its planning artifacts, such as `openspec/changes/<change>/memorynet-context.md`, and have the coding agent read it.
5. Before finalizing work, reopen **Affected work**. Revision changes, replacements, suspension, reinstatement, revocation and validity expiry flag dependent tasks.
6. Review the change, update the spec and implementation, run the repository's behavior checks, then create a fresh baseline. Close the old task when handled. Baselines are never silently refreshed.

The baseline retains a SHA-256 hash of submitted spec text, not the text itself. Textarea line endings can differ from original file bytes. The form does not read a Git repository or verify the declared commit. Use the domain API with a hash computed from Git when byte identity matters, then use reconciliation below.

Synthetic example data and imported public candidates initially lack applicability. Create a new scoped proposal rather than inferring scope from those records.

## Bundle and access rules

Bundles contain stable `MN-<memory UUID>` identifiers, exact revisions, approved text, content SHA-256, approver/time, applicability and citations. Artifact links contain repository-relative paths, external requirement IDs and SHA-256 hashes. Requirement links are contributor declarations; each task depends on every decision it pins.

Export rechecks the pinned decisions from a consistent snapshot and refuses stale or closed baselines. `current` means every pin remains approved, unchanged, in the same lifecycle generation and applicable now. It does not establish that all relevant decisions were selected, artifacts still match their hashes, or code satisfies a requirement. Downloaded context can become stale immediately; revalidate before acting on it.

Reads require project permissions, fresh repository access and access to current and pinned historical evidence. If any dependency becomes unreadable, the entire task is withheld, including its title and artifacts. Storage failures are errors rather than successful empty assessments.

## Domain API

`src/index.ts` exports `createWork`, `listWork`, `exportWork` and `closeWork`. `WorkInputSchema` accepts artifact kinds `spec`, `instruction`, `file` and `test`, with validated paths, requirement IDs, hashes and decision versions. A baseline supports up to 40 artifacts and 20 decision pins. The web form begins with one spec artifact.

These are local TypeScript APIs. The read-only [MCP interface](agent-context.md#mcp-and-authenticated-loopback-bridge) serves scoped decisions rather than task baselines.

Run the isolated synthetic workflow check with `npm run eval:work`. It exercises current export, replacement, affected-task detection and stale-export rejection in memory, without provider calls or changes to app data.

## Check committed artifact bytes locally

Download a current JSON bundle, then run:

```sh
npm run --silent work:reconcile -- /absolute/path/to/repository /absolute/path/to/bundle.json > .local/artifact-observation.json
```

The command reads each declared artifact from the exact full commit using Git object plumbing and compares SHA-256 over raw committed bytes. It ignores working-tree edits and Git replacement objects. Results are `match`, `changed`, `missing` or `unsupported`; symlinks and submodules are unsupported.

Exit codes are 0 for all matches, 1 for review needed and 2 for invalid input, unavailable commit or read failure. Each Git command has a ten-second timeout and eight-MiB output bound. The command executes no repository scripts, changes no database state and makes no network or model requests.

The JSON receipt is an unsigned local observation. It does not authenticate repository identity or branch ancestry, refresh decision authority, validate requirement meaning or test code behavior. Re-export current context at the action boundary. Bundles cannot supply executable checks or test commands.
