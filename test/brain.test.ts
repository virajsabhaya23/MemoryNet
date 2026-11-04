import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeBrainHealth, createBrainBrief, listBrainBriefs } from "../src/brain.ts";
import { createGuardRuntime } from "../src/decision-guard/runtime.ts";
import { listMemories, listWork } from "../src/index.ts";
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

test("brain briefs are stored append-only with only resolvable citations", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await personId(env.db, "Olivia Owner");
  const copilot = await personId(env.db, "Copilot Agent");
  const payments = await idOf(env.db, "projects", "payments");
  const memories = await listMemories(env.ctx, olivia, { scope: { level: "project", id: payments }, limit: 5 });
  assert.ok(memories[0]);
  const brief = await createBrainBrief(env.ctx, olivia, {
    projectId: payments,
    agentId: copilot,
    model: "test-model",
    content: `Brief citing ${memories[0].id} and 00000000-0000-0000-0000-000000000000.`,
    citations: [memories[0].id, "00000000-0000-0000-0000-000000000000"],
  });
  assert.deepEqual(brief.citations, [memories[0].id]);
  const listed = await listBrainBriefs(env.ctx, olivia, payments);
  assert.ok(listed.some((item) => item.id === brief.id));
  await assert.rejects(
    () => env.db.query("UPDATE brain_briefs SET content = 'x' WHERE id = $1", [brief.id]),
    /append-only/,
  );
  await assert.rejects(
    () => createBrainBrief(env.ctx, copilot, { projectId: payments, agentId: copilot, model: "m", content: "x", citations: [] }),
    /Agents cannot/,
  );
});

test("guard runtime brief refuses when no model is configured", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await personId(env.db, "Olivia Owner");
  const payments = await idOf(env.db, "projects", "payments");
  const runtime = createGuardRuntime({});
  await assert.rejects(() => runtime.brief!(env.ctx, olivia, { projectId: payments }), /Connect a Meta key/);
});
