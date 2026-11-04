# Deployment boundaries

MemoryNet is a local prototype for public or synthetic evidence. It is not a supported service for shared hosting or private organizational data. See [security](../SECURITY.md), the [trust model](trust.md), and [runtime modes](prototype.md).

## Available now

- Local repository setup, coding-client configuration, and diagnostics.
- Direct single-operator local access and optional GitHub account connection; existing login gates remain enabled on upgrade.
- Exact-version human review, configurable approval thresholds, and scoped agent context, proposals, and reports.
- Optional GitHub device-flow sign-in with repository-access refresh for signed-in people. Roles and organization membership remain local.
- Audit integrity verification, external checkpoints, offline backup/restore, and automatic pre-upgrade backups.
- Public PR evidence import and optional locally configured pinned source browsing.

## Required before shared or private-data use

| Area | Remaining work |
| --- | --- |
| Identity and delegation | Hosted sessions, tenant membership, invitations, account recovery, and remote agent authorization with revocation. |
| GitHub integration | Signed ingestion, organization/team synchronization, and repository-permission updates beyond currently signed-in people. |
| Data lifecycle | Record deletion and retention across evidence, revisions, receipts, exports, and backups; recovery must preserve revocations. |
| Operations | A supported deployment/storage model, concurrent-user load testing, monitoring, incident ownership, and tested recovery targets. |
| Installation | Verify the advertised OS and coding-client combinations with fresh installations and independent users. |
| Model processing | Define the data-processing boundary and durable usage controls before sending private text to a provider. |

## Product limits

Affected work checks context freshness and declared artifact hashes. It does not establish that code implements a decision, deliver notifications, or block merges. Search and graph expansion are heuristics and may miss relevant guidance. Agent definitions are reviewed local records, not an agent execution service. Product effectiveness and repeat adoption are unproven.

Use the [public evidence guide](public-evidence-workspace.md) for a local trial and [local operations](local-operations.md) for recovery. Automated synthetic checks establish specific behaviors, not production approval.
