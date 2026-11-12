import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, suspendMemory, type Database } from "../src/index.ts";
import { ACCESS_MAX_AGE_MS, useTestDatabase } from "./helpers.ts";
import { as, idOf, loadExample, openApp, personId } from "./web-helpers.ts";

const env = useTestDatabase();

function searchPath(projectId: string, query: string): string {
  return `/projects/${projectId}/search?q=${encodeURIComponent(query)}`;
}

async function memoryId(title: string): Promise<string> {
  const { rows } = await env.db.query<{ memory_id: string }>(
    "SELECT memory_id FROM memory_revisions WHERE title = $1",
    [title],
  );
  if (!rows[0]) throw new Error(`No memory titled ${title}`);
  return rows[0].memory_id;
}

test("a search shows current knowledge with its evidence, and the search log records it", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const rudy = await as(app, env.db, "Rudy Reader");
  const project = await rudy.get(`/projects/${checkout}`);
  assert.match(
    project.body,
    new RegExp(`action="/projects/${checkout}/search"`),
    "every project page has the search box",
  );

  const reply = await rudy.get(searchPath(checkout, "card retries"));
  assert.equal(reply.status, 200);
  assert.match(reply.body, /Retry card authorization at most 3 times/);
  assert.match(reply.body, /exponential backoff between attempts/);
  assert.match(reply.body, /version 1/);
  assert.match(
    reply.body,
    /href="https:\/\/github\.com\/acme-synthetic\/checkout-service\/pull\/11"/,
  );
  assert.match(reply.body, /unbounded retries filled the payment queue/);
  assert.match(
    reply.body,
    /Recorded at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC as retrieval/,
  );

  const log = await rudy.get(`/projects/${checkout}/retrievals`);
  assert.equal(log.status, 200);
  assert.match(log.body, /Your searches/);
  assert.match(log.body, /Rudy Reader/);
  assert.match(log.body, /card, retri/);
  assert.match(log.body, /Retry card authorization at most 3 times/);
});

test("hidden projects and their knowledge never reach the search page or the log", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const payments = await idOf(env.db, "projects", "payments");
  const rudy = await as(app, env.db, "Rudy Reader");
  assert.equal((await rudy.get(searchPath(payments, "SDK"))).status, 404);
  assert.equal(
    (await rudy.get(`/projects/${payments}/retrievals`)).status,
    404,
  );
  const sdk = await rudy.get(searchPath(checkout, "card SDK version"));
  assert.doesNotMatch(sdk.body, /Payments/, "no hidden name, anywhere");
  assert.doesNotMatch(sdk.body, /4\.2/);

  const oscar = await as(app, env.db, "Oscar Outsider");
  assert.equal((await oscar.get(searchPath(checkout, "retry"))).status, 404);
});

test("suspended knowledge is listed as not current, without its text", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  await suspendMemory(env.ctx, await personId(env.db, "Cody Contributor"), {
    memoryId: await memoryId("Unbounded retries overloaded the payment queue"),
    expectedRevision: 1,
    reason: "Load test numbers are being rechecked",
  });
  const rudy = await as(app, env.db, "Rudy Reader");
  const reply = await rudy.get(searchPath(checkout, "payment queue"));
  assert.match(
    reply.body,
    /Matches that are not current[\s\S]*Unbounded retries overloaded the payment queue[\s\S]*suspended[\s\S]*Load test numbers are being rechecked/,
  );
  assert.doesNotMatch(
    reply.body,
    /Do not remove the retry limit/,
    "suspended guidance is never shown as text to follow",
  );
});

test("finding nothing, a refused search, and a failed search say different things", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const rudy = await as(app, env.db, "Rudy Reader");
  const none = await rudy.get(searchPath(checkout, "zebra"));
  assert.equal(none.status, 200);
  assert.match(none.body, /No current knowledge matched/);
  assert.match(none.body, /does not mean no earlier decision exists/);

  const common = await rudy.get(searchPath(checkout, "the"));
  assert.equal(common.status, 400);
  assert.match(common.body, /at least one word/);

  const db = env.db;
  const broken: Database = {
    query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params),
    exec: (sql: string) => db.exec(sql),
    transaction: async () => {
      throw new Error("Synthetic database outage");
    },
    close: async () => undefined,
  };
  const outage = openApp(
    createContext(broken, {
      now: () => env.ctx.now(),
      repositoryAccessMaxAgeMs: ACCESS_MAX_AGE_MS,
    }),
  );
  const failed = await (
    await as(outage, env.db, "Rudy Reader")
  ).get(searchPath(checkout, "retry"));
  assert.equal(failed.status, 503);
  assert.match(failed.body, /Search failed, so nothing was searched/);
  assert.doesNotMatch(failed.body, /No current knowledge matched/);

  const log = await rudy.get(`/projects/${checkout}/retrievals`);
  assert.match(log.body, /failed[\s\S]*nothing was searched/);
});

test("administrators see everyone's searches; others see only their own", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const checkout = await idOf(env.db, "projects", "checkout");
  const rudy = await as(app, env.db, "Rudy Reader");
  await rudy.get(searchPath(checkout, "retry"));
  const cody = await as(app, env.db, "Cody Contributor");
  await cody.get(searchPath(checkout, "queue"));

  const own = await cody.get(`/projects/${checkout}/retrievals`);
  assert.match(own.body, /Your searches/);
  assert.match(own.body, /Cody Contributor/);
  assert.doesNotMatch(own.body, /Rudy Reader/);

  for (const name of ["Adam Admin", "Olivia Owner"]) {
    const admin = await as(app, env.db, name);
    const log = await admin.get(`/projects/${checkout}/retrievals`);
    assert.match(log.body, /Everyone&#39;s searches/);
    assert.match(log.body, /Cody Contributor/);
    assert.match(log.body, /Rudy Reader/);
  }
});
