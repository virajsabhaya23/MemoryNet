import assert from "node:assert/strict";
import { test } from "node:test";
import { useTestDatabase } from "./helpers.ts";
import { as, idOf, loadExample, openApp, personId } from "./web-helpers.ts";

const env = useTestDatabase();

async function proposalId(title: string): Promise<string> {
  const { rows } = await env.db.query<{ id: string }>(
    "SELECT id FROM memory_proposals WHERE title = $1",
    [title],
  );
  if (!rows[0]) throw new Error(`No proposal titled ${title}`);
  return rows[0].id;
}

async function sourceIdFor(reference: string, repository: string): Promise<string> {
  const { rows } = await env.db.query<{ id: string }>(
    "SELECT id FROM sources WHERE reference = $1 AND external_repository_id = $2",
    [reference, repository],
  );
  if (!rows[0]) throw new Error(`No source ${reference} in ${repository}`);
  return rows[0].id;
}

function idFrom(location: string | undefined, prefix: string): string {
  const match = new RegExp(`^/${prefix}/([0-9a-f-]{36})`).exec(location ?? "");
  if (!match?.[1]) throw new Error(`Unexpected redirect: ${location}`);
  return match[1];
}

test("contributors record evidence and propose; readers see neither the forms nor the proposal", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const cody = await as(app, env.db, "Cody Contributor");

  const projectPage = await cody.get(`/projects/${checkout}`);
  assert.match(projectPage.body, /Record pull request evidence/);
  assert.match(projectPage.body, /Propose a memory/);

  const recorded = await cody.post(`/projects/${checkout}/sources`, {
    externalRepositoryId: "1001",
    pullRequest: "13",
    excerpt: "Synthetic discussion: keep refunds idempotent by order ID.",
  });
  assert.equal(recorded.status, 303);
  const sourceId = idFrom(recorded.headers.Location, "sources");
  const sourcePage = await cody.get(`/sources/${sourceId}`);
  assert.match(
    sourcePage.body,
    /https:\/\/github\.com\/acme-synthetic\/checkout-service\/pull\/13/,
    "the link defaults to the pull request",
  );
  assert.match(sourcePage.body, /by Cody Contributor/);

  const proposed = await cody.post(`/projects/${checkout}/proposals`, {
    type: "lesson",
    title: "Refunds must be idempotent",
    content: "Synthetic lesson: a retried refund must not pay twice.",
    evidenceSourceIds: [sourceId],
  });
  assert.equal(proposed.status, 303);
  const id = idFrom(proposed.headers.Location, "proposals");
  const proposalPage = await cody.get(`/proposals/${id}`);
  assert.match(proposalPage.body, /pending/);
  assert.match(proposalPage.body, /not knowledge/);
  assert.match(proposalPage.body, /a different reviewer must decide/);

  const rudy = await as(app, env.db, "Rudy Reader");
  const readerView = await rudy.get(`/projects/${checkout}`);
  assert.doesNotMatch(readerView.body, /Propose a memory/);
  assert.doesNotMatch(readerView.body, /Refunds must be idempotent/);
  assert.equal((await rudy.get(`/proposals/${id}`)).status, 404);
  const agent = await as(app, env.db, "Copilot Agent");
  assert.equal((await agent.get(`/proposals/${id}`)).status, 404);
});

test("a different reviewer approves the exact version, and the memory shows its ID, owner, and evidence", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const pending = await proposalId("Keep the session cache in checkout");
  const cody = await as(app, env.db, "Cody Contributor");
  const own = await cody.get(`/proposals/${pending}`);
  assert.doesNotMatch(own.body, />Approve</);
  const selfApproval = await cody.post(`/proposals/${pending}/approve`, {
    expectedRevision: "1",
  });
  assert.equal(selfApproval.status, 403);

  const rhea = await as(app, env.db, "Rhea Reviewer");
  assert.match((await rhea.get(`/proposals/${pending}`)).body, />Approve</);
  const stale = await rhea.post(`/proposals/${pending}/approve`, {
    expectedRevision: "2",
  });
  assert.equal(stale.status, 409, "approval names the exact version");
  const approved = await rhea.post(`/proposals/${pending}/approve`, {
    expectedRevision: "1",
    reason: "Staging numbers support it",
  });
  assert.equal(approved.status, 303);
  const memoryId = idFrom(approved.headers.Location, "memories");
  const memoryPage = await rhea.get(`/memories/${memoryId}`);
  assert.match(memoryPage.body, /current/);
  assert.match(memoryPage.body, new RegExp(memoryId));
  assert.match(memoryPage.body, /<dt>Owner<\/dt>\s*<dd>Cody Contributor<\/dd>/);
  assert.match(memoryPage.body, /Rhea Reviewer on/);
  assert.match(memoryPage.body, /pull\/12/);
  assert.match(memoryPage.body, /commit b2c3d4e/);
  assert.match(memoryPage.body, /checkout latency doubled in staging/);

  const rudy = await as(app, env.db, "Rudy Reader");
  const readerView = await rudy.get(`/memories/${memoryId}`);
  assert.equal(readerView.status, 200);
  assert.match(readerView.body, /visible to contributors and above/);
  const oscar = await as(app, env.db, "Oscar Outsider");
  assert.equal((await oscar.get(`/memories/${memoryId}`)).status, 404);
});

test("rejections need a reason and never become knowledge", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const title = "Payment provider calls time out after 10 seconds";
  const agentProposal = await proposalId(title);
  const rhea = await as(app, env.db, "Rhea Reviewer");

  const noReason = await rhea.post(`/proposals/${agentProposal}/reject`, {
    expectedRevision: "1",
  });
  assert.equal(noReason.status, 400);
  const rejected = await rhea.post(`/proposals/${agentProposal}/reject`, {
    expectedRevision: "1",
    reason: "The excerpt does not name the timeout owner",
  });
  assert.equal(rejected.status, 303);
  const page = await rhea.get(`/proposals/${agentProposal}`);
  assert.match(page.body, /rejected/);
  assert.match(page.body, /The excerpt does not name the timeout owner/);

  const rudy = await as(app, env.db, "Rudy Reader");
  assert.doesNotMatch((await rudy.get(`/projects/${checkout}`)).body, new RegExp(title));
});

test("agents propose for a named person but cannot review", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const evidence = await sourceIdFor("pull/11", "1001");
  const agent = await as(app, env.db, "Copilot Agent");
  const fields = {
    type: "rationale",
    title: "Backoff protects the payment queue",
    content: "Synthetic reason: spacing retries keeps the queue short.",
    evidenceSourceIds: [evidence],
  };

  const unnamed = await agent.post(`/projects/${checkout}/proposals`, fields);
  assert.equal(unnamed.status, 400, "agents must name a person as owner");
  const named = await agent.post(`/projects/${checkout}/proposals`, {
    ...fields,
    ownerId: await personId(env.db, "Cody Contributor"),
  });
  assert.equal(named.status, 303);
  assert.match(named.headers.Location ?? "", /done=proposed-by-agent/);

  const pending = await proposalId("Keep the session cache in checkout");
  const review = await agent.post(`/proposals/${pending}/approve`, {
    expectedRevision: "1",
  });
  assert.equal(review.status, 403, "agents cannot review");
});

test("evidence must be a pull request from this project", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const cody = await as(app, env.db, "Cody Contributor");

  const notANumber = await cody.post(`/projects/${checkout}/sources`, {
    externalRepositoryId: "1001",
    pullRequest: "abc",
    excerpt: "Synthetic excerpt.",
  });
  assert.equal(notANumber.status, 400);
  const otherRepository = await cody.post(`/projects/${checkout}/sources`, {
    externalRepositoryId: "1002",
    pullRequest: "5",
    excerpt: "Synthetic excerpt.",
  });
  assert.equal(otherRepository.status, 400);

  const base = {
    type: "decision",
    title: "Synthetic unsupported decision",
    content: "Synthetic body.",
  };
  const noEvidence = await cody.post(`/projects/${checkout}/proposals`, base);
  assert.equal(noEvidence.status, 400);
  const foreign = await cody.post(`/projects/${checkout}/proposals`, {
    ...base,
    evidenceSourceIds: [await sourceIdFor("pull/21", "1002")],
  });
  assert.equal(foreign.status, 400, "evidence must come from this project");
});

test("administrators export approved knowledge as portable JSON", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const checkout = await idOf(env.db, "projects", "checkout");
  const adam = await as(app, env.db, "Adam Admin");
  assert.match((await adam.get(`/orgs/${acme}`)).body, /Download export/);

  const download = await adam.post(`/scopes/organization/${acme}/export`);
  assert.equal(download.status, 200);
  assert.match(download.headers["Content-Disposition"] ?? "", /attachment/);
  const data = JSON.parse(download.body) as {
    format: string;
    formatVersion: number;
    memories: Array<{ title: string }>;
  };
  assert.equal(data.format, "memorynet.knowledge-export");
  assert.equal(data.formatVersion, 3);
  assert.deepEqual(data.memories.map((memory) => memory.title).sort(), [
    "Payments pins the card SDK to version 4.2",
    "Retry card authorization at most 3 times",
    "Unbounded retries overloaded the payment queue",
  ]);

  const rhea = await as(app, env.db, "Rhea Reviewer");
  assert.doesNotMatch((await rhea.get(`/projects/${checkout}`)).body, /Download export/);
  assert.equal((await rhea.post(`/scopes/project/${checkout}/export`)).status, 403);
  const oscar = await as(app, env.db, "Oscar Outsider");
  assert.equal((await oscar.post(`/scopes/organization/${acme}/export`)).status, 404);
});
