import assert from "node:assert/strict";
import { test } from "node:test";
import { listMemories, listReviewQueue, listSources } from "../src/index.ts";
import { scopeFromPath } from "../src/web/kit.ts";
import { useTestDatabase } from "./helpers.ts";
import { as, idOf, loadExample, openApp, personId, TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();

test("served stylesheet carries the Cobalt tokens and key component", async () => {
  const app = openApp(env.ctx);
  const browser = new TestBrowser(app);
  const css = await browser.get("/assets/style.css");
  assert.equal(css.status, 200);
  assert.match(css.body, /--paper:/);
  assert.match(css.body, /--accent:\s*light-dark\(oklch\(52% 0\.19 258\)/);
  assert.match(css.body, /--kind-knowledge:/);
  assert.match(css.body, /--kind-evidence:/);
  assert.match(css.body, /--kind-guidance:/);
  assert.match(css.body, /--kind-people:/);
  assert.match(css.body, /\.key-primary\s*\{[^}]*box-shadow:\s*0 3px 0/);
  assert.match(css.body, /\.ledger-row/);
  assert.match(css.body, /\.record-head/);
  assert.match(css.body, /\.stat-strip/);
  assert.match(css.body, /\.scope-tabs/);
});

test("scopeFromPath reads the scope out of app URLs", () => {
  assert.deepEqual(scopeFromPath("/projects/abc/work"), { level: "project", id: "abc" });
  assert.deepEqual(scopeFromPath("/orgs/x/network"), { level: "organization", id: "x" });
  assert.deepEqual(scopeFromPath("/business-units/u1"), { level: "business_unit", id: "u1" });
  assert.equal(scopeFromPath("/review"), null);
  assert.equal(scopeFromPath("/"), null);
  assert.equal(scopeFromPath("/system"), null);
});

test("shell shows work nav everywhere and scope context inside a project", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await as(app, env.db, "Olivia Owner");
  const home = await olivia.get("/");
  assert.match(home.body, /data-nav="work"/);
  assert.match(home.body, /href="\/review"/);
  assert.doesNotMatch(home.body, /data-nav="context"/);
  assert.doesNotMatch(home.body, /orgs\/undefined/);

  const projectId = await idOf(env.db, "projects", "payments");
  const project = await olivia.get(`/projects/${projectId}`);
  assert.match(project.body, /data-nav="context"/);
  assert.match(project.body, new RegExp(`href="/projects/${projectId}/work"`));
  assert.match(project.body, new RegExp(`href="/projects/${projectId}/search"`));
  assert.match(project.body, new RegExp(`href="/scopes/project/${projectId}/definitions"`));

  const queue = await listReviewQueue(env.ctx, await personId(env.db, "Olivia Owner"), { limit: 200 });
  if (queue.length > 0) assert.match(project.body, /data-review-count="\d+"/);
});

test("jump menu script is served as a same-origin module", async () => {
  const app = openApp(env.ctx);
  const browser = new TestBrowser(app);
  const script = await browser.get("/assets/shell.js");
  assert.equal(script.status, 200);
  assert.match(script.headers["Content-Type"] ?? "", /text\/javascript/);
});

test("project page is a tabbed workspace with ledger knowledge", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await as(app, env.db, "Olivia Owner");
  const projectId = await idOf(env.db, "projects", "payments");
  const project = await olivia.get(`/projects/${projectId}`);
  assert.match(project.body, /class="scope-tabs"/);
  assert.match(project.body, /class="record-head"/);
  assert.match(project.body, new RegExp(`href="/projects/${projectId}/work"`));
  assert.match(project.body, new RegExp(`href="/projects/${projectId}/retrievals"`));
  assert.match(project.body, /id="current-knowledge"/);
  assert.match(project.body, /class="ledger/);
});

test("memory and source pages use the record template", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await as(app, env.db, "Olivia Owner");
  const projectId = await idOf(env.db, "projects", "payments");
  const memories = await listMemories(env.ctx, await personId(env.db, "Olivia Owner"), { scope: { level: "project", id: projectId }, limit: 5 });
  assert.ok(memories[0], "example project has memories");
  const memory = await olivia.get(`/memories/${memories[0].id}`);
  assert.match(memory.body, /class="record-head"/);
  assert.match(memory.body, /\/memories\/.*\/history/);
  const sources = await listSources(env.ctx, await personId(env.db, "Olivia Owner"), { scope: { level: "project", id: projectId }, limit: 5 });
  assert.ok(sources[0], "example project has sources");
  const source = await olivia.get(`/sources/${sources[0].id}`);
  assert.match(source.body, /class="record-head"/);
});

test("review queue is a two-pane ledger", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const rhea = await as(app, env.db, "Rhea Reviewer");
  const queue = await rhea.get("/review");
  assert.match(queue.body, /class="review-layout"/);
  assert.match(queue.body, /class="review-pane/);
  assert.match(queue.body, /Waiting for your review/);
});

test("organization and business-unit pages use the record template", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await as(app, env.db, "Olivia Owner");
  const orgId = await idOf(env.db, "organizations", "acme-synthetic");
  const org = await olivia.get(`/orgs/${orgId}`);
  assert.match(org.body, /class="record-head"/);
  assert.match(org.body, /class="stat-strip"/);
  assert.doesNotMatch(org.body, /org-hero/);
  const unitId = await idOf(env.db, "business_units", "platform");
  assert.match(org.body, new RegExp(`href="/business-units/${unitId}"`));
  const unit = await olivia.get(`/business-units/${unitId}`);
  assert.match(unit.body, /class="record-head"/);
  const projectId = await idOf(env.db, "projects", "checkout");
  assert.match(unit.body, new RegExp(`href="/projects/${projectId}"`));
});

test("overview is a triage ledger, not a hero dashboard", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await as(app, env.db, "Olivia Owner");
  const home = await olivia.get("/");
  assert.doesNotMatch(home.body, /dash-hero/);
  assert.match(home.body, /class="stat-strip"/);
  assert.match(home.body, /Your organizations/);
  const orgId = await idOf(env.db, "organizations", "acme-synthetic");
  assert.match(home.body, new RegExp(`href="/orgs/${orgId}/network"`));
  assert.match(home.body, /class="ledger/);
  const queue = await listReviewQueue(env.ctx, await personId(env.db, "Olivia Owner"), { limit: 200 });
  if (queue.length > 0) {
    assert.match(home.body, /class="needs-you/);
    assert.match(home.body, /proposals? waiting/);
  }
});
