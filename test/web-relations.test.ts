import assert from "node:assert/strict";
import { test } from "node:test";
import { useTestDatabase } from "./helpers.ts";
import { as, loadExample, openApp } from "./web-helpers.ts";

const env = useTestDatabase();

test("people propose paths and links in the form, reviewers see them, and the memory shows them once approved", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const { rows } = await env.db.query<{ project_id: string; source_id: string; memory_id: string; title: string }>(
    `SELECT m.project_id, me.source_id, m.id AS memory_id, r.title
     FROM memories m JOIN memory_revisions r ON r.memory_id = m.id AND r.revision = m.current_revision
     JOIN memory_evidence me ON me.memory_id = m.id AND me.revision = m.current_revision
     JOIN memory_proposals mp ON mp.project_id = m.project_id AND mp.title = 'Keep the session cache in checkout'
     WHERE m.status = 'approved' LIMIT 1`,
  );
  const fixture = rows[0]!;
  const cody = await as(app, env.db, "Cody Contributor");
  const projectPage = await cody.get(`/projects/${fixture.project_id}`);
  assert.match(projectPage.body, /Paths this guidance governs/);
  assert.match(projectPage.body, new RegExp(`name="link:${fixture.memory_id}"`));
  const proposed = await cody.post(`/projects/${fixture.project_id}/proposals`, {
    type: "constraint", title: "Checkout retries stay bounded", content: "Synthetic: at most three retries in checkout.",
    evidenceSourceIds: [fixture.source_id], relationsForm: "1", paths: "src/checkout/**\r\nsrc/cart.ts\r\n",
    [`link:${fixture.memory_id}`]: "depends_on",
  });
  assert.equal(proposed.status, 303);
  const proposalPath = proposed.headers.Location?.split("?")[0] ?? "";
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const review = await rhea.get(proposalPath);
  assert.match(review.body, /Proposed relations/);
  assert.match(review.body, /<code>src\/cart\.ts<\/code>, <code>src\/checkout\/\*\*<\/code>/);
  assert.match(review.body, new RegExp(`depends on[\\s\\S]*${fixture.title}`));
  const bad = await cody.post(`/projects/${fixture.project_id}/proposals`, {
    type: "lesson", title: "Bad path", content: "Synthetic.", evidenceSourceIds: [fixture.source_id], relationsForm: "1", paths: "../secrets",
  });
  assert.equal(bad.status, 400);
  const approved = await rhea.post(`${proposalPath}/approve`, { expectedRevision: "1" });
  assert.equal(approved.status, 303);
  const memory = await rhea.get(approved.headers.Location ?? "");
  assert.match(memory.body, /Governs <code>src\/cart\.ts<\/code>/);
});
