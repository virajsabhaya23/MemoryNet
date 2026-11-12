import assert from "node:assert/strict";
import { test } from "node:test";
import { html, ledgerRow, recordHead, scopeTabs, statStrip } from "../src/web/html.ts";

test("statStrip renders label/value pairs as a definition strip", () => {
  const out = statStrip([["Projects", 12], ["Pending", "3"]]).__html;
  assert.match(out, /class="stat-strip"/);
  assert.match(out, /<dt>Projects<\/dt>/);
  assert.match(out, /<dd>12<\/dd>/);
});

test("ledgerRow renders a linked row with meta and trailing content", () => {
  const out = ledgerRow({ href: "/projects/1", title: "Payments", meta: "4 sources", trailing: html`<span>Owner</span>` }).__html;
  assert.match(out, /class="ledger-row"/);
  assert.match(out, /href="\/projects\/1"/);
  assert.match(out, /row-title/);
  assert.match(out, /row-meta/);
  assert.match(out, /row-trailing/);
});

test("ledgerRow escapes a plain-text title", () => {
  const out = ledgerRow({ title: "<script>alert(1)</script>" }).__html;
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
});

test("recordHead renders kind, title, status, meta and actions", () => {
  const out = recordHead({ kind: "Memory", title: "API retries", status: "Current", meta: "rev 3", actions: html`<a href="/x">Open</a>` }).__html;
  assert.match(out, /class="record-head"/);
  assert.match(out, /record-title/);
  assert.match(out, /record-meta/);
  assert.match(out, /record-actions/);
});

test("scopeTabs marks only the current tab and renders counts", () => {
  const out = scopeTabs([
    { label: "Knowledge", href: "/p#k", count: 4, current: true },
    { label: "Work", href: "/p/work" },
  ]).__html;
  assert.match(out, /class="scope-tabs"/);
  assert.equal((out.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(out, /tab-count[^>]*>4</);
});
