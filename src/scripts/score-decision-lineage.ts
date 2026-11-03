import { readFile } from "node:fs/promises";
import { scoreRecordedRuns } from "../benchmark/score.ts";
import { ValidationError } from "../errors.ts";

const [planPath, runsPath, ...extra] = process.argv.slice(2);
if (!planPath || !runsPath || extra.length) {
  console.error("Usage: node src/scripts/score-decision-lineage.ts <frozen-plan.json> <recorded-runs.json>");
  process.exitCode = 2;
} else {
  try {
    const [plan, runs] = await Promise.all([readFile(planPath, "utf8"), readFile(runsPath, "utf8")]);
    if (plan.length > 2_000_000 || runs.length > 64_000_000) throw new ValidationError("Benchmark files exceed input limits");
    console.log(JSON.stringify(scoreRecordedRuns(JSON.parse(plan), JSON.parse(runs)), null, 2));
  } catch (error) {
    console.error(error instanceof ValidationError ? error.message : "Could not read valid benchmark input files");
    process.exitCode = 1;
  }
}
