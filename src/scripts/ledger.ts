// Operator check of the tamper-evident ledger. Stop the app first: one process owns the database.
import { openDatabase } from "../db.ts";
import { formatCheckpoint, ledgerCheckpoints, parseCheckpoint, verifyLedger } from "../ledger.ts";
import { workspaceDataDir } from "../workspace.ts";

const [command, ...rest] = process.argv.slice(2);
const json = rest.includes("--json");
const args = rest.filter((arg) => arg !== "--json");
if (command !== "verify" && command !== "checkpoint") {
  console.error("Usage: npm run ledger:verify -- [--json] [mnl1.<chain>.<seq>.<hash> ...] | npm run ledger:checkpoint");
  process.exitCode = 2;
} else {
  const dataDir = await workspaceDataDir();
  const db = await openDatabase(dataDir).catch((error: unknown) => {
    console.error(`Could not open ${dataDir}: ${error instanceof Error ? error.message : "unknown error"}. Stop the app first; one process owns the database.`);
    process.exit(1);
  });
  try {
    const ready = (await db.query<{ ready: boolean }>("SELECT to_regclass('ledger_entries') IS NOT NULL AS ready")).rows[0]?.ready;
    if (!ready) throw new Error("This database predates the ledger. Start the app once (or run npm run db:migrate) to upgrade it.");
    const names = new Map((await db.query<{ id: string; name: string }>("SELECT id, name FROM organizations")).rows.map((row) => [row.id, row.name]));
    const label = (chainId: string) => names.get(chainId) ?? (chainId === "00000000-0000-0000-0000-000000000000" ? "system events" : "unknown chain");
    if (command === "checkpoint") {
      for (const head of await ledgerCheckpoints(db)) console.log(`${formatCheckpoint(head)}  # ${label(head.chainId)}, ${head.seq} entries`);
      console.error("Store these lines outside this computer (ticket, commit, signed message). A later verify with them proves earlier history was not rewritten.");
    } else {
      const report = await verifyLedger(db, { checkpoints: args.map(parseCheckpoint) });
      if (json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const chain of report.chains) {
          console.log(`${chain.ok ? "OK  " : "FAIL"} ${label(chain.chainId)}: ${chain.entries} entries, head ${chain.head.seq}`);
          for (const problem of chain.problems) console.log(`     ${problem}`);
        }
        for (const problem of report.problems) console.log(`FAIL ${problem}`);
        console.log(report.ok ? "Ledger verified." : "Ledger verification failed. Treat affected history as untrusted and restore from a verified backup.");
      }
      if (!report.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Ledger check failed");
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
