import assert from "node:assert/strict";
import { test } from "node:test";
import { useTestDatabase } from "./helpers.ts";
import { openApp, TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();

test("a new person sets up their own project from an empty database and gets a reviewed memory on the map", async () => {
  const app = openApp(env.ctx);
  const system = new TestBrowser(app);
  for (const name of ["Me Myself", "My Reviewer"]) {
    const r = await system.system("/system/principals", {
      kind: "human",
      displayName: name,
      back: "people",
    });
    assert.equal(r.status, 303, name);
  }
  const id = async (name: string) =>
    (
      await env.db.query<{ id: string }>(
        "SELECT id FROM principals WHERE display_name = $1",
        [name],
      )
    ).rows[0]!.id;
  const me = new TestBrowser(app);
  await me.signIn(await id("Me Myself"));
  const org = await me.post("/orgs", {
    name: "My Projects",
    slug: "my-projects",
  });
  assert.equal(org.status, 303, "create org");
  const orgPath = org.headers.Location!.split("?")[0]!;
  const unit = await me.post(`${orgPath}/business-units`, {
    name: "Personal",
    slug: "personal",
  });
  assert.equal(unit.status, 303, "create unit");
  const unitPath = unit.headers.Location!.split("?")[0]!;
  const project = await me.post(`${unitPath}/projects`, {
    name: "my-app",
    slug: "my-app",
  });
  assert.equal(project.status, 303, "create project");
  const projectPath = project.headers.Location!.split("?")[0]!;
  const projectId = projectPath.split("/").pop()!;
  const connect = await me.post(`${projectPath}/repositories`, {
    externalRepositoryId: "123456",
    fullName: "me/my-app",
  });
  assert.equal(connect.status, 303, `connect: ${connect.body.slice(0, 300)}`);
  const role = await me.post(`/scopes/project/${projectId}/roles`, {
    principalId: await id("My Reviewer"),
    role: "reviewer",
  });
  assert.equal(role.status, 303, `role: ${role.body.slice(0, 300)}`);
  for (const who of ["Me Myself", "My Reviewer"]) {
    const r = await system.system("/system/repository-access", {
      principalId: await id(who),
      externalRepositoryId: "123456",
      canRead: "yes",
      back: "access",
    });
    assert.equal(r.status, 303);
  }
  const pr = await system.system("/system/merged-pull-request", {
    externalRepositoryId: "123456",
    pullRequest: "7",
    title: "Use SQLite WAL mode for the local cache",
    body: "WAL avoids writer lock-ups when the sync job runs.",
    mergeCommitSha: "a".repeat(40),
    back: "overview",
  });
  assert.match(pr.headers.Location ?? "", /done=pr-captured/);
  const page = await me.get(projectPath);
  const source =
    /name="evidenceSourceIds"[^>]*value="([0-9a-f-]{36})"|value="([0-9a-f-]{36})"[^>]*name="evidenceSourceIds"/.exec(
      page.body,
    );
  assert.ok(source, "the captured pull request is offered as evidence");
  const proposed = await me.post(`/projects/${projectId}/proposals`, {
    type: "decision",
    title: "Local cache uses WAL",
    content:
      "The local cache runs SQLite in WAL mode so sync never blocks writers.",
    evidenceSourceIds: source[1] ?? source[2]!,
  });
  assert.equal(proposed.status, 303, `propose: ${proposed.body.slice(0, 300)}`);
  const proposalId = /\/proposals\/([0-9a-f-]{36})/.exec(
    proposed.headers.Location ?? "",
  )![1]!;
  const reviewer = new TestBrowser(app);
  await reviewer.signIn(await id("My Reviewer"));
  assert.match((await reviewer.get("/review")).body, /Local cache uses WAL/);
  const approved = await reviewer.post(`/proposals/${proposalId}/approve`, {
    expectedRevision: "1",
  });
  assert.equal(approved.status, 303, `approve: ${approved.body.slice(0, 300)}`);
  const net = await me.get(`${orgPath}/network`);
  assert.match(net.body, /Local cache uses WAL/);
  const you = await me.get(`${orgPath}/you`);
  assert.equal(you.status, 200);
});
