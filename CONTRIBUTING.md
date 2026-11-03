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

The documentation allowlist in `.gitignore` keeps unreviewed documents out of the public tree. Update it when adding a necessary public guide. Personal notes, research, roadmap drafts, interview material, historical execution logs, and internal release evidence belong in the separate MemoryNet-Lab workspace, outside this checkout.

Use synthetic fixtures or attributed public material. Keep credentials, generated bindings, databases, backups, recordings, and private evidence out of commits. The app is a loopback-only local prototype; private organizational data and shared hosting are unsupported.

## License

Contributions intentionally submitted for inclusion are provided under the project's [Apache-2.0 license](LICENSE), as described in section 5. Submit only work you have the right to contribute. This does not transfer your copyright. Preserve bundled third-party licenses and attribution.
