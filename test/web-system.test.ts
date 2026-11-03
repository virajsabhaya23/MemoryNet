import assert from "node:assert/strict";
import { test } from "node:test";
import { useTestDatabase } from "./helpers.ts";
import { loadExample, openApp, TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();

test("the System console shows one section at a time, with the everyday event first", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const system = new TestBrowser(app);

  const overview = await system.get("/system");
  assert.equal(overview.status, 200);
  for (const tab of [
    "Overview",
    "People",
    "Repository access",
    "GitHub events",
    "Check preview",
  ]) {
    assert.match(overview.body, new RegExp(`>${tab}</a`), `${tab} is a tab`);
  }
  assert.match(overview.body, /aria-current="page"\s*>Overview</);
  assert.match(overview.body, /A pull request was merged/);
  assert.match(overview.body, /Captured by the GitHub App/);
  assert.match(
    overview.body,
    /Add a person or agent/,
    "a fresh setup always has its first step",
  );
  assert.doesNotMatch(
    overview.body,
    /Report a change in access|Repository removed from the GitHub App/,
    "other sections wait on their own tabs",
  );

  const people = await system.get("/system?tab=people&q=rhea");
  assert.match(people.body, /Rhea Reviewer/);
  assert.doesNotMatch(people.body, /Olivia Owner/, "search narrows the list");
  assert.match(people.body, /Add a person or agent/);

  const nobody = await system.get("/system?tab=people&q=%25_");
  assert.match(nobody.body, /Nobody matches that name/, "% and _ are literal");

  const access = await system.get("/system?tab=access");
  assert.match(access.body, /Access reported by GitHub/);
  assert.match(access.body, /Report a change in access/);

  const github = await system.get("/system?tab=github");
  assert.match(github.body, /Repository removed from the GitHub App/);

  const unknown = await system.get("/system?tab=nonsense");
  assert.match(unknown.body, /aria-current="page"\s*>Overview</);
});

test("System forms return to the tab they were sent from", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const system = new TestBrowser(app);
  const added = await system.system("/system/principals", {
    kind: "human",
    displayName: "Tess Tabs",
    back: "people",
  });
  assert.equal(added.status, 303);
  assert.equal(
    added.headers.Location,
    "/system?tab=people&done=principal-created",
  );
  const elsewhere = await system.system("/system/principals", {
    kind: "human",
    displayName: "Otto Overview",
    back: "https://example.com",
  });
  assert.equal(
    elsewhere.headers.Location,
    "/system?done=principal-created",
    "an unknown tab goes back to the overview, never elsewhere",
  );
});

test("the people list is paged, so organization-sized data stays small", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const system = new TestBrowser(app);
  for (let index = 0; index < 55; index += 1) {
    await system.system("/system/principals", {
      kind: "human",
      displayName: `Paged Person ${String(index).padStart(2, "0")}`,
    });
  }
  const first = await system.get("/system?tab=people&q=Paged");
  assert.match(first.body, /Page 1 of 2/);
  assert.match(first.body, /Paged Person 49/);
  assert.doesNotMatch(first.body, /Paged Person 50/);
  assert.match(
    first.body,
    /href="\/system\?tab=people&amp;q=Paged&amp;page=2"/,
  );
  const second = await system.get("/system?tab=people&q=Paged&page=2");
  assert.match(second.body, /Paged Person 54/);
  assert.match(second.body, /Page 2 of 2/);
});
