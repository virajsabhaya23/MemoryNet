import { collectCodingContext, startCodingDemo, verifyCodingArtifact } from "../evaluation/coding-demo.ts";

const [action, input, output] = process.argv.slice(2);
try {
  if (action === "serve" && input && !output) {
    const demo = await startCodingDemo(input);
    console.log(JSON.stringify({ ready: true, evidenceKind: "synthetic_coding_agent_engineering_demo", metaCalls: 0,
      connectionFile: demo.connectionFile, folder: demo.folder }));
    let closing = false;
    async function shutdown() { if (closing) return; closing = true; await demo.saveReceipts(); await demo.close(); }
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  } else if (action === "context" && input && output) {
    console.log(JSON.stringify(await collectCodingContext(input, output), null, 2));
  } else if (action === "verify" && input && output) {
    const result = await verifyCodingArtifact(input, output);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } else { throw new Error("Usage: coding-demo.ts serve NEW_DIRECTORY | context CONNECTION_JSON NEW_OUTPUT_JSON | verify DIRECTORY baseline|memorynet|repo-instructions|dated-sources|repo-memorynet|maintained-instructions"); }
} catch (error) { console.error(error instanceof Error ? error.message : "Coding demo failed"); process.exitCode = 1; }
