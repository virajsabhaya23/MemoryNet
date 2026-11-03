import assert from "node:assert/strict";
import { test } from "node:test";
import { getDefinition } from "../src/index.ts";
import { assemblePrompt } from "../src/prompt.ts";
import { formatCount } from "../src/web/assets/prompt-view.js";
import { escapeHtml } from "../src/web/html.ts";
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

function dataBlock(body: string): {
  summary: string;
  checks: number;
  blocks: Array<Record<string, unknown>>;
} {
  const match =
    /<script type="application\/json" id="pa-data">([\s\S]*?)<\/script>/.exec(
      body,
    );
  if (!match?.[1]) throw new Error("The page has no prompt data block");
  return JSON.parse(match[1]);
}

test("a definition's prompt anatomy shows seven blocks, live totals, and the assembled text", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const agentId = await definitionId("Checkout review assistant");
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const reply = await rhea.get(`/definitions/${agentId}/prompt`);
  assert.equal(reply.status, 200);
  const csp = reply.headers["Content-Security-Policy"] ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(
    reply.body,
    /<script type="module" src="\/assets\/prompt\.js"><\/script>/,
  );

  const view = await getDefinition(
    env.ctx,
    await personId(env.db, "Rhea Reviewer"),
    agentId,
  );
  const assembly = assemblePrompt({
    view,
    scope: { level: "project", name: "Checkout" },
    nameOf: (id) =>
      id === view.definition.runsAs ? "Copilot Agent" : "Rhea Reviewer",
  });
  assert.ok(
    reply.body.includes(escapeHtml(assembly.text)),
    "the copy holds the assembled prompt, as text",
  );
  const positions = [
    "role",
    "objective",
    "context",
    "rules",
    "output",
    "review",
    "start",
  ].map((key) => reply.body.indexOf(`id="pa-block-${key}"`));
  assert.ok(positions.every((at) => at > 0));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    "the blocks are listed in the order they go in",
  );
  for (const [count, value] of [
    ["blocks", "7"],
    ["tokens", formatCount(assembly.tokens)],
    ["checks", String(assembly.checks.passed)],
    ["records", String(assembly.records)],
  ]) {
    assert.match(
      reply.body,
      new RegExp(`data-count="${count}"\\s*>${value}<`),
      `the dashboard ends at the full ${count}`,
    );
  }
  assert.match(reply.body, /class="pa-stage pa-auto"/);
  assert.equal(
    (reply.body.match(/class="pa-node pa-c-/g) ?? []).length,
    14,
    "seven nodes, drawn for wide and for narrow screens",
  );
  assert.match(reply.body, /href="#pa-block-context"/);
  assert.match(
    reply.body,
    /class="pa-sat"\s+href="\/memories\/[0-9a-f-]{36}"/,
    "each linked record is a link to its page",
  );

  const data = dataBlock(reply.body);
  assert.equal(data.blocks.length, 7);
  assert.deepEqual(
    data.blocks.map((item) => item.label),
    [
      "Role",
      "Objective",
      "Context",
      "Rules",
      "Output rules",
      "Review",
      "Start",
    ],
  );
  assert.equal(data.checks, assembly.checks.total);
  assert.equal(
    data.blocks.reduce((sum, item) => sum + Number(item.tokens), 0),
    assembly.tokens,
  );
  assert.ok(
    !JSON.stringify(data).includes("Check each pull request"),
    "the data block holds labels and numbers, never record text",
  );

  for (const path of ["/assets/prompt.js", "/assets/prompt-view.js"]) {
    const script = await rhea.get(path);
    assert.equal(script.status, 200);
    assert.equal(
      script.headers["Content-Type"],
      "text/javascript; charset=utf-8",
    );
  }
  const definitionPage = await rhea.get(`/definitions/${agentId}`);
  assert.match(
    definitionPage.body,
    new RegExp(
      `href="/definitions/${agentId}/prompt"\\s*>\\s*See its prompt anatomy`,
    ),
  );
  assert.match(definitionPage.body, /<section id="propose-change">/);
});

test("people see a prompt only where they may see the definition, and nothing hidden leaks", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const agentId = await definitionId("Checkout review assistant");
  const guard = await definitionId("Payments SDK guard");
  const rudy = await as(app, env.db, "Rudy Reader");
  assert.equal((await rudy.get(`/definitions/${guard}/prompt`)).status, 404);
  const page = await rudy.get(`/definitions/${agentId}/prompt`);
  assert.equal(page.status, 200, "readers see approved definitions");
  for (const hidden of ["Payments SDK guard", "Helpdesk", "card SDK", guard]) {
    assert.ok(
      !page.body.includes(hidden),
      `a Checkout reader's prompt page never mentions ${hidden}`,
    );
  }
  for (const name of ["Oscar Outsider", "Gina Globex"]) {
    const outsider = await as(app, env.db, name);
    assert.equal(
      (await outsider.get(`/definitions/${agentId}/prompt`)).status,
      404,
    );
  }
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  assert.equal(
    (await rudy.get(`/definitions/${acme}/prompt`)).status,
    404,
    "an ID that is not a definition reads as missing",
  );
});

test("records left out of the prompt are marked, and text in a definition stays text", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const cody = await as(app, env.db, "Cody Contributor");
  const { rows } = await env.db.query<{ id: string }>(
    `SELECT m.id FROM memories m
     JOIN memory_revisions r ON r.memory_id = m.id AND r.revision = m.current_revision
     WHERE r.title = 'Retry card authorization at most 3 times'`,
  );
  const suspended = await cody.post(`/memories/${rows[0]?.id}/suspend`, {
    expectedRevision: "1",
    reason: "Synthetic dispute",
  });
  assert.equal(suspended.status, 303);
  const agentId = await definitionId("Checkout review assistant");
  const page = await cody.get(`/definitions/${agentId}/prompt`);
  assert.match(page.body, /1 linked record adds no text/);
  assert.match(page.body, /class="pa-sat is-out"/);
  assert.match(
    page.body,
    /<span class="badge badge-muted">left out<\/span>\s*<small>Suspended while disputed/,
  );
  assert.match(page.body, /<li data-passed="false">/);

  const hostile = "</script><script>alert(1)</script> & <b>bold</b>";
  const proposed = await cody.post(`/scopes/project/${checkout}/definitions`, {
    kind: "skill",
    name: hostile,
    purpose: "Synthetic purpose.",
    responsibilities: "Synthetic duty",
  });
  const proposalId = /\/definition-proposals\/([0-9a-f-]{36})/.exec(
    proposed.headers.Location ?? "",
  )?.[1];
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const approved = await rhea.post(
    `/definition-proposals/${proposalId}/approve`,
    { expectedRevision: "1" },
  );
  assert.equal(approved.status, 303);
  const skillId = /\/definitions\/([0-9a-f-]{36})/.exec(
    approved.headers.Location ?? "",
  )?.[1];
  const skillPage = await rhea.get(`/definitions/${skillId}/prompt`);
  assert.equal(skillPage.status, 200);
  assert.ok(!skillPage.body.includes("<script>alert(1)"));
  assert.ok(
    skillPage.body.includes("&lt;/script&gt;&lt;script&gt;alert(1)"),
    "the name shows as text",
  );
  assert.ok(
    !JSON.stringify(dataBlock(skillPage.body)).includes("alert(1)"),
    "names never go into the data block",
  );
});
