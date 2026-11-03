# Consumer engineering instructions

This controlled consumer is pinned to ESLint **10.0.0**. These instructions reflect the current v10 migration decision, not the historical v9 compatibility option.

- Use flat configuration in `eslint.config.js`. ESLint v10 removed support for `.eslintrc` configuration; `ESLINT_USE_FLAT_CONFIG=false` no longer restores it. Remove the obsolete configuration and switch from the consumer.
- Preserve `no-undef` and `no-unused-vars` as errors. Preserve `eqeqeq` as an error with the `always` option. Do not disable configuration lookup or exclude application files from lint.
- Keep the exact ESLint dependency and lockfile. Preserve the existing `src/greet.js` and `test/greet.test.js` bytes. The permitted work is configuration and package scripts.
- Run `npm run lint` and `npm test`. Explain the source evidence supporting the migration.

Current source: [ESLint PR #20037](https://github.com/eslint/eslint/pull/20037), merged revision `c69fdacdb2e886b9d965568a397aa8220db3fe90`, removes legacy configuration in v10. Historical source: [PR #17927](https://github.com/eslint/eslint/pull/17927), merged revision `0a7911e09adf2aca4d93c81f4be1cd80db7dd735`, documents the deprecated compatibility option for v9 only.
