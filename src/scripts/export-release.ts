import { exportRelease } from "../release.ts";

try {
  const [destination, ...extra] = process.argv.slice(2);
  if (!destination || extra.length) throw new Error("Usage: npm run release:export -- <new-directory>");
  console.log(JSON.stringify(await exportRelease(process.cwd(), destination), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release export failed");
  process.exitCode = 1;
}
