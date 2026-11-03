import { readFile } from "node:fs/promises";
import { reconcileWorkArtifacts } from "../work-git.ts";
const [repository, bundlePath] = process.argv.slice(2);
if (!repository || !bundlePath) {
  console.error("Usage: npm run work:reconcile -- REPOSITORY EXPORTED_BUNDLE.json");
  process.exitCode = 2;
} else {
  try {
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    const result = await reconcileWorkArtifacts(repository, bundle.work);
    console.log(JSON.stringify(result, null, 2));
    if (result.outcome !== "match") process.exitCode = 1;
  } catch {
    console.error("Artifact reconciliation failed: invalid bundle, unavailable commit or Git read failure.");
    process.exitCode = 2;
  }
}
