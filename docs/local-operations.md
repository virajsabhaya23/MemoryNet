# Local operations

This build is for local use with public or synthetic data. Configured workspaces can open as one local operator without sign-in; this is not shared authentication. The sandbox identity picker is not authentication. Optional access-key mode binds one operator to a configured principal. Optional [GitHub sign-in](prototype.md#github-sign-in) verifies linked accounts and refreshes repository access; it does not provide hosted membership or delegation. Keep the app and demo on loopback. See [security boundaries](../SECURITY.md).

Start with the [README](../README.md) for setup or [the public repository guide](public-evidence-workspace.md) for an isolated import.

## Configuration

`npm run app`, `npm start`, and `npm run github:link` load `.env.local` if present. The optional variables and defaults are in [`.env.example`](../.env.example). Other scripts require exported environment variables and do not load that file automatically.

`MEMORYNET_AUTH_MODE=sandbox MEMORYNET_PROTOTYPE_CONFIG=off` explicitly selects the sandbox and disables prepared data selection. Otherwise the app uses the config path in that variable, or auto-selects `.local/prototype/config.json` if it exists. A configuration's `dataDir` overrides `MEMORYNET_DATA_DIR`; without one, `MEMORYNET_DATA_DIR`, a setup workspace profile, or `.data/memorynet` selects the database in that order. Access-key mode requires an existing matching human principal, owner-only configuration/key files and a validated source-checkout catalog. There is no turnkey provisioning command; a fresh checkout uses the sandbox.

Backup/reset/import CLI scripts do **not** read prototype configuration. Set the actual `MEMORYNET_DATA_DIR` explicitly before those operations. To run a restored database in a checkout with an optional prototype config, include `MEMORYNET_PROTOTYPE_CONFIG=off` at app startup.

## Stop, back up, and upgrade

1. Stop the app and demo with Ctrl+C. Wait for their processes to exit; active requests finish before storage closes.
2. Back up the configured app database into a **new** directory:

   ```sh
   MEMORYNET_DATA_DIR=.data/personal-trial npm run db:backup -- .local/backups/before-upgrade
   ```

   Replace `.data/personal-trial` with the database you actually intend to preserve; use an absolute path when running outside the checkout. CLI scripts do not load `.env.local` automatically.
3. Keep that backup and the matching `package-lock.json` in private storage. The snapshot contains all records, evidence, identities, reviews and receipts. It is not encrypted. New backup directories are owner-only on Unix; protect them with OS account permissions and disk encryption as appropriate.
4. Install the new checkout with `npm ci --ignore-scripts`, run `npm run check`, then start the app. Before applying pending migrations to an existing database, startup takes a verified backup in an adjacent `<database>.backups/` directory. `MEMORYNET_UPGRADE_BACKUP=off` opts out. Keep the original version and a separate backup until the upgrade and data are checked.

Backup takes an exclusive database lock, copies the stopped database, and verifies every file against a SHA-256 inventory. A manifest detects accidental corruption; it does not authenticate a snapshot obtained from someone else. The JSON record export is not a replacement for this whole-database backup.

## Restore and check recovery

Restore using the same pinned PGlite version that produced the snapshot, into a new path:

```sh
npm run db:restore -- .local/backups/before-upgrade .data/recovered
MEMORYNET_PROTOTYPE_CONFIG=off MEMORYNET_DATA_DIR=.data/recovered npm run app
```

Restore validates the entire inventory before copying and verifies the restored files afterward. Missing, changed, extra, symlinked or path-traversing files are rejected. Existing destinations are refused. Open the recovered app and check expected organizations, approved decisions, evidence, pending reviews and retrieval history before switching your normal data directory. Keep the original database until that check succeeds. A newer application can migrate a restored copy afterward; downgrade compatibility is not promised.

## Locked database or interrupted process

Every app/CLI using `openDatabase` takes an adjacent `<database>.memorynet-lock/` directory. Concurrent app, migration, loading, backup and reset attempts fail rather than sharing the database. Normal close releases the lock.

After a crash or forced kill, startup reclaims a lock only when its owner is provably stopped on this same computer, rechecking ownership under a recovery guard. Live, foreign-host, unreadable, and ambiguous locks are refused. If manual recovery is necessary, inspect `owner.json` and verify every process using the database has stopped before removing **only that named lock directory**. Never remove a live lock. Old MemoryNet versions and external tools do not use this lock; keep them stopped too.

## Reset

`MEMORYNET_DATA_DIR=.data/personal-trial npm run app:reset` permanently deletes that explicitly selected database, and only accepts an actual PostgreSQL directory below `.data/`. It rejects active ownership, symlink escapes, parent folders, and nested databases. Back up anything needed first. Reset is whole-database disposal, not record-level deletion or a retention policy.

## Prepare a source distribution

```sh
npm run release:export -- .local/releases/candidate-001
```

This exports the current working bytes of public source, tests, migrations, examples and reviewed documentation, including newly added uncommitted files. Git ignore rules and a public-path allowlist omit local data, credentials, development artifacts and Git history. Each distribution gets a generated `RELEASE-MANIFEST.json` listing SHA-256 hashes; keep it out of the source commit and regenerate it with each export. The destination must be new; no commit, push, publication or repository visibility change occurs.

The exporter rejects symlinks and several known credential formats. This is a limited check, not a complete secret scan. Review the exported inventory before sharing. Making an existing repository public also exposes its history, which requires a separate review.

Check the exact exported tree with `npm ci --ignore-scripts`, `npm run check`, `npm run eval:smoke`, and the [ESLint example verification](../examples/eslint-demo/README.md). Keep backups and bindings in private storage. Personal notes and internal execution evidence belong outside the public checkout.
