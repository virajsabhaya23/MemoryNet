import { buildWebsite, checkWebsite, createSitePreview } from "../site.ts";

const root = process.cwd();
const action = process.argv[2];
try {
  if (action === "check") {
    const files = await checkWebsite(root);
    console.log(`Website checked: ${files.size} public files; local links and anchors resolve.`);
  } else if (action === "build" || action === "serve") {
    const output = await buildWebsite(root);
    console.log(`Static website built: ${output}`);
    if (action === "serve") {
      const port = 4173;
      const server = createSitePreview(await checkWebsite(root), port);
      server.on("error", (error: NodeJS.ErrnoException) => {
        console.error(error.code === "EADDRINUSE" ? `Port ${port} is already in use.` : error.message);
        process.exitCode = 1;
      });
      const close = () => { server.close(); server.closeAllConnections(); };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      server.listen(port, "127.0.0.1", () => console.log(`Website preview: http://127.0.0.1:${port} (also /MemoryNet/). Press Ctrl+C to stop.`));
    }
  } else throw new Error("Usage: node src/scripts/site.ts check|build|serve");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
