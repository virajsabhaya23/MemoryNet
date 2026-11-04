import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrainBrief } from "../src/brain.ts";
import { listMemories } from "../src/index.ts";
import { createApp } from "../src/web/app.ts";
import { APP_PORT } from "../src/web/kit.ts";
import type { DecisionGuardWebRuntime } from "../src/decision-guard/runtime.ts";
import { useTestDatabase } from "./helpers.ts";
import { as, idOf, loadExample, personId, TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();

test("project page shows the Brain panel with health findings", async () => {
  const { openApp } = await import("./web-helpers.ts");
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await as(app, env.db, "Olivia Owner");
  const payments = await idOf(env.db, "projects", "payments");
  const page = await olivia.get(`/projects/${payments}`);
  assert.match(page.body, /id="brain"/);
  assert.match(page.body, /Brain health|Nothing needs attention/);
});

test("brain brief POST stores and renders a labeled brief with citations", async () => {
  const oliviaId = await personId(env.db, "Olivia Owner").catch(() => "");
  void oliviaId;
  const app0 = (await import("./web-helpers.ts")).openApp(env.ctx);
  await loadExample(app0);
  const olivia = await personId(env.db, "Olivia Owner");
  const copilot = await personId(env.db, "Copilot Agent");
  const payments = await idOf(env.db, "projects", "payments");
  const memories = await listMemories(env.ctx, olivia, { scope: { level: "project", id: payments }, limit: 3 });
  assert.ok(memories[0]);
  const runtime: DecisionGuardWebRuntime = {
    status: () => ({ configured: true, enabled: true, model: "test-model", remainingRequests: 5, agentId: copilot }),
    async configure() {},
    async forget() {},
    async createRun() { throw new Error("not used"); },
    async brief(ctx, requesterId, input) {
      return createBrainBrief(ctx, requesterId, {
        projectId: input.projectId,
        agentId: copilot,
        model: "test-model",
        content: `Payments brief citing [${memories[0]!.id}] inline.`,
        citations: [memories[0]!.id],
      });
    },
  };
  const app = createApp(env.ctx, { port: APP_PORT, decisionGuard: runtime });
  const browser = await as(app, env.db, "Olivia Owner");
  const page = await browser.get(`/projects/${payments}`);
  assert.match(page.body, /Generate brain brief/);
  const posted = await browser.post(`/projects/${payments}/brain/brief`, {});
  assert.equal(posted.status, 303);
  const after = await browser.get(`/projects/${payments}`);
  assert.match(after.body, /AI brief — not approved knowledge/);
  assert.match(after.body, /Payments brief citing/);
});
