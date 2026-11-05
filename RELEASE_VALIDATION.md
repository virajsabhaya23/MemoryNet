# Local release gate

## Observed on November 4, 2026

| Copy tested on macOS arm64 | Clean install and typecheck | Automated suite |
|---|---|---|
| Public main at `2ef4064058e02e284603e1d7cebcc1b92bd1d13e` | Passed | 388 passed on Node 26.3.0 |
| Starting local development at `6a5cc4cee2ae76d63c59e1e902aa73ce19ed8692` | Passed | 497 passed on Node 26.3.0 |
| Finished local source in a Git checkout | Passed | 501 passed on Node 26.3.0 |
| Allowlisted source export without Git metadata | Passed | 500 passed, one Git ignore-rule test skipped on Node 24.22.2 |

The final local snapshot includes changes beyond `9864d4a8cb9bc0b926aa577afa2743c269cc39d3`. The tested implementation fingerprint is `91ba7e314f37c7f681c30ad1f1b299c032ec3357023de31f7f1d491ac2688cb5`. To reproduce it from RELEASE-MANIFEST.json, sort the entries for src/, test/, examples/, migrations/, .github/workflows/, package.json, package-lock.json and tsconfig.json by path. Hash the concatenation of each UTF-8 path, a zero byte, its lowercase hexadecimal file SHA-256 and a newline. This identifies 297 implementation and verification files independently of report-only edits.

The final Node 26 run also passed the scoped MCP smoke, affected-work smoke, cross-repository workspace demonstration, 26-file website check and pinned ESLint controls. npm audit reported zero known vulnerabilities. Both pinned Actions commits resolved. The hosted matrix was not run. The installed Codex app server discovered the read-only tools through the explicit session override.

## Reproduce the release checks

Target the local developer build for public or synthetic evidence. Run the following in a clean copy with Node 24+ and Git. No model account is required.

```sh
npm ci --ignore-scripts
npm run check
npm run eval:smoke
npm run eval:work
npm run demo:workspace
npm run site:check
npm audit --audit-level=high
npm --prefix examples/eslint-demo/scenario/start ci --ignore-scripts --no-audit --no-fund
node examples/eslint-demo/verify.mjs
```

The workspace demo starts real loopback servers on disposable ports, uses the official MCP client and proves that a receipt survives process restart. It tests an unchanged control, an unrelated change, an approved revision citing a separate upstream checkout, a foreign credential, withdrawal, stale reporting, and concurrent approval attempts. Reviews use fixture identities. The ESLint gate checks the pinned executable against obsolete, passing, weakened-policy and changed-application controls. Test coverage also includes offline backup/restore, migration/locking and CSRF/origin rejection.

For an export, run `npm run release:export -- /path/to/new-directory`. Inspect the file manifest and repeat the gate on the exported source. The exporter checks known credential patterns and excludes private runtime state. A high/critical audit finding blocks this gate until maintainers document the affected path and remediation. Registry unavailability is an incomplete audit.

Hosted CI is configured for Linux and Windows with Node 24 and 26. A local run exercises only its observed platform. Private repositories, remote MCP, shared identity, and hosted team deployment still require the controls in [production readiness](docs/production-readiness.md).
