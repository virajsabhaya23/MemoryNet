import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorld, useTestDatabase } from "./helpers.ts";
import { TestBrowser } from "./web-helpers.ts";
import { createApp } from "../src/web/app.ts";
import { resolveAccessMode } from "../src/web/access-mode.ts";
import { SessionStore } from "../src/web/session.ts";

const env = useTestDatabase();

test("a fresh browser opens the local workspace and deep links without sign-in", async () => {
  const w = await buildWorld(env.ctx);
  const sessions = new SessionStore(() => env.ctx.now().getTime());
  const app = createApp(env.ctx, { port: 3050, localPrincipalId: w.people.ownerA.id, sessions });
  const browser = new TestBrowser(app);
  const home = await browser.get("/");
  assert.equal(home.status, 200);
  assert.match(home.body, /Synthetic Owner A/);
  assert.match(home.body, /Local workspace/);
  assert.match(home.body, /href="\/connections"/);
  assert.doesNotMatch(home.body, /name="accessKey"|action="\/sign-in|action="\/sign-out|Switch person|href="\/system"/);
  assert.match(home.headers["Set-Cookie"]!, /HttpOnly; SameSite=Strict/);
  const cookie = home.headers["Set-Cookie"]!.split(";")[0]!;
  const session = sessions.find(cookie.split("=")[1])!;
  assert.equal(session.principalId, w.people.ownerA.id);
  assert.equal((await browser.get("/")).headers["Set-Cookie"], undefined, "reuse an existing local session");
  const review = await new TestBrowser(app).get("/review");
  assert.equal(review.status, 200, "deep links also bootstrap local access");
  assert.equal((await browser.get("/connections")).status, 200);
  assert.match((await browser.get("/connections")).body, /MEMORYNET_AUTH_MODE=local/,
    "enabling the optional connection must not flip the workspace into GitHub sign-in mode");
  assert.equal((await browser.get("/system")).status, 404);
  assert.equal((await browser.post("/sign-in", { principalId: w.people.reviewer.id })).status, 403);
  assert.equal((await browser.post("/sign-out", { _csrf: session.csrfToken })).status, 403);

  const attackerSession = sessions.create(w.people.ownerB.id);
  const forged = await new TestBrowser(app).request("GET", "/", { headers: { cookie: `mn_session=${attackerSession.token}` } });
  assert.match(forged.body, /Synthetic Owner A/);
  assert.doesNotMatch(forged.body, /Synthetic Owner B/);
  assert.notEqual(forged.headers["Set-Cookie"]?.split(";")[0], `mn_session=${attackerSession.token}`);
  env.advance(13 * 60 * 60 * 1000);
  const reopened = await browser.get("/");
  assert.equal(reopened.status, 200);
  assert.notEqual(reopened.headers["Set-Cookie"]?.split(";")[0], cookie, "expiry creates a fresh session without a login gate");
});

test("automatic local access preserves origin, CSRF, role and agent boundaries", async () => {
  const w = await buildWorld(env.ctx);
  const sessions = new SessionStore();
  const app = createApp(env.ctx, { port: 3050, localPrincipalId: w.people.ownerA.id, sessions });
  const browser = new TestBrowser(app);
  const fields = { name: "Local workspace test", slug: "local-workspace-test" };
  assert.equal((await browser.post("/orgs", fields)).status, 403, "a direct POST cannot bootstrap a mutation");
  assert.equal(sessions.active().length, 0);
  const foreign = await browser.request("GET", "/", { headers: { host: "attacker.invalid" } });
  assert.equal(foreign.status, 421);
  assert.equal(sessions.active().length, 0);
  await browser.get("/");
  const session = sessions.active()[0]!;
  assert.equal((await browser.post("/orgs", { ...fields, _csrf: session.csrfToken }, { origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await browser.post("/orgs", { ...fields, _csrf: "forged" })).status, 403);
  assert.equal((await browser.post("/orgs", { ...fields, _csrf: session.csrfToken })).status, 303);
  assert.equal((await browser.get(`/orgs/${w.orgB.id}`)).status, 404, "inaccessible organizations stay hidden");

  const unavailable = new TestBrowser(createApp(env.ctx, { port: 3050, localPrincipalId: "00000000-0000-4000-8000-000000000000" }));
  assert.equal((await unavailable.get("/")).status, 503);
  const agent = new TestBrowser(createApp(env.ctx, { port: 3050, localPrincipalId: w.people.agent.id }));
  assert.equal((await agent.get("/")).status, 503, "an agent cannot become the local operator");
});

test("new local workspaces open directly and existing login gates survive upgrades", () => {
  assert.equal(resolveAccessMode(undefined, true), "local");
  assert.equal(resolveAccessMode("", true), "local");
  assert.equal(resolveAccessMode(undefined, false), "sandbox");
  assert.equal(resolveAccessMode("github", true), "github");
  assert.equal(resolveAccessMode("access-key", true), "access-key");
  assert.equal(resolveAccessMode(undefined, true, { accessKey: true }), "access-key");
  assert.equal(resolveAccessMode(undefined, true, { github: true }), "github");
  assert.equal(resolveAccessMode(undefined, false, { github: true }), "github");
  assert.equal(resolveAccessMode(undefined, true, { github: true, accessKey: true }), "github");
  assert.equal(resolveAccessMode("local", true, { github: true, accessKey: true }), "local");
  assert.throws(() => resolveAccessMode("local", false), /configured operator/);
  assert.throws(() => resolveAccessMode("typo", true), /MEMORYNET_AUTH_MODE/);
});
