// Prints a decision-reuse summary from recorded answers and maintenance-effort CSV files.
// Usage: npm run experiment:summary -- answers.csv effort.csv [--expected-lookups 40]
// --expected-lookups is the team's estimate, recorded before the sessions, of how often such questions come up.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  formatSummary,
  parseCsv,
  readAnswers,
  readEffort,
  summarize,
} from "../experiment.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "expected-lookups": { type: "string" } },
});
const [answersFile, effortFile] = positionals;
const expected = values["expected-lookups"];
const expectedLookups = expected === undefined ? null : Number(expected);
if (
  answersFile === undefined ||
  effortFile === undefined ||
  positionals.length > 2 ||
  (expectedLookups !== null &&
    (!Number.isInteger(expectedLookups) || expectedLookups < 1))
) {
  console.error(
    "Usage: npm run experiment:summary -- answers.csv effort.csv [--expected-lookups N]",
  );
  process.exit(1);
}
try {
  const answers = readAnswers(
    parseCsv(await readFile(answersFile, "utf8")),
    answersFile,
  );
  const effort = readEffort(
    parseCsv(await readFile(effortFile, "utf8")),
    effortFile,
  );
  console.log(formatSummary(summarize(answers, effort, expectedLookups)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
