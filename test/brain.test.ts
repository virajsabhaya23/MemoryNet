import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeBrainHealth } from "../src/brain.ts";
import { listWork } from "../src/index.ts";
import { useTestDatabase } from "./helpers.ts";
import { idOf, loadExample, openApp, personId } from "./web-helpers.ts";

const env = useTestDatabase();

test("brain health reports only readable scopes with actionable links", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await personId(env.db, "Olivia Owner");
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const findings = await analyzeBrainHealth(env.ctx, olivia, { organizationId: acme });
  assert.ok(findings.length > 0, "example org produces findings");
  for (const finding of findings) {
    assert.ok(finding.count > 0, `${finding.kind} has a positive count`);
    assert.ok(finding.href.startsWith("/"), `${finding.kind} links inside the app`);
    assert.ok(finding.label.length > 0);
  }
  const stale = findings.filter((finding) => finding.kind === "stale_work");
  const payments = await idOf(env.db, "projects", "payments");
  const expectedStale = (await listWork(env.ctx, olivia, payments))
    .filter((item) => item.contextStatus === "review_needed").length;
  const paymentsStale = stale.find((finding) => finding.projectId === payments);
  if (expectedStale > 0) assert.equal(paymentsStale?.count, expectedStale);
  else assert.equal(paymentsStale, undefined);
});

test("brain health can be scoped to one project", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await personId(env.db, "Olivia Owner");
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const payments = await idOf(env.db, "projects", "payments");
  const findings = await analyzeBrainHealth(env.ctx, olivia, { organizationId: acme, projectId: payments });
  assert.ok(findings.every((finding) => finding.projectId === payments || finding.projectId === null));
});
