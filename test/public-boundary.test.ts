import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const isCheckout = existsSync(join(ROOT, ".git"));
const git = (args: string[], input?: string) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", input, maxBuffer: 16_000_000 });

/** Markdown and HTML that a public release would contain: tracked or new files that are not ignored. */
async function publicDocuments(): Promise<string[]> {
  // Source distributions deliberately omit Git metadata. Check their actual public documents.
  if (!isCheckout) {
    const entries = await readdir(ROOT, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(/[/\\]/).join("/"))
      .filter((path) => /\.(md|html)$/.test(path) && !path.split("/").some((part) => part === "node_modules" || part.startsWith(".")));
  }
  return git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0")
    .filter((path) => /\.(md|html)$/.test(path) && !path.startsWith("node_modules/"))
    .filter((path) => !git(["ls-files", "--cached", "--ignored", "--exclude-standard", "-z", "--", path]).includes(path));
}

function linkTargets(text: string): string[] {
  const targets = [...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g), ...text.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]!);
  return targets.filter((target) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)).map((target) => decodeURIComponent(target.split("#")[0]!.split("?")[0]!)).filter(Boolean);
}

test("the private planning area stays ignored by Git", { skip: !isCheckout && "source distributions have no Git metadata" }, () => {
  for (const path of [".local/planning/hosted-strategy.md", ".local/memorynet/workspace.json", ".data/workspace/PG_VERSION", ".env.local", ".claude/settings.local.json", "research/notes.md", "docs/lab-notes/run.md", "docs/proof/run.json", "transfer-staging/source.ts", "AGENTS.md"]) {
    assert.doesNotThrow(() => git(["check-ignore", "-q", path]), `${path} must be ignored`);
  }
});

test("published documents never link to ignored files or mention the private plans", async () => {
  const problems: string[] = [];
  const targets = new Map<string, string>();
  for (const path of await publicDocuments()) {
    const text = await readFile(join(ROOT, path), "utf8");
    if (/\.local\/planning/.test(text)) problems.push(`${path} mentions the private planning folder`);
    for (const target of linkTargets(text)) {
      const resolved = normalize(join(dirname(path), target));
      if (resolved.startsWith("..") || relative(ROOT, join(ROOT, resolved)).startsWith("..")) continue;
      targets.set(resolved, path);
      // Upstream ESLint snapshots retain original relative links and hashes.
      if (!path.startsWith("examples/eslint-demo/sources/eslint-") && !existsSync(join(ROOT, resolved))) {
        problems.push(`${path} links to missing ${resolved}`);
      }
    }
  }
  const ignored = !isCheckout || targets.size === 0 ? "" : (() => {
    try { return git(["check-ignore", "--stdin", "-z"], [...targets.keys()].join("\0")); } catch { return ""; }
  })();
  for (const target of ignored.split("\0").filter(Boolean)) problems.push(`${targets.get(target)} links to ignored ${target}`);
  assert.deepEqual(problems, []);
});
