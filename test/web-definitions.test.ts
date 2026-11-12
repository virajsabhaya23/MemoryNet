import assert from "node:assert/strict";
import { test } from "node:test";
import { useTestDatabase } from "./helpers.ts";
import { as, idOf, loadExample, openApp, personId } from "./web-helpers.ts";

const env = useTestDatabase();

async function definitionId(name: string): Promise<string> {
  const { rows } = await env.db.query<{ id: string }>(
    `SELECT d.id FROM definitions d
     JOIN definition_revisions r ON r.definition_id = d.id AND r.revision = d.current_revision
     WHERE r.name = $1`,
    [name],
  );
  if (!rows[0]) throw new Error(`No definition named ${name}`);
  return rows[0].id;
}

async function pendingProposalId(name: string): Promise<string> {
  const { rows } = await env.db.query<{ id: string }>(
    "SELECT id FROM definition_proposals WHERE name = $1 AND status = 'pending' ORDER BY proposed_at",
    [name],
  );
  if (!rows[0]) throw new Error(`No pending proposal named ${name}`);
  return rows[0].id;
}

function idFrom(location: string | undefined, prefix: string): string {
  const match = new RegExp(`^/${prefix}/([0-9a-f-]{36})`).exec(location ?? "");
  if (!match?.[1]) throw new Error(`Unexpected redirect: ${location}`);
  return match[1];
}

test("contributors describe an agent's responsibilities; readers and agents see no proposals", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const skill = await definitionId("Check a change against team decisions");
  const rule = await definitionId(
    "Keep secrets out of code, pull requests, and AI chats",
  );
  const cody = await as(app, env.db, "Cody Contributor");
  const list = await cody.get(`/scopes/project/${checkout}/definitions`);
  assert.match(list.body, /Describe a new agent, skill, instruction, or rule/);
  assert.match(list.body, /From above, applying here too/);
  assert.match(
    list.body,
    /Payment calls are bounded/,
    "business unit rules apply to its projects",
  );

  const proposed = await cody.post(`/scopes/project/${checkout}/definitions`, {
    kind: "agent",
    name: "Refund checker",
    purpose: "Checks refund changes against checkout decisions.",
    responsibilities:
      "Check every refund change\r\n\r\nQuote the related memory IDs\n",
    boundaries: "Approving refunds",
    appliesTo: "Refund code in checkout-service",
    instructions: "Start with the check skill.",
    runsAs: await personId(env.db, "Coding Agent"),
    links: [`uses:${skill}`, `follows:${rule}`],
  });
  assert.equal(proposed.status, 303);
  const proposalId = idFrom(proposed.headers.Location, "definition-proposals");
  const proposal = await cody.get(`/definition-proposals/${proposalId}`);
  assert.match(proposal.body, /pending/);
  assert.match(proposal.body, /a different reviewer must decide/);
  assert.match(
    proposal.body,
    /<li>Check every refund change<\/li>\s*<li>Quote the related memory IDs<\/li>/,
  );
  assert.match(proposal.body, /Check a change against team decisions/);

  const rudy = await as(app, env.db, "Rudy Reader");
  assert.doesNotMatch(
    (await rudy.get(`/scopes/project/${checkout}/definitions`)).body,
    /Describe a new agent/,
  );
  assert.equal(
    (await rudy.get(`/definition-proposals/${proposalId}`)).status,
    404,
  );
  const agent = await as(app, env.db, "Coding Agent");
  assert.equal(
    (await agent.get(`/definition-proposals/${proposalId}`)).status,
    404,
  );
  const byAgent = await agent.post(`/scopes/project/${checkout}/definitions`, {
    kind: "skill",
    name: "Agent-proposed skill",
    purpose: "Synthetic.",
    responsibilities: "Synthetic duty",
    ownerId: await personId(env.db, "Cody Contributor"),
  });
  assert.equal(byAgent.status, 303);
  assert.match(byAgent.headers.Location ?? "", /definition-proposed-by-agent/);
  const review = await agent.post(
    `/definition-proposals/${proposalId}/approve`,
    { expectedRevision: "1" },
  );
  assert.equal(review.status, 403, "agents never review");

  const rhea = await as(app, env.db, "Rhea Reviewer");
  const approved = await rhea.post(
    `/definition-proposals/${proposalId}/approve`,
    { expectedRevision: "1" },
  );
  assert.equal(approved.status, 303);
  const page = await rudy.get(
    `/definitions/${idFrom(approved.headers.Location, "definitions")}`,
  );
  assert.equal(page.status, 200, "readers see approved definitions");
  assert.match(page.body, /Responsibilities/);
  assert.match(page.body, /Must never/);
  assert.match(page.body, /Coding Agent/);
  assert.match(
    page.body,
    /Source: MemoryNet definition/,
    "a copy to paste into an AI tool, with its ID",
  );
  assert.doesNotMatch(
    page.body,
    /Propose a change/,
    "readers cannot propose changes",
  );
});

test("reviewers see the difference, and the later of two parallel changes is refused", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const skill = await definitionId("Check a change against team decisions");
  const waiting = await pendingProposalId(
    "Check a change against team decisions",
  );
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const diff = await rhea.get(`/definition-proposals/${waiting}`);
  assert.match(diff.body, /What changes from version 1/);
  assert.match(
    diff.body,
    /class="diff-added"\s*>\+ Check the change against Platform rules too/,
  );
  assert.match(
    diff.body,
    /class="diff-added"\s*>\+ follows Payment calls are bounded/,
  );
  assert.match(diff.body, /Unchanged: Status, Name, Purpose/);

  const cody = await as(app, env.db, "Cody Contributor");
  const parallel = await cody.post(`/definitions/${skill}/changes`, {
    baseRevision: "1",
    name: "Check a change against team decisions",
    purpose:
      "Finds the approved decisions a pull request might break, with their IDs.",
    responsibilities: "Find approved memories related to the change",
    ownerId: await personId(env.db, "Cody Contributor"),
    changeNote: "Shorter list",
  });
  assert.equal(parallel.status, 303);
  assert.match(parallel.headers.Location ?? "", /definition-change-proposed/);
  const second = await pendingProposalId(
    "Check a change against team decisions",
  );
  assert.equal(second, waiting, "the older proposal is still first");
  const { rows } = await env.db.query<{ id: string }>(
    "SELECT id FROM definition_proposals WHERE change_note = 'Shorter list'",
  );
  const shorter = rows[0]?.id ?? "";

  assert.equal(
    (
      await rhea.post(`/definition-proposals/${waiting}/approve`, {
        expectedRevision: "1",
      })
    ).status,
    303,
  );
  const stale = await rhea.post(`/definition-proposals/${shorter}/approve`, {
    expectedRevision: "1",
  });
  assert.equal(stale.status, 409);
  assert.match(stale.body, /it is now at version 2/);
  assert.match(
    (await rhea.get(`/definition-proposals/${shorter}`)).body,
    /Approving it is refused/,
  );
  const stillSelf = await cody.post(
    `/definition-proposals/${shorter}/approve`,
    { expectedRevision: "1" },
  );
  assert.equal(stillSelf.status, 403, "nobody approves their own proposal");
});

test("retiring and restoring go through review, and history keeps every version", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const skill = await definitionId("Check a change against team decisions");
  const cody = await as(app, env.db, "Cody Contributor");
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const retire = await cody.post(`/definitions/${skill}/retire`, {
    baseRevision: "1",
    reason: "Replaced by a checklist",
  });
  assert.equal(retire.status, 303);
  const retirement = (
    await env.db.query<{ id: string }>(
      "SELECT id FROM definition_proposals WHERE action = 'retire' AND status = 'pending'",
    )
  ).rows[0]?.id;
  assert.equal(
    (
      await rhea.post(`/definition-proposals/${retirement}/approve`, {
        expectedRevision: "1",
      })
    ).status,
    303,
  );
  const retired = await rhea.get(`/definitions/${skill}`);
  assert.match(retired.body, /Retired: kept for its history/);
  assert.match(retired.body, /Propose bringing it back/);

  const version = await cody.get(`/definitions/${skill}/versions/1`);
  assert.match(version.body, /Restore this version/);
  const restore = await cody.post(`/definitions/${skill}/changes`, {
    baseRevision: "2",
    name: "Check a change against team decisions",
    purpose:
      "Finds the approved decisions a pull request might break, with their IDs.",
    responsibilities: [
      "Find approved memories related to the files and topics in the change",
      "Quote each related memory with its ID and version",
      "Say clearly when nothing related was found",
    ].join("\n"),
    boundaries: "Treating an empty result as proof that no decision exists",
    ownerId: await personId(env.db, "Cody Contributor"),
    changeNote: "Restore version 1",
  });
  assert.equal(restore.status, 303);
  const restoring = (
    await env.db.query<{ id: string }>(
      "SELECT id FROM definition_proposals WHERE change_note = 'Restore version 1'",
    )
  ).rows[0]?.id;
  assert.equal(
    (
      await rhea.post(`/definition-proposals/${restoring}/approve`, {
        expectedRevision: "1",
      })
    ).status,
    303,
  );
  const history = await rhea.get(`/definitions/${skill}`);
  assert.match(
    history.body,
    /version 3<\/a\s*>\s*<span class="badge badge-ok">current<\/span>/,
  );
  assert.match(history.body, /Replaced by a checklist/);
  assert.match(history.body, /Restore version 1/);
});

test("secrets are refused in every field, and the reason is shown", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const cody = await as(app, env.db, "Cody Contributor");
  const refused = await cody.post(`/scopes/project/${checkout}/definitions`, {
    kind: "instruction",
    name: "Deploy steps",
    purpose: "Synthetic.",
    responsibilities: "Deploy with password=Synthetic42Value",
  });
  assert.equal(refused.status, 400);
  assert.match(
    refused.body,
    /responsibilities looks like it contains a secret/,
  );
  assert.doesNotMatch(
    refused.body,
    /Synthetic42Value/,
    "the error never repeats the secret",
  );
});

test("a link to suspended knowledge shows its status and stays in the change form", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const skill = await definitionId("Check a change against team decisions");
  const title = "Retry card authorization at most 3 times";
  const { rows } = await env.db.query<{ id: string; revision: number }>(
    `SELECT m.id, m.current_revision AS revision FROM memories m
     JOIN memory_revisions r ON r.memory_id = m.id AND r.revision = m.current_revision
     WHERE r.title = $1`,
    [title],
  );
  const memory = rows[0];
  if (!memory) throw new Error(`No memory titled ${title}`);
  const cody = await as(app, env.db, "Cody Contributor");
  const suspended = await cody.post(`/memories/${memory.id}/suspend`, {
    expectedRevision: String(memory.revision),
    reason: "Synthetic dispute",
  });
  assert.equal(suspended.status, 303);

  const page = await cody.get(`/definitions/${skill}`);
  assert.match(
    page.body,
    new RegExp(
      `${title}</a\\s*>\\s*<span class="badge badge-type">[^<]*</span>\\s*<span class="badge badge-warn">suspended</span>`,
    ),
  );
  assert.match(
    page.body,
    new RegExp(`value="based_on:${memory.id}"\\s+checked`),
    "the change form keeps the link unless someone unticks it",
  );
  assert.match(page.body, new RegExp(`\\(memory ${memory.id}, suspended\\)`));
});
