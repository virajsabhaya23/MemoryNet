// Loads a public pull request download into the local database as one large organization.
// Stop the app first: the embedded database allows one process at a time.
// Usage: npm run data:load -- [.data/public/kubernetes.json] [--copies 10]
// --copies repeats every repository under a new name, to test organizations many times larger.
import { readFileSync } from "node:fs";
import { createContext } from "../context.ts";
import { migrate, openDatabase } from "../db.ts";
import { loadPublicDataset, type PublicDataset } from "../public-data.ts";

const args = process.argv.slice(2);
const copiesAt = args.indexOf("--copies");
const copies = copiesAt >= 0 ? Math.max(1, Number(args[copiesAt + 1] ?? 1)) : 1;
const file =
  args.find(
    (arg, at) => !arg.startsWith("--") && args[at - 1] !== "--copies",
  ) ?? ".data/public/kubernetes.json";
const dataDir = process.env.MEMORYNET_DATA_DIR ?? ".data/memorynet";
const original = JSON.parse(readFileSync(file, "utf8")) as PublicDataset;
const dataset: PublicDataset =
  copies === 1
    ? original
    : {
        ...original,
        repositories: Array.from({ length: copies }, (_, copy) =>
          original.repositories.map((repository) => ({
            ...repository,
            id: repository.id * 100 + copy,
            name: `${repository.name}-${copy + 1}`,
            fullName: `${repository.fullName}-${copy + 1}`,
          })),
        ).flat(),
      };
const db = await openDatabase(dataDir);
await migrate(db);
const started = Date.now();
try {
  const summary = await loadPublicDataset(
    createContext(db, { repositoryAccessMaxAgeMs: 30 * 24 * 60 * 60 * 1000 }),
    dataset,
    copies === 1
      ? {}
      : {
          slug: `public-x${copies}`,
          name: `Public data, ${copies} times larger`,
        },
  );
  await db.exec("ANALYZE");
  console.log(
    `Loaded ${file} into ${dataDir} in ${Math.round((Date.now() - started) / 1000)}s:`,
    summary,
  );
} finally {
  await db.close();
}
