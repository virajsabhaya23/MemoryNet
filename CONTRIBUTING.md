# Contributing

Read the [README](README.md), [architecture](docs/architecture.md), and [security boundaries](SECURITY.md) before changing behavior.

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

Before a pull request can be merged, its author and every human commit author must agree once to the [MemoryNet Contributor License Agreement](CLA.md) by posting the comment the CLA check asks for. You keep your copyright. The agreement licenses your contribution to the maintainer, including the right to license MemoryNet under other terms later; versions already published under Apache-2.0 stay available under Apache-2.0. The check reads pull-request metadata only, records agreements on the `cla-signatures` branch, and exempts maintainers listed in `.github/TEAM_MEMBERS`.

Submit only work you have the right to contribute, and identify any third-party material and its license in the pull request. If an AI coding assistant materially contributed to a change, disclose it in the commit metadata, for example with a `Co-authored-by:` trailer.
