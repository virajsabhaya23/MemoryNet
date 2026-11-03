import assert from "node:assert/strict";
import { test } from "node:test";
import { getNetwork } from "../src/index.ts";
import { networkPayload } from "../src/web/routes/network.ts";
import { useTestDatabase } from "./helpers.ts";
import {
  as,
  idOf,
  loadExample,
  openApp,
  ORIGIN,
  personId,
  TestBrowser,
} from "./web-helpers.ts";

const env = useTestDatabase();

function dataBlock(body: string): unknown {
  const match =
    /<script type="application\/json" id="network-data">([\s\S]*?)<\/script>/.exec(
      body,
    );
  if (!match?.[1]) throw new Error("The page has no network data block");
  return JSON.parse(match[1]);
}

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

test("the network page embeds exactly the viewer's network and draws it with same-origin scripts", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const olivia = await as(app, env.db, "Olivia Owner");
  const reply = await olivia.get(`/orgs/${acme}/network`);
  assert.equal(reply.status, 200);
  assert.match(
    reply.headers["Content-Security-Policy"] ?? "",
    /script-src 'self'/,
  );
  assert.doesNotMatch(
    reply.headers["Content-Security-Policy"] ?? "",
    /unsafe-inline|unsafe-eval/,
  );
  assert.match(
    reply.body,
    /<script type="module" src="\/assets\/network\.js"><\/script>/,
  );
  assert.match(
    reply.body,
    /Show the network as a list/,
    "a list works without the diagram",
  );

  const graph = await getNetwork(
    env.ctx,
    await personId(env.db, "Olivia Owner"),
    acme,
  );
  const expected = JSON.parse(
    JSON.stringify(networkPayload(graph, null, null)),
  );
  assert.deepEqual(
    dataBlock(reply.body),
    expected,
    "the picture is drawn from the same records",
  );
  for (const node of graph.nodes) {
    assert.ok(
      reply.body.includes(node.label.replaceAll("'", "&#39;")),
      `the list names ${node.label}`,
    );
  }

  for (const path of ["/assets/network.js", "/assets/graph-engine.js"]) {
    const script = await olivia.get(path);
    assert.equal(script.status, 200);
    assert.equal(
      script.headers["Content-Type"],
      "text/javascript; charset=utf-8",
    );
  }
  assert.match((await olivia.get(`/orgs/${acme}`)).body, /Open the network/);
});

test("people see only their part of the network, and outsiders see none of it", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const payments = await idOf(env.db, "projects", "payments");
  const guard = await definitionId("Payments SDK guard");
  const rudy = await as(app, env.db, "Rudy Reader");
  const page = await rudy.get(
    `/orgs/${acme}/network?focus=project:${payments}&node=definition:${guard}`,
  );
  assert.equal(page.status, 200);
  for (const hidden of [
    "Payments",
    "Helpdesk",
    "Support Tools",
    "card SDK",
    guard,
    payments,
  ]) {
    assert.ok(
      !page.body.includes(hidden),
      `a Checkout reader's page never mentions ${hidden}`,
    );
  }
  const data = dataBlock(page.body) as { focus: unknown; select: unknown };
  assert.equal(data.focus, null, "focus on a hidden group is ignored");
  assert.equal(data.select, null, "selecting a hidden node is ignored");
  assert.match(
    page.body,
    /Keep secrets out of code, pull requests, and AI chats/,
    "organization rules reach Checkout",
  );

  const oscar = await as(app, env.db, "Oscar Outsider");
  assert.equal((await oscar.get(`/orgs/${acme}/network`)).status, 404);
  const gina = await as(app, env.db, "Gina Globex");
  assert.equal((await gina.get(`/orgs/${acme}/network`)).status, 404);
});

test("text in a definition can never break out of the page or its data block", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const checkout = await idOf(env.db, "projects", "checkout");
  const hostile = "</script><script>alert(1)</script> & <b>bold</b>";
  const cody = await as(app, env.db, "Cody Contributor");
  const proposed = await cody.post(`/scopes/project/${checkout}/definitions`, {
    kind: "skill",
    name: hostile,
    purpose: "Synthetic purpose.",
    responsibilities: "Synthetic duty",
  });
  assert.equal(proposed.status, 303);
  const proposalId = /\/definition-proposals\/([0-9a-f-]{36})/.exec(
    proposed.headers.Location ?? "",
  )?.[1];
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const approved = await rhea.post(
    `/definition-proposals/${proposalId}/approve`,
    { expectedRevision: "1" },
  );
  assert.equal(approved.status, 303);

  const page = await rhea.get(`/orgs/${acme}/network`);
  assert.ok(
    !page.body.includes("<script>alert(1)"),
    "the text is never markup",
  );
  assert.ok(
    page.body.includes("&lt;/script&gt;&lt;script&gt;alert(1)"),
    "the list shows it as text",
  );
  assert.ok(
    page.body.includes("\\u003c/script\\u003e"),
    "the data block escapes it",
  );
  const data = dataBlock(page.body) as { nodes: Array<{ label: string }> };
  assert.ok(
    data.nodes.some((node) => node.label === hostile),
    "and the diagram still gets the exact name",
  );
});

test("the network offers four views of the same records, an honest AI trace, and counts only what each person may see", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const olivia = await as(app, env.db, "Olivia Owner");
  const page = await olivia.get(`/orgs/${acme}/network`);
  for (const view of ["Network", "Timeline", "AI Trace", "Table"]) {
    assert.match(
      page.body,
      new RegExp(`role="tab"[^>]*>\\s*${view}\\s*<`),
      `${view} is a tab`,
    );
  }
  assert.match(page.body, /No AI retrieval records yet/);
  assert.match(
    page.body,
    /never an explanation of how the model\s+reasoned/,
    "the trace promises context, not reasoning",
  );
  assert.match(
    page.body,
    /changes? waiting for review/,
    "owners see review work",
  );

  const view = await olivia.get("/assets/network-view.js");
  assert.equal(view.status, 200);
  assert.equal(view.headers["Content-Type"], "text/javascript; charset=utf-8");

  const home = await olivia.get("/");
  assert.match(
    home.body,
    new RegExp(`href="/orgs/${acme}/network"\\s*>\\s*Open the network`),
  );
  const { rows } = await env.db.query<{ id: string }>(
    `SELECT m.id FROM memories m JOIN projects p ON p.id = m.project_id
     WHERE p.organization_id = $1 ORDER BY m.id LIMIT 1`,
    [acme],
  );
  const memoryId = rows[0]?.id ?? "";
  const memory = await olivia.get(`/memories/${memoryId}`);
  assert.match(
    memory.body,
    new RegExp(
      `href="/orgs/${acme}/network\\?node=memory%3A${memoryId}"\\s*>\\s*Show in the network`,
    ),
  );

  const rudy = await as(app, env.db, "Rudy Reader");
  const readerPage = await rudy.get(`/orgs/${acme}/network`);
  assert.doesNotMatch(
    readerPage.body,
    /waiting for review/,
    "readers get no review counts, not even as a number",
  );
});

test("the color theme is a same-origin preference that returns to the same page", async () => {
  const app = openApp(env.ctx);
  const browser = new TestBrowser(app);
  assert.match(
    (await browser.get("/")).body,
    /<html lang="en" data-theme="system">/,
  );

  const chosen = await browser.request("POST", "/preferences/theme", {
    body: "theme=dark",
    headers: { referer: `${ORIGIN}/system?done=example-data&keep=1` },
  });
  assert.equal(chosen.status, 303);
  assert.equal(chosen.headers.Location, "/system?keep=1");
  const cookie = chosen.headers["Set-Cookie"] ?? "";
  assert.match(cookie, /^mn_theme=dark;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const dark = await browser.get("/");
  assert.match(dark.body, /data-theme="dark"/);
  assert.match(dark.body, /<meta\s+name="color-scheme"\s+content="dark"/);
  assert.match(dark.body, /value="dark"[^>]*aria-pressed="true"/);

  for (const referer of [
    "https://attacker.example/page",
    `${ORIGIN}//attacker.example/page`,
  ]) {
    const elsewhere = await browser.request("POST", "/preferences/theme", {
      body: "theme=light",
      headers: { referer },
    });
    assert.equal(elsewhere.headers.Location, "/", `never sent to ${referer}`);
  }
  const invalid = await browser.request("POST", "/preferences/theme", {
    body: "theme=neon",
  });
  assert.equal(invalid.status, 400);
  const crossSite = await browser.request("POST", "/preferences/theme", {
    body: "theme=dark",
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(crossSite.status, 403);
});
