import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDecisionDemo } from "../evaluation/decision-demo.ts";
import { renderDecisionDemo } from "../evaluation/decision-demo-page.ts";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--website")) {
  console.error("Usage: npm run demo [-- --website]");
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  console.log("Running an isolated decision-change demo: scripted extraction, fixture approvals, real MCP and database checks.");
  const report = await runDecisionDemo();
  const output = join(root, ".local", "decision-demo");
  await mkdir(output, { recursive: true });
  const json = JSON.stringify(report, null, 2) + "\n";
  await writeFile(join(output, "report.json"), json);
  // Self-contained local replay uses the same public styles as the website.
  const styles = await Promise.all(["tokens.css", "base.css", "styles.css", "demo.css"].map(name => readFile(join(root, "website/assets", name), "utf8")));
  const standalone = renderDecisionDemo(report)
    .replace(/<link[^>]+>/g, "")
    .replace("</head>", `<style>${styles.join("\n").replace(/@import[^;]+;/g, "").replace(/@font-face\s*\{[^}]*\}/g, "")}</style></head>`)
    .replace(/<header[\s\S]*?<\/header>/, "")
    .replace(/<footer[\s\S]*?<\/footer>/, "")
    .replaceAll('href="./demo-report.json"', 'href="./report.json"')
    .replace('<a href="./guide.html#limits">Deployment boundaries</a>', "Local public or synthetic evidence only.");
  await writeFile(join(output, "index.html"), standalone);
  if (args[0] === "--website") {
    await writeFile(join(root, "website/demo-report.json"), json);
    await writeFile(join(root, "website/demo.html"), renderDecisionDemo(report));
  }
  console.log(`PASS: exact quote → pending withheld → approval → MCP receipt → replacement → stale export blocked → fresh context.\nRead-only walkthrough: ${join(output, "index.html")}\nRun evidence: ${join(output, "report.json")}`);
}
