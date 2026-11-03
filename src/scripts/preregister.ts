import { freezePreregistration } from "../evaluation/preregistration.ts";

const [manifest, repository, output, ...extra] = process.argv.slice(2);
if (!manifest || !repository || !output || extra.length) {
  console.error("Usage: npm run eval:preregister -- <manifest.json> <clean-repository> <new-lock.json>");
  process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(await freezePreregistration(manifest, repository, output), null, 2));
  } catch {
    console.error("Registration failed: check the manifest schema, clean repository HEAD/origin, artifact paths and hashes, and unused output filename. No agents were run.");
    process.exitCode = 1;
  }
}
