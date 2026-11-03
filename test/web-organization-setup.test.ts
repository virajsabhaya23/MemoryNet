import assert from "node:assert/strict";
import { test } from "node:test";
import { useTestDatabase } from "./helpers.ts";
import {
  as,
  idOf,
  loadExample,
  openApp,
  personId,
  TestBrowser,
} from "./web-helpers.ts";

const env = useTestDatabase();

async function orgCount(): Promise<number> {
  const { rows } = await env.db.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM organizations",
  );
  return rows[0]?.count ?? 0;
}

test("the app answers only on localhost and sends protective headers", async () => {
  const app = openApp(env.ctx);
  const browser = new TestBrowser(app);
  const foreign = await browser.request("GET", "/", {
    headers: { host: "memorynet.example.com" },
  });
  assert.equal(foreign.status, 421);

  const start = await browser.get("/");
  assert.equal(start.status, 200);
  assert.match(
    start.headers["Content-Security-Policy"] ?? "",
    /default-src 'none'/,
  );
  assert.equal(start.headers["X-Frame-Options"], "DENY");
  assert.equal(start.headers["Cache-Control"], "no-store");
  assert.match(start.body, /No people yet/);

  const css = await browser.get("/assets/style.css");
  assert.equal(css.status, 200);
  assert.match(css.headers["Content-Type"] ?? "", /text\/css/);
});

test("the sign-in picker is a local stand-in that starts a fresh HttpOnly session", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const browser = new TestBrowser(app);
  const picker = await browser.get("/");
  assert.match(picker.body, /Choose who you are/);
  assert.match(picker.body, /Olivia Owner/);
  assert.match(picker.body, /owner of Acme \(synthetic\) \(organization\)/);
  assert.match(picker.body, /Copilot Agent/);
  // Each person is a one-click card grouped by how wide their role is; no separate Continue step.
  const oliviaId = await personId(env.db, "Olivia Owner");
  assert.match(
    picker.body,
    new RegExp(`<button\\s+type="submit"\\s+name="principalId"\\s+value="${oliviaId}"`),
  );
  assert.match(picker.body, /Organization-wide/);
  assert.match(picker.body, /Agents/);
  assert.doesNotMatch(picker.body, /type="radio" name="principalId"/);
  assert.doesNotMatch(picker.body, />Continue</);

  const signIn = await browser.post("/sign-in", {
    principalId: await personId(env.db, "Olivia Owner"),
  });
  assert.equal(signIn.status, 303);
  const cookie = signIn.headers["Set-Cookie"] ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const home = await browser.get("/");
  assert.match(home.body, /Acme \(synthetic\)/);
  assert.match(home.body, /Switch person/);
  assert.doesNotMatch(home.body, /Globex/, "other organizations stay hidden");

  await browser.post("/sign-out");
  assert.match((await browser.get("/")).body, /Choose who you are/);

  const unknown = await browser.post("/sign-in", { principalId: "nobody" });
  assert.equal(unknown.status, 400);
});

test("forms from other sites, or without the page token, are refused", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await as(app, env.db, "Olivia Owner");
  const before = await orgCount();
  const fields = { name: "Synthetic Refused", slug: "synthetic-refused" };

  const crossSite = await olivia.post("/orgs", fields, {
    origin: "https://attacker.example",
  });
  assert.equal(crossSite.status, 403);
  const noOrigin = await olivia.post("/orgs", fields, { origin: undefined });
  assert.equal(noOrigin.status, 403);
  const noToken = await olivia.post("/orgs", { ...fields, _csrf: "" });
  assert.equal(noToken.status, 403);
  const systemWithoutToken = await olivia.post("/system/principals", {
    kind: "human",
    displayName: "Synthetic Intruder",
  });
  assert.equal(systemWithoutToken.status, 403);
  assert.equal(await orgCount(), before);

  const accepted = await olivia.post("/orgs", fields);
  assert.equal(accepted.status, 303);
  assert.equal(await orgCount(), before + 1);
});

test("example data loads only into an empty database", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const again = await new TestBrowser(app).system("/system/example-data");
  assert.equal(again.status, 409);
  assert.match(again.body, /npm run app:reset/);
});

test("administrators build the structure and give roles; others cannot", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const checkout = await idOf(env.db, "projects", "checkout");
  const adam = await as(app, env.db, "Adam Admin");

  const orgPage = await adam.get(`/orgs/${acme}`);
  assert.match(orgPage.body, /Create a business unit/);
  assert.match(
    orgPage.body,
    /Only an owner can change\s+this\s+role/,
    "administrators are not offered controls for the owner",
  );
  const unit = await adam.post(`/orgs/${acme}/business-units`, {
    name: "Research",
    slug: "research",
  });
  assert.equal(unit.status, 303);
  const unitPage = await adam.get(unit.headers.Location ?? "");
  assert.match(unitPage.body, /Research/);
  const unitId = await idOf(env.db, "business_units", "research");
  const created = await adam.post(`/business-units/${unitId}/projects`, {
    name: "Lab",
    slug: "lab",
  });
  assert.equal(created.status, 303);

  const rudyId = await personId(env.db, "Rudy Reader");
  const promote = await adam.post(`/scopes/project/${checkout}/roles`, {
    principalId: rudyId,
    role: "contributor",
  });
  assert.equal(promote.status, 303);
  assert.match((await adam.get(`/projects/${checkout}`)).body, /Rudy Reader/);

  const makeAdmin = await adam.post(`/scopes/project/${checkout}/roles`, {
    principalId: rudyId,
    role: "administrator",
  });
  assert.equal(makeAdmin.status, 403, "only owners manage administrators");

  const rudy = await as(app, env.db, "Rudy Reader");
  const rudyOrg = await rudy.get(`/orgs/${acme}`);
  assert.equal(rudyOrg.status, 200);
  assert.doesNotMatch(rudyOrg.body, /Create a business unit/);
  assert.doesNotMatch(rudyOrg.body, /Members at this level/);
  const refused = await rudy.post(`/orgs/${acme}/business-units`, {
    name: "Rogue",
    slug: "rogue",
  });
  assert.equal(refused.status, 404, "no organization role reads as not found");
  const selfPromotion = await rudy.post(`/scopes/project/${checkout}/roles`, {
    principalId: rudyId,
    role: "reviewer",
  });
  assert.equal(selfPromotion.status, 403);
});

test("people without a role see nothing, and removing a role hides the project at once", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const checkout = await idOf(env.db, "projects", "checkout");

  const oscar = await as(app, env.db, "Oscar Outsider");
  assert.match((await oscar.get("/")).body, /You have no roles/);
  assert.equal((await oscar.get(`/orgs/${acme}`)).status, 404);
  assert.equal((await oscar.get(`/projects/${checkout}`)).status, 404);

  const rudy = await as(app, env.db, "Rudy Reader");
  const project = await rudy.get(`/projects/${checkout}`);
  assert.match(project.body, /Retry card authorization at most 3 times/);
  assert.match(project.body, /pull\/11/);
  assert.doesNotMatch(
    project.body,
    /Keep the session cache in checkout/,
    "pending proposals are not knowledge",
  );
  assert.doesNotMatch(project.body, /GitHub repositories/);

  const adam = await as(app, env.db, "Adam Admin");
  const removed = await adam.post(`/scopes/project/${checkout}/roles/revoke`, {
    principalId: await personId(env.db, "Rudy Reader"),
    reason: "Moved to another team",
  });
  assert.equal(removed.status, 303);
  assert.equal((await rudy.get(`/projects/${checkout}`)).status, 404);
});

test("losing GitHub access, or the repository leaving the App, hides sources and memories", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const rudy = await as(app, env.db, "Rudy Reader");
  const system = new TestBrowser(app);

  const lost = await system.system("/system/repository-access", {
    principalId: await personId(env.db, "Rudy Reader"),
    externalRepositoryId: "1001",
    canRead: "no",
  });
  assert.equal(lost.status, 303);
  const hidden = await rudy.get(`/projects/${checkout}`);
  assert.match(hidden.body, /No current knowledge you can read here/);
  assert.match(hidden.body, /No sources you can read here/);

  const cody = await as(app, env.db, "Cody Contributor");
  assert.match(
    (await cody.get(`/projects/${checkout}`)).body,
    /Retry card authorization/,
  );
  const removal = await system.system("/system/repository-removed", {
    externalRepositoryId: "1001",
  });
  assert.match(removal.headers.Location ?? "", /done=repo-removed$/);
  assert.match(
    (await cody.get(`/projects/${checkout}`)).body,
    /No current knowledge you can read here/,
  );
});

test("administrators connect and disconnect repositories from the project page", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const helpdesk = await idOf(env.db, "projects", "helpdesk");
  const adam = await as(app, env.db, "Adam Admin");

  const connected = await adam.post(`/projects/${helpdesk}/repositories`, {
    externalRepositoryId: "1004",
    fullName: "acme-synthetic/shared-docs",
  });
  assert.equal(connected.status, 303);
  const withRepository = await adam.get(`/projects/${helpdesk}`);
  assert.match(withRepository.body, /acme-synthetic\/shared-docs/);

  const again = await adam.post(`/projects/${helpdesk}/repositories`, {
    externalRepositoryId: "1004",
    fullName: "acme-synthetic/shared-docs",
  });
  assert.equal(
    again.status,
    409,
    "a repository belongs to one project at a time",
  );

  const { rows } = await env.db.query<{ id: string }>(
    "SELECT id FROM repository_connections WHERE external_repository_id = '1004'",
  );
  const disconnected = await adam.post(
    `/repositories/${rows[0]?.id}/disconnect`,
    { reason: "Synthetic test finished" },
  );
  assert.equal(disconnected.status, 303);
  assert.match(
    (await adam.get(`/projects/${helpdesk}`)).body,
    /Synthetic test finished/,
  );

  const rhea = await as(app, env.db, "Rhea Reviewer");
  const checkout = await idOf(env.db, "projects", "checkout");
  const refused = await rhea.post(`/projects/${checkout}/repositories`, {
    externalRepositoryId: "1004",
    fullName: "acme-synthetic/shared-docs",
  });
  assert.equal(refused.status, 403);
});

test("text people type is shown as text, never run as markup", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await as(app, env.db, "Olivia Owner");
  const created = await olivia.post("/orgs", {
    name: '<script>alert("x")</script>',
    slug: "synthetic-escaped",
  });
  const orgPage = await olivia.get(created.headers.Location ?? "");
  assert.doesNotMatch(orgPage.body, /<script>alert/);
  assert.match(
    orgPage.body,
    /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/,
  );
});
