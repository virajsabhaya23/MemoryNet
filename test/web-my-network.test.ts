import assert from "node:assert/strict";
import { test } from "node:test";
import { useTestDatabase } from "./helpers.ts";
import { as, idOf, loadExample, openApp } from "./web-helpers.ts";

const env = useTestDatabase();

function dataBlock(body: string): Record<string, unknown> {
  const match =
    /<script type="application\/json" id="myn-data">([\s\S]*?)<\/script>/.exec(
      body,
    );
  if (!match?.[1]) throw new Error("The page has no data block");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

test("Your network draws the viewer's places with same-origin scripts and opens places from this site only", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const checkout = await idOf(env.db, "projects", "checkout");
  const olivia = await as(app, env.db, "Olivia Owner");
  const page = await olivia.get(`/orgs/${acme}/you`);
  assert.equal(page.status, 200);
  const policy = page.headers["Content-Security-Policy"] ?? "";
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /connect-src 'self'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  assert.match(
    page.body,
    /<script type="module" src="\/assets\/my-network\.js"><\/script>/,
  );
  for (const name of [
    "Platform",
    "Support Tools",
    "Checkout",
    "Payments",
    "Helpdesk",
  ]) {
    assert.match(
      page.body,
      new RegExp(`aria-label="[^"]*: ${name}\\.`),
      `${name} is drawn`,
    );
  }
  assert.match(
    page.body,
    /<body class="immersive">/,
    "the map fills the window beside a compact rail",
  );
  assert.match(page.body, /<canvas[^>]*id="myn-canvas"[^>]*tabindex="0"/);
  assert.match(
    page.body,
    /<nav class="myn-places" id="myn-places" aria-label="Places on the map">/,
    "every drawn place is also a link the keyboard and screen readers reach",
  );
  assert.match(
    page.body,
    /Show your access as a list/,
    "a list works without the diagram",
  );
  const data = dataBlock(page.body);
  assert.equal(data.endpoint, `/orgs/${acme}/you/places/`);
  assert.equal(data.folded, false);
  const places = data.places as Record<string, { access: string; total: number }>;
  assert.ok(
    Object.values(places).every((place) => typeof place.total === "number"),
    "each place says how much it holds, to size its hub",
  );

  const opened = await olivia.get(
    `/orgs/${acme}/you/places/${encodeURIComponent(`project:${checkout}`)}`,
  );
  assert.equal(opened.status, 200);
  assert.match(opened.headers["Content-Type"] ?? "", /^application\/json/);
  const contents = JSON.parse(opened.body) as {
    items: Array<{ family: string; href: string }>;
    more: number;
  };
  assert.ok(contents.items.length > 0 && contents.items.length <= 40);
  assert.ok(
    contents.items.some((item) => item.family === "know"),
    "memories come with the project",
  );
  assert.ok(
    contents.items.every((item) => item.href.startsWith("/")),
    "links stay on this site",
  );

  for (const script of [
    "my-network.js",
    "my-network-view.js",
    "graph-engine.js",
    "network-view.js",
  ]) {
    const asset = await olivia.get(`/assets/${script}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers["Content-Type"] ?? "", /javascript/);
  }
});

test("a Checkout reader's network never mentions places they cannot see, and hidden places read as missing", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const payments = await idOf(env.db, "projects", "payments");
  const rudy = await as(app, env.db, "Rudy Reader");
  const page = await rudy.get(`/orgs/${acme}/you`);
  assert.equal(page.status, 200);
  for (const hidden of ["Payments", "Helpdesk", "Support Tools", payments]) {
    assert.ok(!page.body.includes(hidden), `the page never mentions ${hidden}`);
  }
  assert.match(
    page.body,
    />reader<[\s\S]{0,40}of\s+<strong>Checkout<\/strong>/,
  );

  const missing = await rudy.get(
    `/orgs/${acme}/you/places/${encodeURIComponent(`project:${payments}`)}`,
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: "Not found" });

  const oscar = await as(app, env.db, "Oscar Outsider");
  assert.equal((await oscar.get(`/orgs/${acme}/you`)).status, 404);
});

test("the home and organization pages lead to Your network", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const olivia = await as(app, env.db, "Olivia Owner");
  const link = new RegExp(`href="/orgs/${acme}/you"\\s*>\\s*Your network`);
  assert.match((await olivia.get("/")).body, link);
  assert.match((await olivia.get(`/orgs/${acme}`)).body, link);
});
