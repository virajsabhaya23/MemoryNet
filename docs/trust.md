# Trust model

What MemoryNet guarantees, how each guarantee is enforced, how you can check it yourself, and what it does not claim. This describes the local prototype in this repository; the [production-readiness audit](production-readiness.md) lists what a shared or private-data deployment still needs.

## Guarantees and how they are enforced

| Guarantee | Enforced by | How to check |
| --- | --- | --- |
| Only approved, current guidance reaches people and agents as knowledge. Proposals, rejected, suspended, replaced and revoked records never do. | Proposals, memories and versions are separate tables; every knowledge read goes through one read rule (`READABLE_MEMORIES_SQL`). | Retrieval tests; a pending agent proposal returns no task context until approved. |
| Publishing needs a different human who wrote no version of the proposal. A project can require two or three different reviewers. | Application checks plus database constraints and triggers: approvers must be people, authors cannot approve, and a version cannot be published without the approvals its project policy requires (migrations 004 and 013). An earlier approval stops counting if its reviewer loses the reviewer role or access to the evidence before publication; the published version records how many approvals counted. | The project page shows the review policy and its history; the proposal page shows which approvals still count; each memory shows how many reviewers approved its version. |
| An approval covers one exact version. Editing creates a new version that needs its own approvals. Applicability, governed paths and links are part of that version. | Approvals, applicability and relations are bound to the stored proposal version and copied unchanged to the published version (migrations 009, 013 and 014). | Proposal history shows every version with its relations; approvals list the version they cover. |
| Access is checked on every read, and a link is never an access grant. | Memories are readable only with a project role and current access to every cited source. Links to memories a reader cannot see are removed before results leave the server. Task context only traverses memories the caller may read in the bound scope. | Tests cover hidden link targets in pages, proposals, history and agent context. |
| Agents can only read, propose and report, within an operator-chosen scope. | Agents hold at most the contributor role. Each binding names one agent, project, repository and exact branch, expires (24 hours by default, at most 7 days), and lists its capabilities. Proposals are owned by the person the binding names. Projects can turn agent proposals off or cap how many wait. | `npm run doctor`; the project's review policy. |
| Every delivery is recorded. | Each search or context response and its exact memory versions are written in the same transaction as the response; records are append-only. | The search log and the decision inspector on each proposal. |
| History is tamper-evident. | Every audit event and retrieval receipt is chained into a per-organization SHA-256 ledger (migration 012). Entries and chain heads are append-only by trigger. | `npm run ledger:verify`, checkpoints, and **Audit integrity** on the organization page. |
| Suspicious text is visible to reviewers. | Typed text containing a detected secret is refused; captured secrets are replaced. Possible personal data and instruction-like text (attempts to address an AI model, chat-role tags, hidden control characters) are flagged on sources and proposals. Batch approval skips proposals whose text or evidence is flagged, so they get individual review. Flags travel with citations in task context; the frozen v1 `get_context` citations do not carry them. | Flags appear as badges on sources, proposals and evidence. |
| A failure never looks like "nothing found". | Retrieval failures return an unavailable error and record a failed receipt; empty results say that no approved guidance matched. | Outage tests for search, context and task context. |

## Verify the history yourself

With the app stopped (one process owns the database):

```sh
npm run ledger:verify            # recompute every chain from the stored records
npm run ledger:checkpoint        # print one line per organization: mnl1.<chain>.<sequence>.<hash>
```

Store checkpoint lines somewhere MemoryNet cannot change: a ticket, a commit message, a signed note or a printed report. Later, pass them back:

```sh
npm run ledger:verify -- mnl1.<chain>.<sequence>.<hash>
```

While the app runs, administrators and owners can open **Audit integrity** on the organization page to recompute their organization's chain and check a checkpoint. The report holds identifiers and digests only.

How the chain works: each entry stores `sha256(previous hash : sequence : entry type : record ID : payload hash)`. The payload is a canonical rendering of the audit event, or of the receipt with every delivered memory version, computed when the receipt's transaction commits. The verifier in `src/ledger.ts` recomputes payloads with its own SQL rather than trusting functions stored in the database, so changed, deleted, reordered or inserted records, and records written with the ledger disabled, are reported.

What a passing verification shows: the chained records were not edited, removed or inserted since they were chained, and, with an earlier checkpoint, that history up to that point was not rebuilt. It does not show that the recorded actions were right, and without an external checkpoint someone with full control of the database files could rebuild the entire chain.

## Where your data goes

- Everything is stored in an embedded PostgreSQL database under `.data/` on this computer. The app listens on loopback only and sends no telemetry.
- The GitHub CLI reads repository details during setup and public pull requests for the evidence importer. When GitHub sign-in is enabled, the app contacts GitHub at sign-in and refreshes repository access every 5 minutes. Optional Decision Guard extraction sends selected source text to the configured model provider after an explicit action.
- The MCP server a coding client launches talks only to the local app. The agent credential stays in an owner-only binding file (`chmod 600`); client configuration files contain paths, never the credential.
- Exports and backups are plain files. Treat them as confidential.

## Review policy

Each project has a policy, changed only by administrators and owners, with a reason, as a new append-only version:

- **Approvals to publish:** 1 to 3 different reviewers. None of them may have written a version of the proposal, and all must approve the same version. A pending proposal is judged by the policy in force when its last needed approval is given.
- **Agent proposals:** on or off, and the most pending proposals one agent may have waiting (1 to 500).

Without a saved policy a project uses one reviewer and allows agents up to 25 waiting proposals.

## What MemoryNet does not claim

- Local mode uses one configured operator without sign-in; optional GitHub account connection verifies the linked account only and leaves repository permissions locally declared. Existing login gates are preserved unless explicitly overridden.
- Sandbox identities are not verified: anyone at the keyboard can choose a person, and repository access is locally declared. Optional GitHub sign-in verifies the linked GitHub account and repository access, while roles and organization membership remain local. Switching sandbox personas demonstrates the review rule; it is not independent review.
- A receipt shows what was delivered, not that an agent followed it or that the resulting code is correct.
- Content checks are bounded pattern lists. They miss things and sometimes flag harmless text; a flag asks a reviewer to look, nothing more.
- Retrieval ranking and graph expansion are heuristics: reviewed links, path anchors and shared evidence make results explainable, not complete. "No results" never proves no earlier decision exists.
- MemoryNet is not yet a shared or hosted service. Hosted identity and membership, signed GitHub ingestion, remote MCP authorization, and deletion and retention controls are prerequisites for private organizational data; see the [production-readiness audit](production-readiness.md).

Report security problems as described in [SECURITY.md](../SECURITY.md).
