import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, posix, resolve } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};
type SiteFiles = Map<string, Buffer>;

/** Read only the explicitly public website tree; never follow links to runtime data. */
export async function checkWebsite(repository: string): Promise<SiteFiles> {
  const source = join(resolve(repository), "website");
  if (!(await lstat(source)).isDirectory()) throw new Error("website/ must be a regular directory");
  const files: SiteFiles = new Map();
  async function visit(prefix: string): Promise<void> {
    for (const name of (await readdir(join(source, prefix))).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(join(source, path));
      // Local renderer metadata is never part of the published website. This
      // exception applies only to a real directory directly below website/.
      if (prefix === "" && name === ".hallmark" && info.isDirectory()) continue;
      if (name.startsWith(".") || info.isSymbolicLink()) throw new Error(`Website refuses hidden files and symlinks: ${path}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile() && TYPES[extname(path)]) files.set(path, await readFile(join(source, path)));
      else throw new Error(`Unsupported website asset: ${path}`);
    }
  }
  await visit("");
  if (!files.has("index.html")) throw new Error("Website requires index.html");
  const ids = new Map([...files].filter(([path]) => path.endsWith(".html")).map(([path, bytes]) =>
    [path, new Set([...bytes.toString().matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(match => match[1]!))]));
  for (const [path, bytes] of files) {
    const references = path.endsWith(".html")
      ? [...bytes.toString().matchAll(/\b(?:href|src|poster)\s*=\s*["']([^"']+)["']/g)].map(match => match[1]!)
      : path.endsWith(".css") ? [
        ...[...bytes.toString().matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map(match => match[1]!.trim()),
        ...[...bytes.toString().matchAll(/@import\s+["']([^"']+)["']/gi)].map(match => match[1]!),
      ] : [];
    for (const reference of references) {
      if (/^(https?:|mailto:|data:)/i.test(reference)) continue;
      if (reference.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(reference)) {
        throw new Error(`Use project-relative website links in ${path}: ${reference}`);
      }
      const url = new URL(reference.replaceAll("&amp;", "&"), `https://site.invalid/${path}`);
      const target = decodeURIComponent(url.pathname).slice(1);
      const file = target === "" || target.endsWith("/") ? `${target}index.html` : target;
      if (!files.has(file)) throw new Error(`Missing website link in ${path}: ${reference}`);
      if (url.hash && ids.has(file) && !ids.get(file)!.has(decodeURIComponent(url.hash.slice(1)))) {
        throw new Error(`Missing website anchor in ${path}: ${reference}`);
      }
      // A project site lives below /MemoryNet/, so ../ may not escape its root.
      const relative = reference.split(/[?#]/)[0]!;
      const resolved = posix.normalize(posix.join(posix.dirname(path), relative));
      if (resolved === ".." || resolved.startsWith("../")) {
        throw new Error(`Website link escapes its project root in ${path}: ${reference}`);
      }
    }
  }
  return files;
}

/** Build an isolated Pages artifact from website/ only, without an application backend. */
export async function buildWebsite(repository: string): Promise<string> {
  const root = resolve(repository);
  const files = await checkWebsite(root);
  const local = join(root, ".local");
  await mkdir(local, { recursive: true });
  if (!(await lstat(local)).isDirectory()) throw new Error(".local/ must be a regular directory");
  const target = join(local, "site");
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing && !existing.isDirectory()) throw new Error(".local/site must be a regular directory");
  const stage = await mkdtemp(join(local, "site-build-"));
  try {
    for (const [path, bytes] of files) {
      const output = join(stage, path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes, { flag: "wx" });
    }
    await writeFile(join(stage, ".nojekyll"), "");
    await rm(target, { recursive: true, force: true });
    await rename(stage, target);
    return target;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

/** Preview the validated static source in memory; requests can never read repository files. */
export function createSitePreview(files: SiteFiles, port = 4173) {
  return createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(request.headers.host ?? "")) {
      response.writeHead(421); response.end("Preview is available on loopback only."); return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
    }
    let path: string;
    try { path = decodeURIComponent(new URL(request.url ?? "/", `http://localhost:${port}`).pathname); }
    catch { response.writeHead(400); response.end(); return; }
    if (path === "/MemoryNet") { response.writeHead(308, { Location: "/MemoryNet/" }); response.end(); return; }
    if (path.startsWith("/MemoryNet/")) path = path.slice("/MemoryNet".length);
    if (path.endsWith("/")) path += "index.html";
    const body = files.get(path.slice(1));
    if (!body) { response.writeHead(404); response.end("Page not found."); return; }
    response.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", "Content-Length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
  });
}
