import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentBinding } from "../src/agent-context/binding.ts";
import { accessFreshSince, createContext } from "../src/context.ts";
import { createGitHubClient, GitHubTokenRejected, type GitHubAccount, type GitHubClient } from "../src/github.ts";
import { linkGitHubAccount } from "../src/members.ts";
import { createApp } from "../src/web/app.ts";
import { createGitHubSignIn } from "../src/web/github-sign-in.ts";
import { APP_PORT } from "../src/web/kit.ts";
import { SessionStore } from "../src/web/session.ts";
import { buildWorld, START, useTestDatabase } from "./helpers.ts";
import { TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();
const reviewer: GitHubAccount = { id: "900005", login: "synthetic-reviewer", type: "User" };

/** A scripted GitHub: approves the device code on request and answers repository checks from a table. */
function fakeGitHub(account: GitHubAccount = reviewer) {
  const state = {
    approved: false, polls: 0, rejected: false, outage: false,
    readable: new Set(["1001"]), checked: [] as string[],
  };
  const client: GitHubClient = {
    async startDeviceFlow() {
      return { deviceCode: "device-1", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresInMs: 900_000, intervalMs: 5_000 };
    },
    async pollDeviceFlow() {
      state.polls++;
      return state.approved ? { state: "authorized", token: "gho_synthetic" } : { state: "pending" };
    },
    async account() {
      if (state.rejected) throw new GitHubTokenRejected("revoked");
      return account;
    },
    async repositoryAccess(token, id) {
      assert.equal(token, "gho_synthetic");
      if (state.rejected) throw new GitHubTokenRejected("revoked");
      if (state.outage) throw new Error("GitHub is down");
      state.checked.push(id);
      return state.readable.has(id) ? "read" : "none";
    },
    async lookupAccount() { return account; },
  };
  return { client, state };
}

async function access(principalId: string) {
  const { rows } = await env.db.query<{ id: string; can_read: boolean; observed_at: Date }>(
    "SELECT external_repository_id AS id, can_read, observed_at FROM repository_access WHERE principal_id = $1 ORDER BY 1", [principalId]);
  return rows;
}

test("GitHub sign-in binds the session to the verified account and records access GitHub confirms", async () => {
  const w = await buildWorld(env.ctx);
  await env.db.exec("TRUNCATE repository_access");
  const github = fakeGitHub();
  const browser = new TestBrowser(createApp(env.ctx, { port: APP_PORT, github: { client: github.client, refreshIntervalMs: 0 } }));

  // Persona selection, the access key and System controls are gone.
  assert.equal((await browser.post("/sign-in", { principalId: w.people.ownerA.id })).status, 403);
  assert.equal((await browser.get("/system")).status, 404);

  const home = await browser.get("/");
  assert.match(home.body, /Sign in with GitHub/);
  const login = /name="_login" value="([^"]+)"/.exec(home.body)![1]!;
  assert.equal((await browser.post("/sign-in/github", { _login: "forged" })).status, 403);
  const started = await browser.post("/sign-in/github", { _login: login });
  assert.equal(started.status, 303);
  assert.equal((await browser.get("/")).body.includes("Synthetic Alpha Reviewer"), false, "a pending sign-in is not a session");

  let waiting = await browser.get("/sign-in/github");
  assert.match(waiting.body, /ABCD-1234/);
  assert.equal(github.state.polls, 0, "never polls faster than GitHub's interval");
  env.advance(5_000);
  waiting = await browser.get("/sign-in/github");
  assert.equal(github.state.polls, 1);
  assert.match(waiting.headers.Refresh ?? "", /^5; url=\/sign-in\/github$/);

  github.state.approved = true;
  env.advance(5_000);
  const done = await browser.get("/sign-in/github");
  assert.equal(done.status, 303);
  assert.match(done.headers.Location ?? "", /signed-in/);
  const signedIn = await browser.get("/");
  assert.match(signedIn.body, /Synthetic Alpha Reviewer/);
  assert.match(signedIn.body, /GitHub sign-in/);
  assert.equal(signedIn.body.includes("gho_synthetic"), false, "the token is never rendered");

  assert.deepEqual((await access(w.people.reviewer.id)).map((r) => [r.id, r.can_read]),
    [["1001", true], ["1002", false], ["1003", false], ["2001", false]]);
  assert.equal((await access(w.people.reviewer.id))[0]!.observed_at.getTime(), START.getTime() + 10_000);
});

test("an unlinked GitHub account and a planted pending-sign-in cookie do not sign anyone in", async () => {
  await buildWorld(env.ctx);
  const stranger = fakeGitHub({ id: "777", login: "stranger", type: "User" });
  stranger.state.approved = true;
  const browser = new TestBrowser(createApp(env.ctx, { port: APP_PORT, github: { client: stranger.client, refreshIntervalMs: 0 } }));
  const login = /name="_login" value="([^"]+)"/.exec((await browser.get("/")).body)![1]!;
  await browser.post("/sign-in/github", { _login: login });
  env.advance(5_000);
  const refused = await browser.get("/sign-in/github");
  assert.equal(refused.status, 403);
  assert.match(refused.body, /@stranger is not linked/);
  assert.match((await browser.get("/")).body, /Sign in with GitHub/);

  const forged = new TestBrowser(createApp(env.ctx, { port: APP_PORT, github: { client: stranger.client, refreshIntervalMs: 0 } }));
  const reply = await forged.request("GET", "/sign-in/github", { headers: { cookie: "mn_session=planted" } });
  assert.equal(reply.status, 303);
});

test("re-verification records lost access, ends rejected tokens, ignores outages and extends to the owner's agent", async () => {
  const w = await buildWorld(env.ctx);
  await env.db.exec("TRUNCATE repository_access");
  const github = fakeGitHub();
  const sessions = new SessionStore(() => env.ctx.now().getTime());
  const binding = { schemaVersion: 2, principalId: w.people.agent.id, ownerId: w.people.reviewer.id, repositoryId: "1001" } as AgentBinding;
  const signIn = createGitHubSignIn(env.ctx, sessions, "system", { client: github.client }, async () => binding);
  const session = sessions.create(w.people.reviewer.id, { token: "gho_synthetic", login: reviewer.login, userId: reviewer.id });

  await signIn.refresh();
  assert.deepEqual((await access(w.people.agent.id)).map((r) => [r.id, r.can_read]), [["1001", true]], "the agent reads only what its owner can");

  github.state.readable.clear();
  env.advance(60_000);
  await signIn.refresh();
  assert.deepEqual((await access(w.people.reviewer.id)).filter((r) => r.can_read), []);
  assert.deepEqual((await access(w.people.agent.id)).map((r) => r.can_read), [false]);

  github.state.readable.add("1001");
  github.state.outage = true;
  env.advance(60_000);
  await signIn.refresh();
  assert.equal((await access(w.people.reviewer.id)).find((r) => r.id === "1001")!.can_read, false, "an outage records nothing");
  assert.ok(sessions.find(session.token));

  github.state.outage = false;
  github.state.rejected = true;
  await signIn.refresh();
  assert.equal(sessions.find(session.token), null, "a revoked GitHub token ends the session");
});

test("with GitHub sign-in, access declared before the server started never counts", () => {
  const started = new Date(START.getTime() + 60_000);
  const ctx = createContext(env.db, { now: () => new Date(START.getTime() + 120_000), repositoryAccessMaxAgeMs: 15 * 60_000, repositoryAccessNotBefore: started });
  assert.equal(accessFreshSince(ctx).getTime(), started.getTime());
  const later = createContext(env.db, { now: () => new Date(START.getTime() + 3_600_000), repositoryAccessMaxAgeMs: 15 * 60_000, repositoryAccessNotBefore: started });
  assert.equal(accessFreshSince(later).getTime(), START.getTime() + 3_600_000 - 15 * 60_000);
});

test("GitHub is an optional connection in local mode, with independent workspace access", async () => {
  const w = await buildWorld(env.ctx);
  const github = fakeGitHub();
  const sessions = new SessionStore(() => env.ctx.now().getTime());
  const app = createApp(env.ctx, { port: APP_PORT, localPrincipalId: w.people.reviewer.id, sessions,
    github: { client: github.client, refreshIntervalMs: 0 } });
  const browser = new TestBrowser(app);
  const before = await access(w.people.reviewer.id);
  const home = await browser.get("/");
  assert.equal(home.status, 200);
  assert.match(home.body, /Synthetic Alpha Reviewer/);
  assert.doesNotMatch(home.body, /Sign in with GitHub/);
  const originalCookie = home.headers["Set-Cookie"];
  assert.match((await browser.get("/connections")).body, /Connect GitHub/);
  assert.equal((await browser.post("/connections/github", { _csrf: "forged" })).status, 403);
  assert.equal((await browser.post("/connections/github", {}, { origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await browser.post("/connections/github")).status, 303);
  assert.equal((await browser.get("/")).status, 200, "pending OAuth must not replace the local session");
  assert.match((await browser.get("/connections/github")).body, /ABCD-1234/);
  github.state.approved = true;
  env.advance(5_000);
  const connected = await browser.get("/connections/github");
  assert.equal(connected.headers.Location, "/connections");
  assert.notEqual(connected.headers["Set-Cookie"], originalCookie);
  const details = await browser.get("/connections");
  assert.match(details.body, /@synthetic-reviewer/);
  assert.match(details.body, /Disconnect GitHub/);
  assert.doesNotMatch(details.body, /gho_synthetic/);
  assert.deepEqual(await access(w.people.reviewer.id), before, "account connection does not rewrite local repository access");

  const service = createGitHubSignIn(env.ctx, sessions, "unused", { client: github.client }, undefined, w.people.reviewer.id);
  github.state.rejected = true;
  await service.refresh();
  assert.equal(sessions.active().length, 1, "revoking GitHub does not revoke local access");
  assert.equal(sessions.active()[0]!.github, undefined);
  assert.equal((await browser.get("/")).status, 200);
  github.state.rejected = false;
  await browser.get("/connections");
  await browser.post("/connections/github");
  env.advance(5_000);
  await browser.get("/connections/github");
  await browser.get("/connections");
  const disconnected = await browser.post("/connections/github/disconnect");
  assert.equal(disconnected.status, 303);
  assert.equal(sessions.active()[0]!.github, undefined);
  assert.equal((await browser.get("/")).status, 200);
});

test("connecting someone else's GitHub account never changes the local operator", async () => {
  const w = await buildWorld(env.ctx);
  const github = fakeGitHub();
  github.state.approved = true;
  const sessions = new SessionStore();
  const browser = new TestBrowser(createApp(env.ctx, { port: APP_PORT, localPrincipalId: w.people.ownerA.id, sessions,
    github: { client: github.client, refreshIntervalMs: 0 } }));
  await browser.get("/connections");
  await browser.post("/connections/github");
  env.advance(5_000);
  const refused = await browser.get("/connections/github");
  assert.equal(refused.status, 403);
  assert.match(refused.body, /not linked to your local operator/);
  assert.equal(refused.headers["Set-Cookie"], undefined, "connection failure keeps local session");
  assert.match((await browser.get("/")).body, /Synthetic Owner A/);
  assert.equal(sessions.active()[0]!.principalId, w.people.ownerA.id);
  assert.equal(sessions.active()[0]!.github, undefined);
});

test("linking a GitHub account is explicit, idempotent and never silently relinks", async () => {
  const w = await buildWorld(env.ctx);
  const [person] = (await env.db.query<{ id: string }>(
    "INSERT INTO principals (kind, display_name, created_at) VALUES ('human', 'Unlinked Person', now()) RETURNING id")).rows;
  assert.deepEqual(await linkGitHubAccount(env.ctx, { principalId: person!.id, githubUserId: "12345" }), { changed: true });
  assert.deepEqual(await linkGitHubAccount(env.ctx, { principalId: person!.id, githubUserId: "12345" }), { changed: false });
  await assert.rejects(linkGitHubAccount(env.ctx, { principalId: person!.id, githubUserId: "67890" }), /different GitHub account/);
  await assert.rejects(linkGitHubAccount(env.ctx, { principalId: w.people.outsider.id, githubUserId: "12345" }), /different GitHub account/);
  await assert.rejects(linkGitHubAccount(env.ctx, { principalId: w.people.agent.id, githubUserId: "55555" }), /Only people/);
  const audit = await env.db.query("SELECT 1 FROM audit_events WHERE action = 'principal.github_linked' AND target_id = $1", [person!.id]);
  assert.equal(audit.rows.length, 1);
});

test("the GitHub client maps device-flow and permission answers, and treats outages as no answer", async () => {
  const replies: Array<[number, unknown, Record<string, string>?]> = [];
  const requests: string[] = [];
  const client = createGitHubClient({
    clientId: "Iv1.0123456789abcdef",
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      const [status, body, headers] = replies.shift()!;
      return new Response(JSON.stringify(body), { status, headers });
    }) as typeof fetch,
  });
  assert.throws(() => createGitHubClient({ clientId: "bad id!" }), /client ID/);

  replies.push([200, { device_code: "d", user_code: "WXYZ-0001", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 }]);
  assert.equal((await client.startDeviceFlow()).intervalMs, 5_000, "never polls faster than every five seconds");
  for (const [body, expected] of [
    [{ error: "authorization_pending" }, { state: "pending" }],
    [{ error: "slow_down", interval: 10 }, { state: "pending", intervalMs: 10_000 }],
    [{ error: "access_denied" }, { state: "denied" }],
    [{ error: "expired_token" }, { state: "expired" }],
    [{ access_token: "gho_x", token_type: "bearer" }, { state: "authorized", token: "gho_x" }],
  ] as const) {
    replies.push([200, body]);
    assert.deepEqual(await client.pollDeviceFlow("d"), expected);
  }

  replies.push([200, { id: 1001, permissions: { pull: true } }]);
  assert.equal(await client.repositoryAccess("t", "1001"), "read");
  replies.push([200, { id: 1001, permissions: { pull: false } }]);
  assert.equal(await client.repositoryAccess("t", "1001"), "none");
  replies.push([200, { id: 9999, permissions: { pull: true } }]);
  assert.equal(await client.repositoryAccess("t", "1001"), "none", "a different repository is not this one");
  replies.push([404, {}]);
  assert.equal(await client.repositoryAccess("t", "1001"), "none");
  replies.push([401, {}]);
  await assert.rejects(client.repositoryAccess("t", "1001"), GitHubTokenRejected);
  replies.push([403, {}, { "x-ratelimit-remaining": "0" }]);
  await assert.rejects(client.repositoryAccess("t", "1001"), /could not check/);
  replies.push([502, {}]);
  await assert.rejects(client.repositoryAccess("t", "1001"), /could not check/);
  await assert.rejects(client.repositoryAccess("t", "../user"), /Invalid GitHub repository ID/);
  assert.ok(requests.every((r) => /^(POST https:\/\/github\.com\/login\/|GET https:\/\/api\.github\.com\/repositories\/1001$)/.test(r)), requests.join("\n"));
});
