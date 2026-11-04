# Demonstration and evaluation evidence

## Reproduce the decision-change workflow

Run `npm ci --ignore-scripts`, then `npm run demo`. Open `.local/decision-demo/index.html` and inspect its adjacent `report.json`. The command creates a temporary database and owner-only agent binding, connects two real MCP SDK clients through the loopback app, and removes its temporary state when finished. It does not load your database, model credentials or GitHub credentials.

The run asserts that:

1. A scripted extraction response resolves to an exact source quote with validated UTF-16 offsets.
2. Pending guidance is withheld from MCP, and an agent cannot approve it.
3. A distinct fixture reviewer approves an exact version, which is delivered with citations and a retrieval receipt.
4. A task pins that decision. A pending replacement leaves the original authoritative.
5. Approval of the replacement flags the original task for review and blocks stale context export.
6. A fresh MCP client receives only the replacement; all deliveries have matching persisted receipts.

The source evidence, model responses and human approval actions are automated synthetic fixtures. The run proves these integration behaviors; it does not demonstrate live Meta quality, independently operated human review, code implementation, or comparative agent effectiveness. Replacements create new decision IDs at revision 1, rather than incrementing the original record's revision.

`npm run demo -- --website` regenerates [the static walkthrough](../website/demo.html) and [its JSON report](../website/demo-report.json) from a new run. `npm run site:serve` previews it under `/MemoryNet/demo.html`. These commands do not publish or deploy anything. The replay has no database connection, credentials, approval controls or model calls and can be included in the ordinary static website artifact.

## Three-minute presentation

| Time | Show | Explain |
| --- | --- | --- |
| 0:00–0:30 | Exact highlighted quote | Sources support candidates; model output is a suggestion. |
| 0:30–1:00 | Pending result and approval | Only the exact approved version becomes context. Agents cannot approve. |
| 1:00–1:30 | Agent receipt and pinned task | The team can see which guidance active work used. |
| 1:30–2:15 | Replacement and blocked export | A changed decision identifies work that needs review. |
| 2:15–3:00 | Fresh MCP context and report | The next agent receives the current decision; the old task still needs a reviewed baseline. |

For live Meta extraction, use the app's [Decision Guard workflow](decision-guard.md) with explicitly selected public evidence. Its run page shows provider, model, reported tokens, latency and generation settings. The offline replay deliberately requires no API key.

## Historical observations, reviewed November 3, 2026

The local lab contains earlier observations. Their reviewed public summary is [evaluation.json](../website/evaluation.json), including SHA-256 identifiers for the source reports. These results were inspected, not rerun as part of this change. Raw lab traces are not part of the public source distribution; the hashes identify the reviewed files rather than independently proving their contents.

| Observation | Outcome | Limitation |
| --- | --- | --- |
| Synthetic retry task: structured decisions versus MemoryNet | Both passed | One observation per arm; agent model, token counts and cost were not recorded. |
| Synthetic retry task: outdated instructions, dated sources, MemoryNet | Outdated instructions failed; dated sources and MemoryNet passed | The instructions-only control deliberately lacked the newer decision. This is not a comparison against equally maintained instructions. |
| Controlled ESLint migration | Ordinary-source baseline and MemoryNet both passed seven checks | Historical summary; equivalent resource budgets and independent owner-operated approval were not established. |

These observations do not support a stale-code reduction percentage, a relevance improvement, or a claim of superiority over maintained instructions. The existing preregistration tooling freezes study inputs; it is not evidence that a preregistered study has been completed.

## What remains to measure

Before making effectiveness claims, freeze rights-cleared tasks, sources, maintained-instructions controls, model versions, budgets, scoring rules and sample size. Compare implementations after a decision changes while work is in flight. Record stale implementations, overall failures, retrieval misses and all human maintenance time. Keep lifecycle correctness, retrieval relevance and code correctness as distinct outcomes.

Semantic retrieval and model reranking remain proposed work. Current task context combines scoped keyword matches, governed paths and reviewed graph links. Any future ranking path must retain permission, repository, branch and validity filtering before disclosure, and needs relevance measurements against this baseline.
