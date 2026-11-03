import assert from "node:assert/strict";
import { test } from "node:test";
import { useTestDatabase } from "./helpers.ts";
import { as, loadExample, openApp, TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();
const CACHE = "Keep the session cache in checkout";
const TIMEOUT = "Payment provider calls time out after 10 seconds";

async function proposal(title: string) {
  const { rows } = await env.db.query<{
    id: string;
    content: string;
    type: string;
    owner_id: string;
  }>("SELECT id, content, type, owner_id FROM memory_proposals WHERE title = $1", [title]);
  if (!rows[0]) throw new Error(`No proposal titled ${title}`);
  const evidence = await env.db.query<{ source_id: string }>(
    "SELECT source_id FROM proposal_evidence WHERE proposal_id = $1",
    [rows[0].id],
  );
  return {
    ...rows[0],
    title,
    evidence: evidence.rows.map((row) => row.source_id),
  };
}

function editFields(
  current: Awaited<ReturnType<typeof proposal>>,
  expectedRevision: number,
  changes: Record<string, string> = {},
) {
  return {
    expectedRevision: String(expectedRevision),
    type: current.type,
    title: current.title,
    content: `${current.content}\r\nSynthetic second line.`,
    evidenceSourceIds: current.evidence,
    ownerId: current.owner_id,
    ...changes,
  };
}

test("the review screen shows the proposal beside its evidence, and the queue lists what you may review", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const queue = await rhea.get("/review");
  assert.match(queue.body, new RegExp(CACHE));
  assert.match(queue.body, new RegExp(TIMEOUT));

  const cody = await as(app, env.db, "Cody Contributor");
  const codyQueue = await cody.get("/review");
  assert.match(codyQueue.body, /Nothing is waiting for your review/);
  assert.match(codyQueue.body, /Your proposals waiting for someone else[\s\S]*Keep the session cache/);

  const screen = await rhea.get(`/proposals/${(await proposal(CACHE)).id}`);
  assert.match(screen.body, /class="review-grid"/);
  assert.match(screen.body, /Proposed text, version 1/);
  assert.match(screen.body, /checkout latency doubled in staging/, "the evidence excerpt is on the same screen");
  assert.match(screen.body, /Review version 1/);
});

test("editing saves a new version with a visible diff, and a review of the old version is refused", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const cache = await proposal(CACHE);
  const cody = await as(app, env.db, "Cody Contributor");
  assert.match((await cody.get(`/proposals/${cache.id}`)).body, /Edit this proposal/);
  const edited = await cody.post(`/proposals/${cache.id}/edit`, {
    ...editFields(cache, 1),
    changeNote: "Add the second line",
  });
  assert.equal(edited.status, 303);
  const page = await cody.get(`/proposals/${cache.id}`);
  assert.match(page.body, /version 2/);
  assert.match(page.body, /Changes in version 2/);
  assert.match(page.body, /class="diff-added"[\s\S]*Synthetic second line/);
  assert.doesNotMatch(
    page.body,
    /class="diff-removed"/,
    "browser line breaks do not show unchanged lines as removed",
  );
  assert.match(page.body, /Add the second line/);

  const rhea = await as(app, env.db, "Rhea Reviewer");
  const stale = await rhea.post(`/proposals/${cache.id}/approve`, { expectedRevision: "1" });
  assert.equal(stale.status, 409);
  const again = await cody.post(`/proposals/${cache.id}/edit`, editFields(cache, 1));
  assert.equal(again.status, 409, "an edit based on an old version conflicts");
  const approved = await rhea.post(`/proposals/${cache.id}/approve`, { expectedRevision: "2" });
  assert.equal(approved.status, 303);
  const memory = await rhea.get(approved.headers.Location ?? "");
  assert.match(memory.body, /version 2 approved/);
});

test("a reviewer who edits cannot approve, and only the proposer or a reviewer may edit", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const timeout = await proposal(TIMEOUT);
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const edited = await rhea.post(`/proposals/${timeout.id}/edit`, editFields(timeout, 1));
  assert.equal(edited.status, 303);
  const page = await rhea.get(`/proposals/${timeout.id}`);
  assert.doesNotMatch(page.body, />Approve</);
  assert.match(page.body, /You wrote a version of this proposal/);
  const selfApproval = await rhea.post(`/proposals/${timeout.id}/approve`, {
    expectedRevision: "2",
  });
  assert.equal(selfApproval.status, 403);

  const cody = await as(app, env.db, "Cody Contributor");
  assert.doesNotMatch(
    (await cody.get(`/proposals/${timeout.id}`)).body,
    /Edit this proposal/,
    "contributors edit only their own proposals",
  );
  const olivia = await as(app, env.db, "Olivia Owner");
  const approved = await olivia.post(`/proposals/${timeout.id}/approve`, {
    expectedRevision: "2",
  });
  assert.equal(approved.status, 303);
});

test("the System page previews the GitHub check with review links and no titles", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const system = new TestBrowser(app);
  const preview = await system.get("/system?checkRepository=1001&checkPull=12");
  assert.match(preview.body, /MemoryNet review/);
  assert.match(preview.body, /2 memory proposals waiting for review/);
  assert.match(preview.body, /http:\/\/localhost:3050\/proposals\/[0-9a-f-]{36}/);
  assert.doesNotMatch(preview.body, new RegExp(CACHE));
  assert.doesNotMatch(preview.body, new RegExp(TIMEOUT));

  const unused = await system.get("/system?checkRepository=1004&checkPull=1");
  assert.match(unused.body, /would post no check/);
});

test("replacement review explains the current and proposed decisions without treating a pending change as approved", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const cache = await proposal(CACHE);
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const approved = await rhea.post(`/proposals/${cache.id}/approve`, {
    expectedRevision: "1",
  });
  const memoryId = /\/memories\/([0-9a-f-]{36})/.exec(approved.headers.Location ?? "")?.[1];
  assert.ok(memoryId);
  const cody = await as(app, env.db, "Cody Contributor");
  const replacement = await cody.post(`/memories/${memoryId}/changes`, {
    expectedRevision: "1",
    kind: "replace",
    type: "decision",
    title: "Use the shared checkout cache",
    content: "Synthetic replacement: the shared cache now owns session state.",
    evidenceSourceIds: cache.evidence,
    ownerId: cache.owner_id,
  });
  assert.equal(replacement.status, 303);
  const path = (replacement.headers.Location ?? "").split("?")[0] ?? "";
  const pending = await rhea.get(path);
  assert.match(pending.body, /Existing decision, version 1/);
  assert.match(pending.body, /class="content"[\s\S]*Keep the session cache: removing it doubled/);
  assert.match(pending.body, /aria-label="Decision replacement"/);
  assert.match(pending.body, /After approval of proposal version 1/);
  assert.match(pending.body, /Both histories are kept/);
  assert.match(pending.body, /Rejecting this proposal keeps the existing decision current/);

  // A suspended source decision must not be described as current by the preview.
  await cody.post(`/memories/${memoryId}/suspend`, {
    expectedRevision: "1",
    reason: "Synthetic: disputed while the replacement is reviewed",
  });
  const suspended = await rhea.get(path);
  assert.match(suspended.body, /Existing decision, version 1/);
  assert.doesNotMatch(suspended.body, /aria-label="Decision replacement"/);
  assert.doesNotMatch(suspended.body, /keeps the existing decision current/);
});
