# Pinned public ESLint evidence

These are retained inputs to the [portable example](../README.md). Preserve the source snapshots and manifest when replaying historical checks; downloading newer documentation creates a different source set.

These public source snapshots were retrieved on October 31, 2026. `manifest.json` is the import contract; `SHA256.json` pins the distributed source bytes. The offline verifier checks PR merge metadata, exact excerpts in documents from those revisions, release tags, and package metadata. Consistency of a saved snapshot is not a fresh online provenance attestation.

- Historical v9 compatibility: [PR #17927](https://github.com/eslint/eslint/pull/17927), merge `0a7911e09adf2aca4d93c81f4be1cd80db7dd735`.
- Removal in v10: [PR #20037](https://github.com/eslint/eslint/pull/20037), merge `c69fdacdb2e886b9d965568a397aa8220db3fe90`.

The v10 change was prospective when merged in November 2025; the retained release metadata identifies February 6, 2026 as the stable release date. Only the documents and metadata used by the verifier/importer are distributed. Exploratory downloads, live model traces, credentials, generated bindings, and private review logs are excluded.

ESLint source and documentation retain the MIT license of the OpenJS Foundation and ESLint contributors in [ESLINT-LICENSE](ESLINT-LICENSE). Public PR metadata preserves attribution; contributor comments are not imported as the decision excerpts. MemoryNet's Apache-2.0 license does not replace the upstream license.

```sh
node examples/eslint-demo/scenario/verify-sources.mjs
```
