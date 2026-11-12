# Changelog

## Unreleased

- Keep the network map live while it is open: it re-reads the same permission-filtered records every 15 seconds through `GET /orgs/:id/network/live` (`304` while unchanged), grows new records in place, rings what changed in cool blue, and updates the counts, attention chips and brain registry. It pauses in a hidden tab and stops after sign-out or lost access.
- Keep repository and project cells apart: a hub and its own records form one cell, cells never overlap, outlines are tight rounded hulls, several connections between the same two records fan out, and names no longer cover nodes or the floating panels.
- Rebuild the brain registry as a structured panel: the four kinds as one tiled surface, a ready-for-AI figure with a meter, needs-a-person rows with counts, dated latest changes and a folded guide. The details dock widens with the window, and on narrow screens it follows the map instead of pushing it below the page.
- Add a replay of how the map grew (R), full screen for the map, and visible signs in lists and search (they were drawn in the panel's own colour).
- Give the tab icon an address that changes with the icon, so browsers drop the cached teal icon.
- Make the network map a living context graph: each repository is a tinted cell, records are lit nodes with a sign for what they are (repository, pull request, commit, decision), connections are typed and gently bowed, and travelling light and activity-driven sparks show recent change in slight depth. Reduced motion keeps the map flat and still.
- Compact the map's panels into four small corners: one slim command bar, a short kinds list with a folded colour key, and a details panel that opens only with a selection.
- Show cropped views of the current app on the website and give the favicon the graphite and amber theme.
- Add deterministic Brain recommendations (definitions based on changed decisions, repeated outdated reports, repeatedly rejected agent proposals, conflicting current decisions) to the project Brain panel and the Overview's Needs you; they link only to existing pages and propose forms.
- Deliver reviewed definitions in task context (contract v3): the active rules and instructions of the bound project, its business unit and organization, matching skills and the calling agent's own definition, within about 35% of the token budget and flagged `reviewNeeded` when a decision they are based on changed. Receipts and the audit ledger record each delivered definition version (migration 021; earlier ledger payloads unchanged), and `revalidate_context` (receipt check v2) reports definitions that changed, were retired or lost their basis.
- Add `npm run eval:brain`, a synthetic, model-free check of what task context, a permission-aware lexical RAG baseline and an unfiltered ablation deliver to the same agent under the same budget; it does not measure agent effectiveness.
- Redesign the app and website in the Hallmark Console system (graphite dark, paper light): one token set in `design.md`, self-hosted Host Grotesk and Atkinson Hyperlegible Mono, a rail that becomes a top-bar menu on phones, two-column project and decision pages, a version trail on history pages, restacking tables, and map colours that follow the same roles.

- Sync lab local-operator access and optional GitHub connections; preserve existing login gates on upgrade.
- Add a one-command decision-change demo with real MCP retrieval, exact-quote validation, stale-export assertions, and an explicitly synthetic read-only replay.
- Lead the README and website with decision-change outcomes, and document the limitations of historical comparison results.
- Display recorded extraction latency, output limits and reasoning effort alongside provider, model and token usage.

- Add repository setup, startup, coding-client connection, and workspace diagnostics commands.
- Add task-aware MCP retrieval, agent proposals and outdated reports, and capability-scoped v2 bindings; retain v1 context compatibility.
- Add configurable review thresholds, reviewed decision links and governed paths, and instruction-like evidence flags.
- Add a tamper-evident audit ledger, verification/checkpoint commands, and organization integrity views.
- Add optional GitHub device-flow sign-in and repository-access refresh for signed-in people.
- Back up existing databases before pending upgrades and retain all ordered schema migrations.
- Update the app's graph, typography, navigation, governance, and repository views.
- Refresh public documentation, API schemas, contributor guidance, and release-file protections.
- Keep the review queue readable across desktop and mobile layouts, and allow source-distribution checks without Git metadata.

## 0.1.0

Initial public source for the local MemoryNet prototype.
