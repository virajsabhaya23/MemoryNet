# Contributing

Read the [README](README.md), [architecture](docs/architecture.md), and [security boundaries](SECURITY.md) before changing behavior.

## Open a pull request

Base contribution branches and pull requests on `development`. Releases go to `main`. Only the repository owner can push to or merge into either protected branch.

1. If you have write access, run `git fetch origin development` and `git switch -c fix/short-description origin/development` in your MemoryNet clone. Otherwise, select **Fork** on [MemoryNet on GitHub](https://github.com/virajsabhaya23/MemoryNet) and use the commands below. Replace `YOUR-GITHUB-LOGIN` with your login and choose a branch name that describes your change.

   ```sh
   git clone https://github.com/YOUR-GITHUB-LOGIN/MemoryNet.git
   cd MemoryNet
   git remote add upstream https://github.com/virajsabhaya23/MemoryNet.git
   git fetch upstream development
   git switch -c fix/short-description upstream/development
   ```

2. Make your change, run the [relevant checks](#changes), and commit it. Push your feature branch with `git push -u origin fix/short-description`, using your branch name.
3. Open [MemoryNet's compare page](https://github.com/virajsabhaya23/MemoryNet/compare). If you used a fork, click **compare across forks**, confirm `virajsabhaya23/MemoryNet` is the base repository, and select your fork as the head repository. Choose **`development`** as the base branch and your feature branch as the compare branch. [GitHub's fork-to-PR instructions](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-a-pull-request-from-a-fork)
4. Describe what changed and how you checked it. Link the related issue if there is one, then create the pull request. Follow the [CLA signing instructions](#contributor-license-agreement) and respond to review feedback on the PR. A first-time contributor's CI runs may wait for maintainer approval.

## Development

Use Node.js 24 or newer, npm, and Git:

```sh
npm ci --ignore-scripts
npm run check
MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/development npm run app
```

Tests use isolated synthetic databases. A model key, GitHub account, and running app are not required. `npm run eval:smoke` exercises the stdio/loopback MCP path; `npm run eval:work` checks decision changes and stale-export refusal. Both use synthetic fixtures and make no model calls.

## Changes

- Describe the problem, resulting behavior, and verification in the pull request.
- Preserve exact-version review, separate author/reviewer roles, permission filtering, and history.
- Add a migration for schema changes; do not edit an applied migration.
- Add focused tests for behavior changes, especially authorization, review, retrieval, and error handling. Run `npm run check` before submitting.
- When changing the context contract, run `npm run contract:export` and include the generated schemas.
- For website changes, run `npm run site:check` and `npm run site:build`. See [website development](docs/github-pages.md).
- Inspect `git diff --check` and the staged file list. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Documentation and data

The [documentation index](docs/README.md) lists the public installation, usage, API, and contributor guides. Keep those accurate for a fresh checkout. Document supported behavior and limitations; distinguish implemented features from proposals.

The documentation allowlist in `.gitignore` keeps unreviewed documents out of the public tree. Update it when adding a necessary public guide. Personal notes, research, roadmap drafts, interview material, historical execution logs, and internal release evidence belong in a separate development workspace, outside this checkout.

Use synthetic fixtures or attributed public material. Keep credentials, generated bindings, databases, backups, recordings, and private evidence out of commits. The app is a loopback-only local prototype; private organizational data and shared hosting are unsupported.

## Contributor License Agreement

Before a pull request can be merged, its author and every human commit author must agree once per version to the [MemoryNet Contributor License Agreement](CLA.md). After opening the pull request, post the [agreement comment](CLA.md#8-how-to-agree) in the PR's **Conversation** tab if the CLA check asks you to sign. You keep your copyright. The agreement licenses your contribution to the maintainer, including the right to license MemoryNet under other terms later. Versions already published under Apache-2.0 stay available under Apache-2.0. The check reads pull-request metadata only, records agreements on the `cla-signatures` branch, and exempts maintainers listed in `.github/TEAM_MEMBERS`.

Submit only work you have the right to contribute, and identify any third-party material and its license in the pull request. If an AI coding assistant materially contributed to a change, disclose it in the commit metadata, for example with a `Co-authored-by:` trailer.
