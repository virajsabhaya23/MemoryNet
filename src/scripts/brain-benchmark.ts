import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderBrainBenchmarkMarkdown, runBrainBenchmark } from "../evaluation/brain-benchmark.ts";

let output: string | null = null;
try {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  output = values.out === undefined ? fileURLToPath(new URL("../../.local/brain-benchmark/", import.meta.url)) : resolve(values.out);
} catch {
  console.error("Usage: npm run eval:brain [-- --out DIRECTORY]");
  process.exitCode = 1;
}
if (output !== null) {
  try {
    const report = await runBrainBenchmark();
    const summary = renderBrainBenchmarkMarkdown(report);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(output, "summary.md"), summary);
    console.log(`${summary.split("\n## Per task")[0]!.trimEnd()}\n\nSummary: ${join(output, "summary.md")}\nReport: ${join(output, "report.json")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Brain benchmark failed");
    process.exitCode = 1;
  }
}
