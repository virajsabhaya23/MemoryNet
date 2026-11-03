// Downloads recent merged pull requests from public GitHub organizations into .data/public/, for local
// scale testing only. Read-only through the GitHub CLI's login; nothing is written to GitHub.
// Usage: npm run data:download -- [org-or-user ...] [--repos 30] [--prs 100] [--out .data/public/kubernetes.json]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  PUBLIC_DATA_FORMAT,
  scrubPublicText,
  type PublicDataset,
  type PublicRepository,
} from "../public-data.ts";

const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}
const orgs = args.filter(
  (arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"),
);
const organizations =
  orgs.length > 0 ? orgs : ["kubernetes", "kubernetes-sigs"];
const reposPerOrg = Number(option("--repos", "30"));
const prsPerRepo = Math.min(Number(option("--prs", "100")), 100);
const out = option("--out", ".data/public/kubernetes.json");

interface ApiRepository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  archived: boolean;
  fork: boolean;
  pushed_at: string;
  language?: string | null;
  topics?: string[];
}

interface ApiPullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merge_commit_sha: string | null;
  merged_at: string | null;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
}

function gh<T>(path: string): T {
  const text = execFileSync(
    "gh",
    ["api", "-H", "Accept: application/vnd.github+json", path],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GH_PAGER: "cat" },
    },
  );
  return JSON.parse(text) as T;
}

// Authors are kept only as a one-way key, so the file holds no GitHub user names.
function authorKey(login: string): string {
  return createHash("sha256")
    .update(`memorynet:${login}`)
    .digest("hex")
    .slice(0, 12);
}

const repositories: PublicRepository[] = [];
for (const org of organizations) {
  // An organization first; a personal account (such as your own) works too.
  let all: ApiRepository[];
  try {
    all = gh<ApiRepository[]>(
      `/orgs/${org}/repos?type=public&sort=pushed&direction=desc&per_page=100`,
    );
  } catch {
    all = gh<ApiRepository[]>(
      `/users/${org}/repos?type=owner&sort=pushed&direction=desc&per_page=100`,
    ).filter((repo) => !("private" in repo) || repo.private !== true);
  }
  const listed = all
    .filter((repo) => !repo.archived && !repo.fork)
    .slice(0, reposPerOrg);
  for (const repo of listed) {
    let pulls: ApiPullRequest[];
    try {
      pulls = gh<ApiPullRequest[]>(
        `/repos/${repo.full_name}/pulls?state=closed&sort=updated&direction=desc&per_page=${prsPerRepo}`,
      ).filter(
        (pull) => pull.merged_at !== null && pull.merge_commit_sha !== null,
      );
    } catch {
      console.log(
        `${repo.full_name}: skipped (its pull requests could not be read)`,
      );
      continue;
    }
    repositories.push({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description ?? "",
      url: repo.html_url,
      language: repo.language ?? null,
      topics: repo.topics ?? [],
      pullRequests: pulls.map((pull) => ({
        number: pull.number,
        title: scrubPublicText(pull.title).slice(0, 300),
        body: scrubPublicText(pull.body ?? "").slice(0, 4000),
        url: pull.html_url,
        mergeCommitSha: pull.merge_commit_sha ?? "",
        mergedAt: pull.merged_at ?? "",
        authorKey: authorKey(pull.user?.login ?? "unknown"),
        labels: pull.labels.map((label) => label.name),
      })),
    });
    console.log(`${repo.full_name}: ${pulls.length} merged pull requests`);
  }
}

const dataset: PublicDataset = {
  format: PUBLIC_DATA_FORMAT,
  version: 1,
  downloadedAt: new Date().toISOString(),
  organizations,
  repositories,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(dataset));
const total = repositories.reduce(
  (sum, repo) => sum + repo.pullRequests.length,
  0,
);
console.log(
  `Saved ${repositories.length} repositories and ${total} pull requests to ${out}`,
);
