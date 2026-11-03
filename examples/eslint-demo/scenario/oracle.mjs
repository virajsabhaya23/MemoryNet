// Frozen evaluator outside coding-agent task directories. Executes real pinned ESLint.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const directory = resolve(process.argv[2] ?? fileURLToPath(new URL("./start/", import.meta.url)));
const started = new Date().toISOString();
const checks = [];
const eslintCli = join(directory, "node_modules/eslint/bin/eslint.js");
const environment = { ...process.env, NO_COLOR: "1" };
delete environment.ESLINT_USE_FLAT_CONFIG;
delete environment.ESLINT_FLAGS;
const execute = (command, args, input, extraEnv = {}) => {
  const result = spawnSync(command, args, {
    cwd: directory, env: { ...environment, ...extraEnv }, input,
    encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000
  });
  return { command: [command, ...args], exitCode: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null };
};
try {
  const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const frozen = fileURLToPath(new URL("./start/", import.meta.url));
  for (const file of ["src/greet.js", "test/greet.test.js", "package-lock.json"]) {
    const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(digest(join(directory, file)), digest(join(frozen, file)), `preserve frozen ${file}`);
  }
  assert.equal(packageJson.devDependencies?.eslint, "10.0.0", "preserve exact ESLint pin");
  const installed = JSON.parse(readFileSync(join(directory, "node_modules/eslint/package.json"), "utf8"));
  assert.equal(installed.version, "10.0.0", "execute actual ESLint 10.0.0");
  assert(!/ESLINT_USE_FLAT_CONFIG|--no-eslintrc|--no-config-lookup/.test(packageJson.scripts?.lint ?? ""), "remove obsolete switches without disabling lookup");
  for (const script of ["lint", "test"]) {
    const result = execute("npm", ["run", script]);
    checks.push({ name: `npm run ${script}`, ...result });
    assert.equal(result.exitCode, 0, `${script} must succeed`);
  }
  // Run the actual protected application test even if an agent rewrites npm scripts.
  const applicationTest = execute(process.execPath, ["--test", "test/greet.test.js"]);
  checks.push({ name: "protected application test", ...applicationTest });
  assert.equal(applicationTest.exitCode, 0, "protected application test must succeed");
  const probes = [
    { name: "valid module", code: "export const double = value => value * 2;\n", rule: null },
    { name: "undefined variable rejected", code: "export const value = unknownValue;\n", rule: "no-undef" },
    { name: "unused variable rejected", code: "const unused = 1;\nexport const value = 2;\n", rule: "no-unused-vars" },
    { name: "loose equality rejected", code: "export const equal = (a, b) => a == b;\n", rule: "eqeqeq" }
  ];
  for (const probe of probes) {
    const result = execute(process.execPath, [eslintCli, "--stdin", "--stdin-filename", "src/oracle-probe.js", "--format", "json"], probe.code);
    checks.push({ name: probe.name, ...result });
    const reports = JSON.parse(result.stdout);
    if (probe.rule === null) {
      assert.equal(result.exitCode, 0, "valid input passes");
      assert.equal(reports[0]?.errorCount, 0);
    } else {
      assert.equal(result.exitCode, 1, `${probe.rule} must cause lint failure`);
      assert(reports[0]?.messages.some(message => message.ruleId === probe.rule && message.severity === 2), `${probe.rule} must remain an error`);
    }
  }
  // v10 must behave correctly even if a user's environment retains the old v9 switch.
  const ignoredLegacySwitch = execute(process.execPath, [eslintCli, "src", "--format", "json"], undefined, { ESLINT_USE_FLAT_CONFIG: "false" });
  checks.push({ name: "v10 ignores legacy environment switch", ...ignoredLegacySwitch });
  assert.equal(ignoredLegacySwitch.exitCode, 0);
  console.log(JSON.stringify({ schemaVersion: 1, started, finished: new Date().toISOString(), directory, eslintVersion: installed.version, outcome: "pass", checks }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: 1, started, finished: new Date().toISOString(), directory, outcome: "fail", reason: error.message, checks }, null, 2));
  process.exitCode = 1;
}
