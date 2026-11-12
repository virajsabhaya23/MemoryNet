# Local runtime modes

MemoryNet runs on loopback with public or synthetic evidence. Single-operator local mode, the sandbox, access-key mode, and GitHub sign-in have different identity boundaries. See [security](../SECURITY.md) and [local operations](local-operations.md).

## Local workspace and upgrade behavior

`npm run setup` creates a profile naming a human operator. `npm start` opens as that operator without a sign-in screen when no existing login gate is configured. It creates a session on the first read; mutations still require a session, same-origin requests and CSRF tokens. Persona switching and System fixtures are disabled. This is access by the operator of the local computer, not verified identity or shared authentication.

`MEMORYNET_AUTH_MODE` explicitly selects `local`, `sandbox`, `access-key` or `github`. Without it, an existing GitHub client ID preserves GitHub sign-in; otherwise a prepared access-key configuration preserves its key gate. Only then does a matching operator profile default to local access. An upgrade never silently removes an existing login gate. A data-directory override does not borrow an operator from a different setup workspace.

With explicit `MEMORYNET_AUTH_MODE=local`, a configured GitHub client ID enables **Connections → GitHub**. This optionally verifies the account linked to the operator, keeps the token in memory, and supports disconnection without ending local access. It does not refresh repository permissions or change local access declarations. Use `github` mode for verified sign-in and repository checks.

## Sandbox

A fresh checkout uses the development identity picker and System fixtures. To select it explicitly:

```sh
MEMORYNET_AUTH_MODE=sandbox MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/personal-trial npm run app
```

Anyone at the keyboard can choose a fixture person. This demonstrates role and review rules; it does not authenticate separate people. Use the sandbox explicitly when demonstrating multiple people. A configured local operator cannot approve proposals they authored; separate reviewers still need their own access mode.

## Optional access-key configuration

`npm run app` reads the file selected by `MEMORYNET_PROTOTYPE_CONFIG`, or auto-detects `.local/prototype/config.json`. Use `off` to disable that selection. A configured `dataDir` takes precedence over `MEMORYNET_DATA_DIR`. An invalid explicitly selected configuration fails startup.

The configuration binds an existing human principal and GitHub numeric ID to an owner-only access-key file and a validated checkout catalog. Configuration and key files stay local. The schema and validation live in `src/web/prototype-config.ts`; there is no turnkey provisioning command for this advanced mode. It disables the identity picker and System fixtures. Possession of this local key does not verify current GitHub membership or permissions.

## Pinned source browser

An optional checkout catalog records numeric repository IDs, local checkout paths, original HTTPS origins, and pinned commits. Startup validates each checkout's origin and HEAD. **Browse original repository** reads Git objects at that pinned commit, never arbitrary filesystem paths or repository code execution. Binary and large previews are bounded; symbolic links are displayed explicitly. The catalog must be configured locally and is not included in source distributions.

A pinned checkout is separate from each source's historical PR merge commit. Refreshing it requires deliberately updating the catalog while preserving evidence and review history. Imported candidates still need exact-version review and applicability before scoped MCP delivery.

## GitHub sign-in

Any mode can instead use **Sign in with GitHub**. It replaces the sandbox picker, the prototype access key and the System controls.

1. Register a GitHub App (recommended: no account-wide scopes; grant repository *Metadata: read* and install it on the repositories you connect) or an OAuth App. In either case enable **Device Flow**. No callback URL or client secret is needed.
2. With the app stopped, link each person once: `npm run github:link -- --login THEIR-LOGIN` (defaults to the `npm run setup` owner; pass `--person PRINCIPAL-ID` for anyone else). It looks up the public numeric GitHub ID, refuses to relink a person or account silently, and records an audit event.
3. Set `MEMORYNET_AUTH_MODE=github` and `MEMORYNET_GITHUB_CLIENT_ID` (and, for an OAuth App reading private repositories, `MEMORYNET_GITHUB_SCOPE=repo`) in `.env.local`, then start the app.

Sign-in shows a GitHub code to confirm. The app then asks GitHub for the account and binds a new session to the person linked to that numeric ID; unlinked accounts are refused. It asks GitHub which connected repositories the person can read, records the answer, and repeats the check every 5 minutes for each signed-in person. Access counts for 15 minutes and fails closed after that. Access declared before the server started (by `setup`, imports or an earlier run) is ignored, and `npm start` stops renewing local declarations. A token GitHub rejects ends its session; a GitHub outage or rate limit records nothing, so access expires instead of being guessed. The GitHub token stays in server memory and is discarded at sign-out or restart.

An agent bound with `npm run setup` reads its bound repository only while its accountable owner is signed in and GitHub confirms the owner's access. Role assignments, organization membership and invitations are still managed in MemoryNet, not synchronized from GitHub organizations or teams. GitHub sign-in still serves only `localhost`; it is not a hosted multi-tenant identity service. Automated tests use a scripted GitHub; a live sign-in against github.com has not been recorded yet.
