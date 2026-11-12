import assert from "node:assert/strict";
import { test } from "node:test";
import { useTestDatabase } from "./helpers.ts";
import { as, idOf, loadExample, openApp } from "./web-helpers.ts";

const env = useTestDatabase();
const RETRY = "Retry card authorization at most 3 times";

async function memoryId(title: string): Promise<string> {
  const { rows } = await env.db.query<{ memory_id: string }>(
    `SELECT memory_id FROM memory_revisions WHERE title = $1 ORDER BY revision LIMIT 1`,
    [title],
  );
  if (!rows[0]) throw new Error(`No memory titled ${title}`);
  return rows[0].memory_id;
}

async function evidenceOf(id: string): Promise<string[]> {
  const { rows } = await env.db.query<{ source_id: string }>(
    `SELECT me.source_id FROM memory_evidence me JOIN memories m ON m.id = me.memory_id
     WHERE me.memory_id = $1 AND me.revision = m.current_revision`,
    [id],
  );
  return rows.map((row) => row.source_id);
}

async function changeFields(
  id: string,
  kind: "revise" | "replace",
  content: string,
  revision = 1,
) {
  const { rows } = await env.db.query<{ owner_id: string }>(
    "SELECT owner_id FROM memories WHERE id = $1",
    [id],
  );
  return {
    expectedRevision: String(revision),
    kind,
    type: "decision",
    title: kind === "replace" ? "Use the retry budget service" : RETRY,
    content,
    evidenceSourceIds: await evidenceOf(id),
    ownerId: rows[0]?.owner_id ?? "",
  };
}

function proposalFrom(location: string | undefined): string {
  const id = /\/proposals\/([0-9a-f-]{36})/.exec(location ?? "")?.[1];
  if (!id) throw new Error(`Unexpected redirect: ${location}`);
  return id;
}

test("a reviewed new version keeps the ID, and the history page shows every version", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const id = await memoryId(RETRY);
  const cody = await as(app, env.db, "Cody Contributor");
  assert.match((await cody.get(`/memories/${id}`)).body, /Propose a change/);
  const proposed = await cody.post(
    `/memories/${id}/changes`,
    await changeFields(
      id,
      "revise",
      "Card authorization retries at most 5 times.",
    ),
  );
  assert.equal(proposed.status, 303);
  const proposalId = proposalFrom(proposed.headers.Location);

  const rhea = await as(app, env.db, "Rhea Reviewer");
  const screen = await rhea.get(`/proposals/${proposalId}`);
  assert.match(screen.body, /Change to/);
  assert.match(screen.body, /What this changes in the current text/);
  assert.match(screen.body, /class="diff-added"[\s\S]*5 times/);
  const approved = await rhea.post(`/proposals/${proposalId}/approve`, {
    expectedRevision: "1",
  });
  assert.match(approved.headers.Location ?? "", new RegExp(`/memories/${id}`));

  const rudy = await as(app, env.db, "Rudy Reader");
  const history = await rudy.get(`/memories/${id}/history`);
  assert.match(history.body, /Version 2/);
  assert.match(history.body, /revised/);
  assert.match(history.body, /Version 1/);
  assert.match(
    history.body,
    /retries at most 3 times, with exponential backoff/,
  );
  assert.doesNotMatch(
    history.body,
    /Propose restoring/,
    "readers cannot propose",
  );
});

test("a change built on an old version is flagged, refused, and can be rebuilt on the latest", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const id = await memoryId(RETRY);
  const cody = await as(app, env.db, "Cody Contributor");
  const first = proposalFrom(
    (
      await cody.post(
        `/memories/${id}/changes`,
        await changeFields(id, "revise", "Retries: 4."),
      )
    ).headers.Location,
  );
  const second = proposalFrom(
    (
      await cody.post(
        `/memories/${id}/changes`,
        await changeFields(id, "revise", "Retries: 6."),
      )
    ).headers.Location,
  );
  const rhea = await as(app, env.db, "Rhea Reviewer");
  assert.equal(
    (await rhea.post(`/proposals/${first}/approve`, { expectedRevision: "1" }))
      .status,
    303,
  );

  const stale = await rhea.get(`/proposals/${second}`);
  assert.match(
    stale.body,
    /The memory changed after this proposal was written/,
  );
  const refused = await rhea.post(`/proposals/${second}/approve`, {
    expectedRevision: "1",
  });
  assert.equal(refused.status, 409);
  assert.match(refused.body, /now at version 2/);

  const codyView = await cody.get(`/proposals/${second}`);
  assert.match(codyView.body, /Build on version 2/);
  const rebuilt = await cody.post(`/proposals/${second}/edit`, {
    expectedRevision: "1",
    baseRevision: "2",
    type: "decision",
    title: RETRY,
    content: "Retries: 6.",
    evidenceSourceIds: await evidenceOf(id),
    ownerId: await env.db
      .query<{
        owner_id: string;
      }>("SELECT owner_id FROM memories WHERE id = $1", [id])
      .then((result) => result.rows[0]?.owner_id ?? ""),
    changeNote: "Builds on version 2",
  });
  assert.equal(rebuilt.status, 303);
  const approved = await rhea.post(`/proposals/${second}/approve`, {
    expectedRevision: "2",
  });
  assert.equal(approved.status, 303);
  assert.match((await rhea.get(`/memories/${id}`)).body, /version 3/);
});

test("suspended and replaced memories are clearly marked and not listed as current", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const id = await memoryId(RETRY);
  const agent = await as(app, env.db, "Coding Agent");
  assert.doesNotMatch((await agent.get(`/memories/${id}`)).body, />Suspend</);
  const reported = await agent.post(`/memories/${id}/report`, {
    reason: "Synthetic: defaults changed",
  });
  assert.equal(reported.status, 303);

  const cody = await as(app, env.db, "Cody Contributor");
  const withReport = await cody.get(`/memories/${id}`);
  assert.match(withReport.body, /Synthetic: defaults changed/);
  const suspended = await cody.post(`/memories/${id}/suspend`, {
    expectedRevision: "1",
    reason: "Synthetic: disputed by the load test",
  });
  assert.equal(suspended.status, 303);
  const page = await cody.get(`/memories/${id}`);
  assert.match(page.body, /suspended/);
  assert.match(page.body, /not current guidance until a reviewer resolves it/);
  const project = await cody.get(`/projects/${checkout}`);
  assert.match(
    project.body,
    /<h2>Suspended<\/h2>[\s\S]*Retry card authorization/,
  );
  assert.doesNotMatch(
    (await cody.get(`/memories/${id}`)).body,
    />Reinstate</,
    "contributors cannot reinstate",
  );

  const rhea = await as(app, env.db, "Rhea Reviewer");
  const reinstated = await rhea.post(`/memories/${id}/reinstate`, {
    expectedRevision: "1",
    reason: "Synthetic: rechecked",
  });
  assert.equal(reinstated.status, 303);

  const replacement = proposalFrom(
    (
      await cody.post(
        `/memories/${id}/changes`,
        await changeFields(
          id,
          "replace",
          "Synthetic: use the retry budget service.",
        ),
      )
    ).headers.Location,
  );
  assert.equal(
    (
      await rhea.post(`/proposals/${replacement}/approve`, {
        expectedRevision: "1",
      })
    ).status,
    303,
  );
  const old = await cody.get(`/memories/${id}`);
  assert.match(old.body, /replaced/);
  assert.match(old.body, /Use the retry budget service/);
  assert.doesNotMatch(
    old.body,
    /Propose a change/,
    "a replaced memory cannot change",
  );
  const projectAfter = await cody.get(`/projects/${checkout}`);
  assert.match(
    projectAfter.body,
    /<h2>Replaced<\/h2>[\s\S]*Retry card authorization/,
  );
});

test("an earlier version is restored only through a reviewed proposal", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const id = await memoryId(RETRY);
  const cody = await as(app, env.db, "Cody Contributor");
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const change = proposalFrom(
    (
      await cody.post(
        `/memories/${id}/changes`,
        await changeFields(id, "revise", "Synthetic: a wrong change."),
      )
    ).headers.Location,
  );
  await rhea.post(`/proposals/${change}/approve`, { expectedRevision: "1" });

  const history = await cody.get(`/memories/${id}/history`);
  assert.match(history.body, /Propose restoring version 1/);
  const restore = await cody.post(`/memories/${id}/restore`, {
    expectedRevision: "2",
    fromRevision: "1",
  });
  assert.equal(restore.status, 303);
  const screen = await rhea.get(
    `/proposals/${proposalFrom(restore.headers.Location)}`,
  );
  assert.match(screen.body, /brings back version 1 as a new version/);
  assert.match(
    (await rhea.get(`/memories/${id}`)).body,
    /a wrong change/,
    "nothing changes before review",
  );
  await rhea.post(
    `/proposals/${proposalFrom(restore.headers.Location)}/approve`,
    { expectedRevision: "1" },
  );
  const restored = await rhea.get(`/memories/${id}`);
  assert.match(restored.body, /version 3/);
  assert.match(
    restored.body,
    /retries at most 3 times, with exponential backoff/,
  );
});
