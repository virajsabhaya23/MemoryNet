import { runScopedContextSmoke } from "../evaluation/scoped-smoke.ts";

try { console.log(JSON.stringify(await runScopedContextSmoke(), null, 2)); }
catch { console.error("Scoped context engineering smoke failed. Run the focused integration tests for diagnostics."); process.exitCode = 1; }
