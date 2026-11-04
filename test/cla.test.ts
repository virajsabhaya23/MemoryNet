import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGREEMENT, MARKER, SIGNATURES_BRANCH, SIGNATURES_PATH, evaluate, isAgreement, parseTeamMembers, requiredSigners, run,
  type GitHubClient, type GitHubUser, type IssueComment, type PullCommit,
} from "../.github/scripts/cla.mjs";

const owner: GitHubUser = { id: 1, login: "virajsabhaya23", type: "User" };
const alice: GitHubUser = { id: 2, login: "alice", type: "User" };
const bob: GitHubUser = { id: 3, login: "bob", type: "User" };
const bot: GitHubUser = { id: 4, login: "dependabot[bot]", type: "Bot" };
const actions: GitHubUser = { id: 5, login: "github-actions[bot]", type: "Bot" };
const maintainers = parseTeamMembers("# maintainers\nVirajSabhaya23  # owner\n\n");

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/** In-memory GitHub REST API covering only the routes the CLA check uses. */
function fakeGitHub(input: { author: GitHubUser; commits: PullCommit[] }) {
  const files = new Map<string, { text: string; sha: string }>([["main:.github/TEAM_MEMBERS", { text: "virajsabhaya23\n", sha: "t1" }]]);
  const branches = new Set(["main"]);
  const comments: IssueComment[] = [];
  const statuses: { state: string; description: string }[] = [];
  let version = 0;
  let conflicts = 0;
  const client: GitHubClient = {
    async request(route, p = {}) {
      const key = `${p.ref ?? p.branch}:${p.path}`;
      switch (route) {
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
          return { data: { state: "open", user: input.author, head: { sha: "head" }, base: { ref: "main", repo: { default_branch: "main" } } } };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits":
          return { data: p.page === 1 ? input.commits : [] };
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
          return { data: p.page === 1 ? [...comments] : [] };
        case "GET /repos/{owner}/{repo}/contents/{path}": {
          const file = branches.has(String(p.ref)) ? files.get(key) : undefined;
          if (!file) throw httpError(404);
          return { data: { content: Buffer.from(file.text).toString("base64"), sha: file.sha } };
        }
        case "PUT /repos/{owner}/{repo}/contents/{path}": {
          if (!branches.has(String(p.branch))) throw httpError(404);
          if (conflicts > 0) { conflicts--; throw httpError(409); }
          if (p.sha !== files.get(key)?.sha) throw httpError(409);
          files.set(key, { text: Buffer.from(String(p.content), "base64").toString("utf8"), sha: `s${++version}` });
          return { data: {} };
        }
        case "GET /repos/{owner}/{repo}/git/ref/{ref}":
          if (!branches.has(String(p.ref).replace("heads/", ""))) throw httpError(404);
          return { data: { object: { sha: "main-sha" } } };
        case "POST /repos/{owner}/{repo}/git/refs":
          branches.add(String(p.ref).replace("refs/heads/", ""));
          return { data: {} };
        case "POST /repos/{owner}/{repo}/statuses/{sha}":
          statuses.push({ state: String(p.state), description: String(p.description) });
          return { data: {} };
        case "POST /repos/{owner}/{repo}/issues/{issue_number}/comments":
          comments.push({ id: comments.length + 100, body: String(p.body), user: actions, created_at: "2026-11-03T00:00:00Z", html_url: "c" });
          return { data: {} };
        case "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}":
          comments.find((c) => c.id === p.comment_id)!.body = String(p.body);
          return { data: {} };
        default:
          throw new Error(`Unexpected route ${route}`);
      }
    },
  };
  const signatures = () => {
    const file = files.get(`${SIGNATURES_BRANCH}:${SIGNATURES_PATH}`);
    return file ? JSON.parse(file.text).signatures as { id: number; login: string; pullRequest: number }[] : [];
  };
  const say = (user: GitHubUser, body: string) =>
    comments.push({ id: comments.length + 1, body, user, created_at: "2026-11-03T12:00:00Z", html_url: `https://github.com/c/${comments.length + 1}` });
  return { client, comments, statuses, signatures, say, conflictOnce: () => { conflicts = 1; } };
}

const context = (number: number, event: "pull_request" | "issue") => ({
  repo: { owner: "virajsabhaya23", repo: "MemoryNet" }, serverUrl: "https://github.com",
  payload: event === "pull_request" ? { pull_request: { number } } : { issue: { number, pull_request: {} } },
});
const commit = (sha: string, author: GitHubUser | null): PullCommit => ({ sha, author });

test("only the exact agreement sentence counts, ignoring case, spacing and the final period", () => {
  assert.equal(isAgreement(AGREEMENT), true);
  assert.equal(isAgreement(`  ${AGREEMENT.toUpperCase().replace(/\.$/, "")}\n`), true);
  assert.equal(isAgreement(AGREEMENT.replace("I agree", "I do not agree")), false);
  assert.equal(isAgreement(`Quote: ${AGREEMENT}`), false);
  assert.equal(isAgreement(undefined), false);
});

test("the pull-request author and human commit authors must sign; maintainers and bots need not", () => {
  const { signers, unlinked } = requiredSigners(alice, [commit("aaaaaaa1", alice), commit("bbbbbbb2", bob), commit("ccccccc3", bot), commit("ddddddd4", owner), commit("eeeeeee5", null)], maintainers);
  assert.deepEqual([...signers.values()].sort(), ["alice", "bob"]);
  assert.deepEqual(unlinked, ["eeeeeee"]);
  // Commit e-mail is unverified: borrowing the maintainer's address does not exempt the person who opened the pull request.
  assert.deepEqual([...requiredSigners(bob, [commit("1234567", owner)], maintainers).signers.values()], ["bob"]);
  assert.equal(requiredSigners(owner, [commit("1234567", owner)], maintainers).signers.size, 0);
  assert.equal(evaluate(new Map(), ["eeeeeee"], []).ok, false);
});

test("a contribution is blocked until its author agrees, then the agreement is recorded once", async () => {
  const gh = fakeGitHub({ author: alice, commits: [commit("aaaaaaa1", alice)] });
  assert.deepEqual(await run({ github: gh.client, context: context(7, "pull_request") }), { ok: false, missing: ["alice"], unlinked: [] });
  assert.equal(gh.statuses.at(-1)?.state, "failure");
  assert.equal(gh.comments.length, 1);
  assert.ok(gh.comments[0]!.body!.startsWith(MARKER) && gh.comments[0]!.body!.includes("@alice") && gh.comments[0]!.body!.includes(AGREEMENT));

  gh.say(bob, AGREEMENT); // Not an author of this pull request: ignored.
  gh.say(alice, AGREEMENT);
  assert.equal((await run({ github: gh.client, context: context(7, "issue") }) as { ok: boolean }).ok, true);
  assert.equal(gh.statuses.at(-1)?.state, "success");
  assert.deepEqual(gh.signatures().map((s) => [s.login, s.pullRequest]), [["alice", 7]]);
  assert.equal(gh.comments.filter((c) => c.user?.login === "github-actions[bot]").length, 1, "the existing bot comment is updated, not repeated");
  assert.match(gh.comments[0]!.body!, /Everyone who authored this pull request has agreed/);

  await run({ github: gh.client, context: context(7, "issue") });
  assert.equal(gh.signatures().length, 1);
});

test("an agreement covers later pull requests, and a concurrent write is merged instead of lost", async () => {
  const gh = fakeGitHub({ author: alice, commits: [commit("aaaaaaa1", alice), commit("bbbbbbb2", bob)] });
  gh.say(alice, AGREEMENT);
  gh.say(bob, AGREEMENT);
  gh.conflictOnce();
  assert.deepEqual(await run({ github: gh.client, context: context(8, "issue") }), { ok: true, missing: [], unlinked: [] });
  assert.deepEqual(gh.signatures().map((s) => s.login).sort(), ["alice", "bob"]);
  assert.equal(gh.comments.filter((c) => c.user?.type === "Bot").length, 0, "no comment when nothing is missing");

  gh.comments.length = 0; // A later pull request by the same authors, with no new agreement comment.
  assert.deepEqual(await run({ github: gh.client, context: context(11, "pull_request") }), { ok: true, missing: [], unlinked: [] });
  assert.equal(gh.statuses.at(-1)?.state, "success");
  assert.equal(gh.signatures().length, 2);
});

test("a maintainer's own pull request passes without a comment", async () => {
  const gh = fakeGitHub({ author: owner, commits: [commit("aaaaaaa1", owner), commit("bbbbbbb2", bot)] });
  assert.deepEqual(await run({ github: gh.client, context: context(9, "pull_request") }), { ok: true, missing: [], unlinked: [] });
  assert.equal(gh.statuses.at(-1)?.state, "success");
  assert.equal(gh.comments.length, 0);
});
