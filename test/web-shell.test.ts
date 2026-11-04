import assert from "node:assert/strict";
import { test } from "node:test";
import { useTestDatabase } from "./helpers.ts";
import { openApp, TestBrowser } from "./web-helpers.ts";

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
