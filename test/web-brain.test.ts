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

test("ask renders a cited ephemeral answer and capture proposes a learning", async () => {
  const app0 = (await import("./web-helpers.ts")).openApp(env.ctx);
  await loadExample(app0);
  const olivia = await personId(env.db, "Olivia Owner");
  const copilot = await personId(env.db, "Copilot Agent");
  const payments = await idOf(env.db, "projects", "payments");
  const memories = await listMemories(env.ctx, olivia, { scope: { level: "project", id: payments }, limit: 3 });
  const sources = await (await import("../src/index.ts")).listSources(env.ctx, olivia, { scope: { level: "project", id: payments }, limit: 3 });
  assert.ok(memories[0] && sources[0]);
  const runtime: DecisionGuardWebRuntime = {
    status: () => ({ configured: true, enabled: true, model: "test-model", remainingRequests: 5, agentId: copilot }),
    async configure() {},
    async forget() {},
    async createRun() { throw new Error("not used"); },
    async brief(ctx, requesterId, input) {
      return createBrainBrief(ctx, requesterId, { projectId: input.projectId, agentId: copilot, model: "test-model", content: "Brief.", citations: [] });
    },
    async ask(_ctx, _requesterId, input) {
      return { question: input.question, answer: `Answer citing [${memories[0]!.id}] inline.`, citations: [memories[0]!.id], retrievalId: "12345678-1234-1234-1234-123456789012", model: "test-model" };
    },
  };
  const app = createApp(env.ctx, { port: APP_PORT, decisionGuard: runtime });
  const browser = await as(app, env.db, "Olivia Owner");
  const asked = await browser.post(`/projects/${payments}/brain/ask`, { question: "What do we know?" });
  assert.equal(asked.status, 200);
  assert.match(asked.body, /AI answer — from approved knowledge only/);
  assert.match(asked.body, /Answer citing/);
  const captured = await browser.post(`/projects/${payments}/brain/capture`, {
    title: "Session learning: retry jitter",
    type: "lesson",
    summary: "Learned that jitter prevents thundering herds.",
    evidenceSourceIds: [sources[0]!.id],
  });
  assert.equal(captured.status, 303);
  assert.match(captured.headers.Location ?? "", /\/proposals\//);
  const home = await browser.get("/");
  assert.match(home.body, /Brain activity/);
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
