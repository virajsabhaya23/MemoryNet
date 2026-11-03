# Security

MemoryNet is a local pilot build for synthetic and public test data. There is no production-supported hosted deployment or security maintenance guarantee at this stage.

## Trust boundaries

- The web server binds to `127.0.0.1:3050`. Keep it local; do not expose it through a reverse proxy, tunnel, or shared host.
- In sandbox mode, the person picker is not authentication. Anyone able to use the app can choose a principal, including an administrator. Domain role checks do not establish that person's identity.
- A separately configured local prototype hashes an owner-only access key and binds sessions to a configured human principal/GitHub numeric ID. It disables persona switching and System fixture endpoints. This verifies possession of a local key and database/config consistency, not current GitHub identity or organization membership. It is not multi-user authentication.
- `npm run app` auto-detects ignored `.local/prototype/config.json`; its database overrides `MEMORYNET_DATA_DIR`. Use `MEMORYNET_PROTOTYPE_CONFIG=off` for explicit isolated sandbox trials. Other scripts do not load prototype config or `.env.local`; set their actual database directory explicitly. See [configuration](docs/local-operations.md#configuration).
- Sandbox System pages simulate trusted integration events; they are disabled in configured prototype mode. A GitHub App, signed webhooks, live permission synchronization, hosted identity, and remote MCP authorization are not implemented.
- Core repository-access freshness defaults to 15 minutes; the local app extends it to 30 days for fixture use. This is unsuitable for live organizational access control.
- Local MCP uses an expiring bearer credential in an owner-only file. A copied credential remains usable until expiry or revocation. It does not grant database roles or repository access. See the [interface contract](docs/agent-context.md).
- Model extraction sends selected evidence to Meta after an explicit action. The attempt allowance resets on restart and is not a durable spending limit. Provider text and source evidence are untrusted; citations still need human review.
- Databases, retrieval records, and exports can contain evidence text and query information. Offline backup/restore is available; backups contain the entire database, are not encrypted, and require the same pinned PGlite version to restore. Record-level deletion and retention are not implemented. See [local operations](docs/local-operations.md).
- Local HTTP requests have bounded headers, bodies, and upload time; Host and same-origin/CSRF checks protect the browser boundary. These checks do not replace authentication or protect against another process running as the same OS user.
- File-backed databases use a process ownership lock. A crash leaves a lock intentionally; verify the owning process has stopped before removing it. Older versions and external database tools do not participate in this lock.

The public evidence downloader accepts only active public repositories. Pinned source browsing validates configured origin and commit checks; it is not live repository permission verification.

Use `.env.local` or the in-memory settings form for model keys. Keep `.data/`, `.local/`, credentials, bindings, raw logs, and private development notes outside version control. Ignore rules do not remove files already committed or erase their history. Share a reviewed Git checkout rather than a copy of the entire working directory.

## Unsupported use

Do not use this build for private or internal repository data, shared tenant access, or a remotely exposed service. Those uses require verified user identity and agent delegation, signed ingestion and live repository permissions, record deletion and retention, and tested deployment/recovery operations. These capabilities are not implemented. A local access key and domain role checks do not supply them.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** option if the maintainer has enabled private reporting. If no private channel is available, open a minimal issue asking the maintainer for a private contact method without including exploit details or sensitive data. Do not put keys, private evidence, tokens, or affected users' data in a public issue.

Include affected revisions, reproduction steps using synthetic data, expected and observed behavior, and likely impact. Never send a live credential as proof. No response-time commitment is currently published.
