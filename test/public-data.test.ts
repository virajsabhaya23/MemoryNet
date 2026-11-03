import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictError, ValidationError } from "../src/index.ts";
import {
  groupOf,
  loadPublicDataset,
  memoryTitleOf,
  memoryTypeOf,
  PUBLIC_DATA_FORMAT,
  scrubPublicText,
  summaryOf,
  type PublicDataset,
  type PublicPullRequest,
  type PublicRepository,
} from "../src/public-data.ts";
import { useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();

function pull(number: number, labels: string[], body = "", repository = "tool"): PublicPullRequest {
  return {
    number,
    title: `Synthetic change number ${number}`,
    body,
    url: `https://github.com/example-synthetic/${repository}/pull/${number}`,
    mergeCommitSha: number.toString(16).padStart(40, "a"),
    mergedAt: "2026-10-01T12:00:00Z",
    authorKey: `author-${number % 3}`,
    labels,
  };
}

function dataset(): PublicDataset {
  return {
    format: PUBLIC_DATA_FORMAT,
    version: 1,
    downloadedAt: "2026-10-09T00:00:00Z",
    organizations: ["example-synthetic"],
    repositories: [
      {
        id: 7001,
        name: "tool",
        fullName: "example-synthetic/tool",
        description: "A synthetic tool",
        url: "https://github.com/example-synthetic/tool",
        pullRequests: Array.from({ length: 12 }, (_, index) =>
          pull(
            index + 1,
            ["sig/docs", index % 2 === 0 ? "kind/bug" : "kind/feature"],
            "**What this PR does**:\nKeeps the synthetic tool's cache bounded so builds stay fast.\n",
          ),
        ),
      },
      {
        id: 7002,
        name: "site",
        fullName: "example-synthetic/site",
        description: "A synthetic site",
        url: "https://github.com/example-synthetic/site",
        pullRequests: [pull(1, [], "", "site"), pull(2, ["kind/cleanup"], "", "site")],
      },
    ],
  };
}

test("public text loses comments, sign-offs, email addresses, and mentions", () => {
  const scrubbed = scrubPublicText(
    "Fixes the cache. <!-- template note -->\ncc @some-maintainer and @other\nWrite to someone@example.com\nSigned-off-by: Someone <someone@example.com>\n`@decorator` stays",
  );
  assert.doesNotMatch(
    scrubbed,
    /template note|Signed-off-by|example\.com|some-maintainer|@other/,
  );
  assert.match(scrubbed, /cc @someone and @someone/);
  assert.match(scrubbed, /\[email removed\]/);
  assert.match(scrubbed, /`@decorator` stays/);
  assert.equal(
    summaryOf(
      pull(
        5,
        [],
        "**What this PR does**:\nKeeps the synthetic tool's cache bounded.\n\n**Which issue",
      ),
    ),
    "Keeps the synthetic tool's cache bounded.",
  );
});

test("a public download loads as one organization with stand-in people, once", async () => {
  const summary = await loadPublicDataset(env.ctx, dataset());
  assert.equal(summary.projects, 2);
  assert.equal(
    summary.businessUnits,
    2,
    "a SIG unit and community infrastructure",
  );
  assert.equal(summary.sources, 14, "every merged pull request is captured");
  assert.ok(summary.memories > 0 && summary.pending > 0);
  const { rows } = await env.db.query<{
    display_name: string;
    github_user_id: string | null;
  }>("SELECT display_name, github_user_id FROM principals");
  const names = rows.map((row) => row.display_name);
  for (const standIn of [
    "Morgan Steward",
    "Ari Admin",
    "Robin Reader",
    "Casey Newcomer",
    "Triage Bot",
  ]) {
    assert.ok(names.includes(standIn), `${standIn} stands in`);
  }
  assert.ok(
    rows.every((row) => !row.display_name.startsWith("author-")),
    "no author keys become names",
  );
  await assert.rejects(loadPublicDataset(env.ctx, dataset()), ConflictError);
  await assert.rejects(
    loadPublicDataset(env.ctx, {
      ...dataset(),
      format: "other",
    } as unknown as PublicDataset),
    ValidationError,
  );
});

function titled(title: string, labels: string[] = []): PublicPullRequest {
  return { ...pull(1, labels), title };
}

test("memory types come from kind labels, then common labels, then the title", () => {
  const cases: Array<[string, string[], string | null]> = [
    ["feat: add a thing", ["kind/bug"], "lesson"],
    ["chore: tidy", ["kind/cleanup"], "decision"],
    ["Something", ["Regression"], "incident"],
    ["Something", ["security"], "constraint"],
    ["Something", ["breaking-change"], "constraint"],
    ["Something", ["bug"], "lesson"],
    ["chore: something", ["type: bug"], "lesson"],
    ["Something", ["Documentation"], "rationale"],
    ["Something", ["enhancement"], "decision"],
    ["Something", ["performance"], "lesson"],
    ["feat(api)!: drop the old flag", [], "constraint"],
    ["chore!: require Node 24", [], "constraint"],
    ["revert: feat: add cache", [], "incident"],
    ["fix(router): handle trailing slashes", [], "lesson"],
    ["perf: cache lookups", [], "lesson"],
    ["feat: add streaming", [], "decision"],
    ["refactor(core): split module", [], "decision"],
    ["docs: explain caching", [], "rationale"],
    ["[docs] explain caching", [], "rationale"],
    ["security: rotate keys", [], "constraint"],
    ["chore: tidy imports", [], null],
    ["test: cover edge cases", [], null],
    ["ci: pin action", [], null],
    ["build(deps): bump x", [], null],
    ["[backport] fix the cache", [], null],
    ["chore(deps): bump x from 1.0.0 to 2.0.0", [], null],
    ['Revert "Add streaming"', [], "incident"],
    ["Fix bundle analyzer sorting", [], "lesson"],
    ["Prevent duplicate requests", [], "lesson"],
    ["Deprecate the legacy flag", [], "constraint"],
    ["Drop support for Node 18", [], "constraint"],
    ["Add Grok eval results", [], "decision"],
    ["Allow Draft Mode on closed routes", [], "decision"],
    ["Document agent feedback limits", [], "rationale"],
    ["turbopack: fix chunk collisions", [], "lesson"],
    ["[lts-active] Fix deploy tests", [], "lesson"],
    ["Bump @scope/agent-eval to ^2.2.1", [], null],
    ["Update dependency next to v16.1.0", [], null],
    ["Bump react from 18.2.0 to 19.0.0", [], null],
    ["Version Packages", [], null],
    ["Virtualize the source table", [], null],
  ];
  for (const [title, labels, expected] of cases) {
    assert.equal(
      memoryTypeOf(titled(title, labels)),
      expected,
      `${title} [${labels.join(", ")}]`,
    );
  }
});

test("memory titles drop a known conventional-commit prefix", () => {
  assert.equal(
    memoryTitleOf({ ...titled("fix(router): handle X"), number: 123 }),
    "Handle X (#123)",
  );
  assert.equal(
    memoryTitleOf({ ...titled("feat!: drop Y"), number: 4 }),
    "Drop Y (#4)",
  );
  assert.equal(
    memoryTitleOf({ ...titled("kubeadm: fix the join flow"), number: 5 }),
    "kubeadm: fix the join flow (#5)",
  );
  assert.equal(
    memoryTitleOf({ ...titled("Fix the cache"), number: 6 }),
    "Fix the cache (#6)",
  );
});

test("business units fall back from SIG to team label, language, owner, then community", () => {
  const repo = (
    labels: string[][],
    extra: Partial<PublicRepository> = {},
  ): PublicRepository => ({
    id: 1,
    name: "tool",
    fullName: "example-synthetic/tool",
    description: "",
    url: "https://github.com/example-synthetic/tool",
    pullRequests: labels.map((set, index) => pull(index + 1, set)),
    ...extra,
  });
  assert.equal(
    groupOf(repo([["sig/node", "created-by: Turbopack team"], ["sig/node"]]), true),
    "SIG Node",
  );
  assert.equal(
    groupOf(
      repo(
        [["created-by: Turbopack team"], ["created-by: Turbopack team"], ["created-by: Next.js team"]],
        { language: "Rust" },
      ),
      false,
    ),
    "Turbopack",
  );
  assert.equal(groupOf(repo([["team: Platform"]]), false), "Platform");
  assert.equal(groupOf(repo([["team/build-tools"]]), false), "Build Tools");
  assert.equal(
    groupOf(repo([["area/dependency"]], { language: "Go" }), false),
    "Go engineering",
    "area labels are topics, not teams",
  );
  assert.equal(
    groupOf(repo([["bug"]], { language: "TypeScript", topics: ["ai"] }), true),
    "TypeScript engineering",
  );
  assert.equal(
    groupOf(repo([["bug"]], { fullName: "kubernetes-sigs/kwok" }), true),
    "Kubernetes Sigs",
  );
  assert.equal(groupOf(repo([["bug"]], { language: null }), false), "Community infrastructure");
});

test("a dataset without SIG labels still loads several units with memories", async () => {
  const conventional = [
    "fix: keep the cache bounded",
    "feat: add streaming responses",
    "docs: explain the cache",
    "chore: tidy imports",
    "Add a retry budget",
    "Fix a race in the router",
  ];
  const repo = (id: number, name: string, language: string | null): PublicRepository => ({
    id,
    name,
    fullName: `example-synthetic/${name}`,
    description: "",
    url: `https://github.com/example-synthetic/${name}`,
    language,
    pullRequests: conventional.map((title, index) => ({
      ...pull(index + 1, []),
      title,
      url: `https://github.com/example-synthetic/${name}/pull/${index + 1}`,
      mergeCommitSha: (id * 100 + index).toString(16).padStart(40, "b"),
    })),
  });
  const summary = await loadPublicDataset(env.ctx, {
    ...dataset(),
    repositories: [
      repo(81, "engine", "Rust"),
      repo(82, "web", "TypeScript"),
      repo(83, "plain", null),
    ],
  });
  assert.equal(summary.businessUnits, 3);
  assert.equal(summary.sources, 18);
  assert.ok(summary.memories + summary.pending >= 12, "titles suggest memories");
  const { rows } = await env.db.query<{ title: string }>(
    "SELECT title FROM memory_proposals",
  );
  assert.ok(rows.some((row) => row.title.startsWith("Keep the cache bounded (#")));
});

test("dependency bumps never become memories, whatever their labels", async () => {
  const { isDependencyBump, memoryTypeOf } = await import(
    "../src/public-data.ts"
  );
  const pull = (title: string, labels: string[] = []) => ({
    number: 1,
    title,
    body: "",
    url: "https://github.com/example/example/pull/1",
    mergeCommitSha: "abc",
    mergedAt: "2026-10-01T00:00:00Z",
    authorKey: "k",
    labels,
  });
  for (const title of [
    "Bump github.com/aws/aws-sdk-go-v2/service/s3 from 1.113.4 to 1.114.0 in /perfdash",
    "chore(deps): update dependency typescript to v5.6.3",
    "build(deps-dev): bump vitest from 2.1.0 to 2.1.1",
    "[release-1.31] Bump golang.org/x/net to v0.33.0",
    "Update the go dependencies group",
  ]) {
    assert.ok(isDependencyBump(title), title);
    assert.equal(memoryTypeOf(pull(title, ["kind/cleanup"])), null, title);
  }
  for (const title of [
    "Update docs to explain retries",
    "fix: bump the timeout so slow nodes join",
    "Add support for IPv6 dual stack",
  ]) {
    assert.ok(!isDependencyBump(title), title);
  }
});
