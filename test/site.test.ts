import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildWebsite, checkWebsite, createSitePreview } from "../src/site.ts";

test("website artifact contains only public assets and refuses broken links or linked runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorynet-site-"));
  try {
    await mkdir(join(root, "website"));
    await writeFile(join(root, ".env.local"), "private runtime configuration");
    await writeFile(join(root, "website/index.html"), '<link href="./style.css" rel="stylesheet"><a href="#setup">Setup</a><h2 id="setup">Local setup</h2><h2 id="workflow">Workflow</h2>');
    await writeFile(join(root, "website/guide.html"), '<a href="./">Home</a><a href="./#workflow">Workflow</a>');
    const styles = '@import "./tokens.css"; @import url("./base.css"); body { color: black; }';
    await writeFile(join(root, "website/style.css"), styles);
    await writeFile(join(root, "website/tokens.css"), ":root { --color: black; }");
    await writeFile(join(root, "website/base.css"), "body { margin: 0; }");
    await mkdir(join(root, "website/.hallmark"));
    await writeFile(join(root, "website/.hallmark/render.json"), '{"privateRendererMetadata":true}');
    const output = await buildWebsite(root);
    assert.deepEqual((await readdir(output)).sort(), [".nojekyll", "base.css", "guide.html", "index.html", "style.css", "tokens.css"]);
    assert.match(await readFile(join(output, "index.html"), "utf8"), /Local setup/);
    await writeFile(join(root, "website/style.css"), '@import "./missing.css";');
    await assert.rejects(checkWebsite(root), /Missing website link.*missing\.css/);
    await writeFile(join(root, "website/style.css"), '@import url("./missing.css");');
    await assert.rejects(checkWebsite(root), /Missing website link.*missing\.css/);
    await writeFile(join(root, "website/style.css"), styles);
    await rm(join(root, "website/guide.html"));
    await writeFile(join(root, "website/index.html"), '<a href="missing.html">Missing</a>');
    await assert.rejects(buildWebsite(root), /Missing website link/);
    assert.match(await readFile(join(output, "index.html"), "utf8"), /Local setup/, "invalid build preserves the prior artifact");
    await writeFile(join(root, "website/index.html"), '<a href="#missing">Missing anchor</a>');
    await assert.rejects(checkWebsite(root), /Missing website anchor/);
    await writeFile(join(root, "website/index.html"), '<a href="/index.html">Invalid project path</a>');
    await assert.rejects(checkWebsite(root), /project-relative/);
    await symlink("../.env.local", join(root, "website/config.txt"));
    await assert.rejects(checkWebsite(root), /refuses.*symlinks/);
    await rm(join(root, "website/config.txt"));
    await rm(join(root, "website/.hallmark"), { recursive: true });
    await symlink("..", join(root, "website/.hallmark"));
    await assert.rejects(checkWebsite(root), /refuses.*symlinks/);
    await rm(join(root, "website/.hallmark"));
    await writeFile(join(root, "website/.env.local"), "private");
    await assert.rejects(checkWebsite(root), /hidden files/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("static preview serves project-relative pages and cannot expose repository files", async () => {
  const server = createSitePreview(new Map([
    ["index.html", Buffer.from("public site")], ["styles.css", Buffer.from("body{}")],
  ]));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  function get(path: string, host = "localhost:4173", method = "GET") {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: host } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
        res.on("error", reject);
      });
      req.on("error", reject); req.end();
    });
  }
  try {
    assert.deepEqual(await get("/"), { status: 200, body: "public site" });
    assert.equal((await get("/MemoryNet")).status, 308);
    assert.deepEqual(await get("/MemoryNet/"), { status: 200, body: "public site" });
    assert.deepEqual(await get("/MemoryNet/styles.css"), { status: 200, body: "body{}" });
    assert.deepEqual(await get("/", "localhost:4173", "HEAD"), { status: 200, body: "" });
    assert.equal((await get("/../.env.local")).status, 404);
    assert.equal((await get("/src/web/server.ts")).status, 404);
    assert.equal((await get("/", "attacker.example")).status, 421);
    assert.equal((await get("/", "localhost:4173", "POST")).status, 405);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
