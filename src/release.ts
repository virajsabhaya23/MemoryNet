import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ROOT_FILES = new Set([".env.example", ".gitignore", "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "tsconfig.json"]);
const PUBLIC_FOLDERS = new Set(["src", "test", "migrations", "docs", "examples", "website", ".github"]);
const credential = /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;

/** Export current bytes, including uncommitted features, without copying local state or Git history. */
export async function exportRelease(repository: string, output: string) {
  const root = await realpath(repository);
  const target = resolve(output);
  const targetRelative = relative(root, target);
  if (!targetRelative || (!isAbsolute(targetRelative) && !targetRelative.startsWith(`..${sep}`) && !targetRelative.startsWith(`.local${sep}`))) {
    throw new Error("Export outside the repository or below ignored .local/, to a new directory");
  }
  const paths = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { maxBuffer: 8_000_000 })
    .toString("utf8").split("\0").filter(Boolean);
  const ignoredTracked = new Set(execFileSync("git", ["-C", root, "ls-files", "--cached", "--ignored", "--exclude-standard", "-z"], { maxBuffer: 8_000_000 })
    .toString("utf8").split("\0").filter(Boolean));
  const files: { path: string; sha256: string; bytes: number; contents: Buffer }[] = [];
  for (const path of [...new Set(paths)].sort()) {
    if (ignoredTracked.has(path)) continue;
    if (!ROOT_FILES.has(path) && !PUBLIC_FOLDERS.has(path.split("/")[0]!)) continue;
    const parts = path.split("/");
    if (parts.some(p => p === ".." || p === "." || p === "" || p === "node_modules" || p === ".git" || p === "AGENTS.md" || p === "CLAUDE.md" || (p.startsWith(".env") && path !== ".env.example"))) {
      throw new Error(`Unexpected release path: ${path}`);
    }
    let current = root;
    let deleted = false;
    for (const part of parts) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error(`Release refuses symlinks: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        deleted = true; break;
      }
    }
    if (deleted) continue; // A tracked file deleted in the working tree is not part of the release.
    if (!(await lstat(current)).isFile()) throw new Error(`Release requires regular files: ${path}`);
    const contents = await readFile(current);
    if (credential.test(contents.toString("utf8"))) throw new Error(`Potential credential found in ${path}; review it before export`);
    files.push({ path, bytes: contents.length, sha256: createHash("sha256").update(contents).digest("hex"), contents });
  }
  for (const required of ["package.json", "package-lock.json", "src/web/server.ts", "README.md", "LICENSE"]) {
    if (!files.some(f => f.path === required)) throw new Error(`Missing release file: ${required}`);
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  try {
    for (const file of files) {
      const path = join(target, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents, { flag: "wx", mode: 0o644 });
    }
    const manifest = { format: "memorynet-release-v1", createdAt: new Date().toISOString(),
      credentialCheck: "Known credential patterns only; not a complete secret or history audit",
      files: files.map(({ contents, ...file }) => file) };
    await writeFile(join(target, "RELEASE-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    return { directory: target, files: files.length };
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
}
