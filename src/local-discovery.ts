// Read a stable, operator-selected public/synthetic checkout. Never run Git in the discovered worktree.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, opendir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { requireDecisionBranch } from "./knowledge.ts";
import { LOCAL_DOCUMENT } from "./repository-identity.ts";
import { requireNoSecrets } from "./content-checks.ts";

const exec = promisify(execFile);
const excluded = new Set(["node_modules", "vendor", "build", "dist", "target", "coverage", "out", "venv", "__pycache__", "secrets", "credentials", "keystore", "vault", "ssh", "private"]);
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const safeName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(name);
const documentLimit = 64 * 1024;

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  if (await realpath(path) !== path) throw new Error("Linked Git metadata is unsupported");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error("Unsupported Git metadata type or size");
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error("Git metadata changed during preview");
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export interface LocalRepository {
  project: string; id: string; branch: string; commit: string; origin: string | null; documents: string[];
}

async function withGit<T>(fn: (git: (args: string[], objects?: string) => Promise<Buffer>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "memorynet-plumbing-"));
  // Ignore inherited Git settings, credential helpers, replace refs, templates, system and user config.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: dir, XDG_CONFIG_HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
  async function run(args: string[], objects?: string) {
    try {
      return (await exec("git", ["--no-replace-objects", "-c", "core.commitGraph=false", ...args], {
        cwd: dir, env: { ...env, ...(objects ? { GIT_DIR: dir, GIT_OBJECT_DIRECTORY: objects } : {}) },
        encoding: "buffer", maxBuffer: 256 * 1024, timeout: 4000,
      })).stdout;
    } catch { throw new Error("Unsupported, missing or oversized Git object"); }
  }
  try { await run(["init", "--quiet", "--bare", "--template=", "--object-format=sha1", "."]); return await fn(run); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

// Git may follow alternates and pack/loose-object symlinks even for read-only plumbing.
// Inspect directory entry types only. Git will see this object store through a fresh configuration.
async function checkObjectStore(objects: string, budget: { remaining: number }) {
  if (await realpath(objects) !== objects) throw new Error("Linked object stores are unsupported");
  async function walk(path: string, depth: number) {
    for await (const entry of await opendir(path)) {
      if (--budget.remaining < 0) throw new Error("Git object entry budget exceeded");
      if (entry.isDirectory() && depth === 0 && /^(?:[a-f0-9]{2}|info|pack)$/.test(entry.name)) {
        await walk(join(path, entry.name), 1);
      } else if (!entry.isFile() || depth !== 1 || ["alternates", "http-alternates"].includes(entry.name)) {
        throw new Error("Linked, alternate or unsupported Git object storage");
      }
    }
  }
  await walk(objects, 0);
}

type Git = (args: string[], objects?: string) => Promise<Buffer>;
async function inspect(path: string, project: string, git: Git, budget: { remaining: number }) {
  const meta = join(path, ".git");
  if (!(await lstat(meta)).isDirectory() || await realpath(meta) !== meta) throw new Error("Linked worktrees and submodules are unsupported");
  const head = (await boundedFile(join(meta, "HEAD"), 512)).toString().trim();
  if (!head.startsWith("ref: refs/heads/")) throw new Error("Select a named branch with a commit");
  const branch = requireDecisionBranch(head.slice(16));
  const ref = `refs/heads/${branch}`;
  let commit: string | undefined;
  try { commit = (await boundedFile(join(meta, ref), 128)).toString().trim(); }
  catch (e) {
    if (!absent(e)) throw e;
    const lines = (await boundedFile(join(meta, "packed-refs"), 256 * 1024)).toString().split("\n");
    commit = lines.find(line => line.endsWith(" " + ref))?.split(" ")[0];
  }
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("An exact SHA-1 commit is required");
  const objects = join(meta, "objects");
  await checkObjectStore(objects, budget);
  if ((await git(["cat-file", "-t", commit], objects)).toString().trim() !== "commit") throw new Error("HEAD is not a commit");
  const docs: string[] = [];
  async function tree(oid: string, prefix: string) {
    for (const record of (await git(["ls-tree", "-z", oid], objects)).toString().split("\0")) {
      if (!record) continue;
      if (--budget.remaining < 0) throw new Error("Git tree entry budget exceeded");
      const m = /^(\d+) (tree|blob) ([a-f0-9]{40})\t([^\t\n]+)$/.exec(record);
      if (!m) continue;
      const name = prefix + m[4]!;
      if (m[2] === "tree" && /^(?:docs|docs\/(adr|decisions|specs))$/.test(name)) await tree(m[3]!, name + "/");
      else if (/^100(644|755)$/.test(m[1]!) && LOCAL_DOCUMENT.test(name)) docs.push(name);
      if (docs.length > 64) throw new Error("Document preview limit exceeded");
    }
  }
  await tree(commit, "");
  // Extract only the origin URL from the bounded local config as data. Never load config/includes into Git.
  const config = (await boundedFile(join(meta, "config"), 64 * 1024)).toString();
  let inOrigin = false, origin: string | null = null;
  for (const line of config.split(/\r?\n/)) {
    if (line.trimStart().startsWith("[")) inOrigin = /^\s*\[remote "origin"\]\s*$/.test(line);
    else if (inOrigin && /^\s*url\s*=/i.test(line)) {
      const raw = line.slice(line.indexOf("=") + 1).trim();
      // Only expose a plain host, never remote credentials, local paths, query strings or tokens.
      origin = "configured";
      try { const url = new URL(raw); if (/^(?:https?:|ssh:)$/.test(url.protocol)) origin = url.hostname; } catch {}
    }
  }
  const info = await lstat(meta, { bigint: true });
  const id = "local-" + hash(`${path}\0${info.dev}\0${info.ino}\0${info.birthtimeNs}`).slice(0, 32);
  return { project, id, branch, commit, origin, documents: docs.sort() };
}

async function canonicalDirectory(path: string) {
  if (!(await lstat(resolve(path))).isDirectory()) throw new Error("Select a directory directly, without a symlink");
  return realpath(resolve(path));
}

export async function previewWorkspace(root: string) {
  const base = await canonicalDirectory(root);
  const repositories: LocalRepository[] = [], unsupported: { project: string; reason: string }[] = [];
  let entries = 0, candidates = 0;
  const budget = { remaining: 20000 };
  return withGit(async git => {
    async function visit(path: string, depth: number) {
      const project = relative(base, path).split(/[\\/]/).join("/") || ".";
      const marker = await lstat(join(path, ".git")).catch(e => { if (!absent(e)) throw e; return null; });
      if (marker) {
        if (++candidates > 32) throw new Error("More than 32 checkouts. Select a smaller root.");
        try { repositories.push(await inspect(path, project, git, budget)); }
        catch (e) { unsupported.push({ project, reason: (e as NodeJS.ErrnoException).code ? "Missing or inaccessible Git metadata" : (e as Error).message }); }
        return;
      }
      // A bare repository has no selectable worktree. Do not walk its object store.
      if (await lstat(join(path, "HEAD")).catch(e => { if (!absent(e)) throw e; return null; }) &&
          await lstat(join(path, "objects")).catch(e => { if (!absent(e)) throw e; return null; })) {
        unsupported.push({ project, reason: "Bare repositories are unsupported" }); return;
      }
      if (depth === 3) return;
      for await (const entry of await opendir(path)) {
        if (++entries > 4096) throw new Error("More than 4096 entries. Select a smaller root.");
        if (entry.isDirectory() && safeName(entry.name) && !excluded.has(entry.name.toLowerCase())) await visit(join(path, entry.name), depth + 1);
      }
    }
    await visit(base, 0);
    return { repositories: repositories.sort((a, b) => a.project.localeCompare(b.project)), unsupported };
  });
}

export async function selectedCheckout(root: string, project: string, document?: string) {
  const base = await canonicalDirectory(root);
  const parts = project === "." ? [] : project.split("/");
  if (parts.length > 3 || parts.some(p => !safeName(p) || excluded.has(p.toLowerCase()))) throw new Error("Choose a project from preview");
  const path = join(base, ...parts);
  if (await realpath(path) !== path) throw new Error("Linked checkouts are unsupported");
  // A selection cannot enter a nested checkout that preview would have stopped before.
  for (let i = 0; i < parts.length; i++) {
    if (await lstat(join(base, ...parts.slice(0, i), ".git")).catch(e => { if (!absent(e)) throw e; return null; })) throw new Error("Nested selection is unsupported");
  }
  return withGit(async git => {
    const repository = await inspect(path, project, git, { remaining: 20000 });
    if (!document) return { repository, evidence: null };
    if (!repository.documents.includes(document)) throw new Error("Choose a committed document from preview");
    const object = `${repository.commit}:${document}`, objects = join(path, ".git", "objects");
    const size = Number((await git(["cat-file", "-s", object], objects)).toString().trim());
    if (!Number.isSafeInteger(size) || size < 1 || size > documentLimit) throw new Error("Document exceeds the 64 KiB limit or is empty");
    const bytes = await git(["cat-file", "blob", object], objects);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new Error("Binary documents are unsupported");
    requireNoSecrets(content, "Document");
    const sha256 = hash(bytes);
    return { repository, evidence: { reference: document, sha256, excerpt: content.slice(0, 4000),
      url: `memorynet-local://${repository.id}/${repository.commit}/${document}#sha256=${sha256}` } };
  });
}
