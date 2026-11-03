import assert from "node:assert/strict";
import { test } from "node:test";
import { useTestDatabase } from "./helpers.ts";
import { as, idOf, loadExample, openApp, TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();
const SHA = "e5f60718293a4b5c6d7e8f90123456789012abcd";

function merged(fields: Record<string, string>): Record<string, string> {
  return { externalRepositoryId: "1001", mergeCommitSha: SHA, ...fields };
}

async function capturedSource(reference: string) {
  const { rows } = await env.db.query<{
    id: string;
    excerpt: string;
    content_flags: string[];
  }>(
    `SELECT id, excerpt, content_flags FROM sources
     WHERE capture_method = 'github_app' AND reference = $1`,
    [reference],
  );
  return rows[0] ?? null;
}

async function sourceIdFor(reference: string): Promise<string> {
  const { rows } = await env.db.query<{ id: string }>(
    "SELECT id FROM sources WHERE reference = $1 AND external_repository_id = '1001'",
    [reference],
  );
  if (!rows[0]) throw new Error(`No source ${reference}`);
  return rows[0].id;
}

test("a merged pull request becomes one source, however often the event arrives", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const system = new TestBrowser(app);

  const first = await system.system(
    "/system/merged-pull-request",
    merged({ pullRequest: "40", title: "Add refund idempotency keys", body: "Synthetic description." }),
  );
  assert.match(first.headers.Location ?? "", /done=pr-captured/);
  const again = await system.system(
    "/system/merged-pull-request",
    merged({ pullRequest: "40", title: "Edited after the merge", body: "Changed text." }),
  );
  assert.match(again.headers.Location ?? "", /done=pr-duplicate/);
  const source = await capturedSource("pull/40");
  assert.ok(source);
  assert.match(source.excerpt, /^Add refund idempotency keys/);
  assert.doesNotMatch(source.excerpt, /Edited after the merge/);

  const listed = await system.get("/system");
  assert.match(listed.body, /Captured by the GitHub App/);
  assert.match(listed.body, /pull\/40/);

  const cody = await as(app, env.db, "Cody Contributor");
  const project = await cody.get(`/projects/${checkout}`);
  assert.match(project.body, /pull\/40/);
  const page = await cody.get(`/sources/${source.id}`);
  assert.match(page.body, /by the GitHub App/);

  const unconnected = await system.system(
    "/system/merged-pull-request",
    merged({ externalRepositoryId: "1004", pullRequest: "3", title: "Docs update" }),
  );
  assert.match(unconnected.headers.Location ?? "", /done=pr-ignored/);
  const { rows } = await env.db.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM sources WHERE external_repository_id = '1004'",
  );
  assert.equal(rows[0]?.count, 0, "nothing is stored for unused repositories");
});

test("captured secrets are replaced, personal data is flagged, and long text is shortened", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const system = new TestBrowser(app);
  await system.system(
    "/system/merged-pull-request",
    merged({
      pullRequest: "41",
      title: "Rotate the staging credentials",
      body: "Synthetic: the old value was password=Synthetic9Secret. Ask synthetic.person@example.com.",
    }),
  );
  await system.system(
    "/system/merged-pull-request",
    merged({ pullRequest: "42", title: "Long synthetic notes", body: "x".repeat(5000) }),
  );

  const secret = await capturedSource("pull/41");
  assert.ok(secret);
  assert.doesNotMatch(secret.excerpt, /Synthetic9Secret/);
  assert.match(secret.excerpt, /password=\[secret removed\]/);
  assert.deepEqual(secret.content_flags, ["secret_removed", "personal_data"]);
  const long = await capturedSource("pull/42");
  assert.deepEqual(long?.content_flags, ["truncated"]);

  const cody = await as(app, env.db, "Cody Contributor");
  const page = await cody.get(`/sources/${secret.id}`);
  assert.match(page.body, /secret removed/);
  assert.match(page.body, /possible personal data/);
  assert.match((await cody.get(`/sources/${long?.id}`)).body, /shortened/);
});

test("typed secrets are refused without repeating them, and possible personal data is flagged", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const cody = await as(app, env.db, "Cody Contributor");

  const refused = await cody.post(`/projects/${checkout}/sources`, {
    externalRepositoryId: "1001",
    pullRequest: "14",
    excerpt: "Synthetic: api_key: abc123def456ghi789",
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body, /looks like it contains a secret \(password or key\)/);
  assert.doesNotMatch(refused.body, /abc123def456ghi789/);

  const proposed = await cody.post(`/projects/${checkout}/proposals`, {
    type: "incident",
    title: "Synthetic outage contact",
    content: "Synthetic: page synthetic.oncall@example.com during checkout outages.",
    evidenceSourceIds: [await sourceIdFor("pull/11")],
  });
  assert.equal(proposed.status, 303);
  const page = await cody.get(proposed.headers.Location ?? "");
  assert.match(page.body, /possible personal data/);
});

test("copies of visible knowledge are refused, ignoring case and spacing", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const evidence = [await sourceIdFor("pull/11")];
  const rhea = await as(app, env.db, "Rhea Reviewer");

  const approvedCopy = await rhea.post(`/projects/${checkout}/proposals`, {
    type: "decision",
    title: "retry card   authorization at most 3 TIMES",
    content: "Card authorization retries at most 3 times, with exponential backoff between attempts.",
    evidenceSourceIds: evidence,
  });
  assert.equal(approvedCopy.status, 409);
  assert.match(approvedCopy.body, /already approved knowledge/);

  const pendingCopy = await rhea.post(`/projects/${checkout}/proposals`, {
    type: "decision",
    title: "Keep the session cache in checkout",
    content: "Keep the session cache: removing it doubled checkout latency in staging.",
    evidenceSourceIds: [await sourceIdFor("pull/12")],
  });
  assert.equal(pendingCopy.status, 409);
  assert.match(pendingCopy.body, /already waiting for review/);
});

test("evidence other than a pull request link is not supported yet", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const cody = await as(app, env.db, "Cody Contributor");
  const issue = await cody.post(`/projects/${checkout}/sources`, {
    externalRepositoryId: "1001",
    pullRequest: "5",
    url: "https://github.com/acme-synthetic/checkout-service/issues/5",
    excerpt: "Synthetic issue text.",
  });
  assert.equal(issue.status, 400);
  assert.match(issue.body, /must link to pull\/5/);
});

test("captured evidence supports a reviewed memory that readers can use", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  await new TestBrowser(app).system(
    "/system/merged-pull-request",
    merged({ pullRequest: "43", title: "Cap refund retries at 2", body: "Synthetic description." }),
  );
  const source = await capturedSource("pull/43");
  const cody = await as(app, env.db, "Cody Contributor");
  const proposed = await cody.post(`/projects/${checkout}/proposals`, {
    type: "decision",
    title: "Refund retries stop after 2 attempts",
    content: "Synthetic decision taken in pull request 43.",
    evidenceSourceIds: [source?.id ?? ""],
  });
  const proposalId = /\/proposals\/([0-9a-f-]{36})/.exec(proposed.headers.Location ?? "")?.[1];
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const approved = await rhea.post(`/proposals/${proposalId}/approve`, {
    expectedRevision: "1",
  });
  assert.equal(approved.status, 303);

  const rudy = await as(app, env.db, "Rudy Reader");
  const memory = await rudy.get(approved.headers.Location?.split("?")[0] ?? "");
  assert.equal(memory.status, 200);
  assert.match(memory.body, /pull\/43/);
  assert.match(memory.body, /Cap refund retries at 2/);
});
