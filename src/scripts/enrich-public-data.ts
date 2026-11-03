// Adds each repository's language and topics to a public pull request download made before the
// download script saved them. Read-only through the GitHub CLI's login; nothing is written to GitHub.
// Usage: node src/scripts/enrich-public-data.ts .data/public/vercel.json
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { PUBLIC_DATA_FORMAT, type PublicDataset } from "../public-data.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node src/scripts/enrich-public-data.ts <dataset.json>");
  process.exit(1);
}

interface ApiRepository {
  language: string | null;
  topics?: string[];
}

function gh<T>(path: string): T {
  const text = execFileSync(
    "gh",
    ["api", "-H", "Accept: application/vnd.github+json", path],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GH_PAGER: "cat" },
    },
  );
  return JSON.parse(text) as T;
}

const dataset = JSON.parse(readFileSync(file, "utf8")) as PublicDataset;
if (dataset.format !== PUBLIC_DATA_FORMAT || dataset.version !== 1) {
  console.error(`${file} is not a MemoryNet public pull request download`);
  process.exit(1);
}
for (const repository of dataset.repositories) {
  try {
    const repo = gh<ApiRepository>(`/repos/${repository.fullName}`);
    repository.language = repo.language ?? null;
    repository.topics = repo.topics ?? [];
    console.log(
      `${repository.fullName}: ${repository.language ?? "no language"}; ${repository.topics.length} topics`,
    );
  } catch {
    console.log(`${repository.fullName}: skipped (could not be read)`);
  }
}
writeFileSync(file, JSON.stringify(dataset));
console.log(`Saved ${dataset.repositories.length} repositories to ${file}`);
