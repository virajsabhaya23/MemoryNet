// Evaluator controls, not coding-agent outcomes. Requires the pinned fixture dependencies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const start = join(root, "scenario/start");
const run = (path, args = []) => spawnSync(process.execPath, [path, ...args], {
  encoding: "utf8", timeout: 120_000, maxBuffer: 2_000_000,
});
const sources = run(join(root, "scenario/verify-sources.mjs"));
assert.equal(sources.status, 0, sources.stderr);
await readFile(join(start, "node_modules/eslint/package.json"));
const directory = await mkdtemp(join(tmpdir(), "memorynet-eslint-controls-"));
const results = [];
try {
  await cp(start, directory, { recursive: true, filter: (path) => !path.includes("node_modules") });
  await symlink(join(start, "node_modules"), join(directory, "node_modules"), "junction");
  // The frozen consumer's lint script is POSIX (`ESLINT_USE_FLAT_CONFIG=false eslint src`).
  // cmd.exe cannot parse that form, so Windows runs the script's intent directly against the
  // same pinned binary and environment; npm itself needs a shell there for its .cmd shim.
  // Either way the start must fail because ESLint 10 refuses the retained eslintrc config,
  // not because a shell could not parse the script.
  const frozenLint = process.platform === "win32"
    ? spawnSync(process.execPath, [join(directory, "node_modules/eslint/bin/eslint.js"), "src"], {
        cwd: directory, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, ESLINT_USE_FLAT_CONFIG: "false" },
      })
    : spawnSync("npm", ["run", "lint"], { cwd: directory, encoding: "utf8", timeout: 30_000 });
  assert.equal(frozenLint.error, undefined);
  assert.equal(frozenLint.status, 2, `lint: ${frozenLint.stdout}\n${frozenLint.stderr}`);
  assert.match(
    `${frozenLint.stdout}\n${frozenLint.stderr}`,
    /couldn't find an eslint\.config/i,
    "the frozen consumer must fail because ESLint 10 requires flat configuration",
  );
  results.push({ name: "frozen npm run lint", exitCode: frozenLint.status, expectedExitCode: 2 });
  const frozenTest = spawnSync("npm", ["run", "test"], {
    cwd: directory, encoding: "utf8", timeout: 30_000, shell: process.platform === "win32",
  });
  assert.equal(frozenTest.error, undefined);
  assert.equal(frozenTest.status, 0, `test: ${frozenTest.stdout}\n${frozenTest.stderr}`);
  results.push({ name: "frozen npm run test", exitCode: frozenTest.status, expectedExitCode: 0 });
  const evaluate = (name, expected) => {
    const runResult = run(join(root, "scenario/oracle.mjs"), [directory]);
    assert.equal(runResult.error, undefined);
    const result = JSON.parse(runResult.stdout);
    assert.equal(result.outcome, expected, `${name}: ${result.reason ?? runResult.stderr}`);
    assert.equal(runResult.status, expected === "pass" ? 0 : 1);
    results.push({ name, outcome: result.outcome, expected, checks: result.checks.length });
  };
  evaluate("frozen obsolete configuration", "fail");
  const config = `export default [{ files: ["**/*.js"], languageOptions: { ecmaVersion: "latest", sourceType: "module" }, rules: { "no-undef": "error", "no-unused-vars": "error", eqeqeq: ["error", "always"] } }];\n`;
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  pkg.scripts.lint = "eslint src";
  await writeFile(join(directory, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  await rm(join(directory, ".eslintrc.cjs"));
  await writeFile(join(directory, "eslint.config.js"), config);
  evaluate("scripted positive control", "pass");
  await writeFile(join(directory, "eslint.config.js"), config.replace('eqeqeq: ["error", "always"]', 'eqeqeq: "off"'));
  evaluate("weakened policy control", "fail");
  await writeFile(join(directory, "eslint.config.js"), config);
  await writeFile(join(directory, "src/greet.js"), "export const greet = () => 'changed behavior';\n");
  evaluate("changed application control", "fail");
  console.log(JSON.stringify({ schemaVersion: 1, classification: "scripted evaluator controls; no agent or model ran", status: "pass", sources: JSON.parse(sources.stdout), results }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
