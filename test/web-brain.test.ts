import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrainBrief } from "../src/brain.ts";
import {
  approveDefinitionProposal,
  approveProposal,
  listMemories,
  proposeChange,
  proposeDefinition,
  reportOutdated,
} from "../src/index.ts";
import { createApp } from "../src/web/app.ts";
import { APP_PORT } from "../src/web/kit.ts";
import type { DecisionGuardWebRuntime } from "../src/decision-guard/runtime.ts";
import { buildWorld, project, useTestDatabase } from "./helpers.ts";
import { as, idOf, loadExample, personId, TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();

/** A project rule based on a decision that was revised after the rule was approved. */
async function outdatedRule() {
  const world = await buildWorld(env.ctx);
  const { contributor, reviewer } = world.people;
  const memory = world.memories.alphaApproved;
  const proposal = await proposeDefinition(env.ctx, contributor.id, {
    scope: project(world.alpha.id),
    kind: "rule",
    name: "Alpha retries are bounded",
    purpose: "Synthetic purpose.",
    responsibilities: ["Synthetic duty"],
    links: [{ relation: "based_on", targetId: memory.id }],
  });
  const rule = await approveDefinitionProposal(env.ctx, reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
  env.advance(60_000);
  const change = await proposeChange(env.ctx, contributor.id, {
    memoryId: memory.id,
    expectedRevision: memory.revision,
    kind: "revise",
    type: "decision",
    title: "Alpha retries once",
    content: "Synthetic revised body.",
    evidenceSourceIds: [world.sources.alpha.id],
  });
  await approveProposal(env.ctx, reviewer.id, { proposalId: change.id, expectedRevision: change.revision });
  const app = (await import("./web-helpers.ts")).openApp(env.ctx);
  const signIn = async (principalId: string) => {
    const browser = new TestBrowser(app);
    await browser.signIn(principalId);
    return browser;
  };
  return { world, memory, rule, signIn };
}

test("project Brain panel lists recommendations that link to existing pages and forms", async () => {
  const { world, memory, rule, signIn } = await outdatedRule();
  await reportOutdated(env.ctx, world.people.reader.id, { memoryId: memory.id, reason: "Synthetic: unclear" });
  await reportOutdated(env.ctx, world.people.agent.id, { memoryId: memory.id, reason: "Synthetic: outdated" });
  const contributor = await signIn(world.people.contributor.id);
  const page = await contributor.get(`/projects/${world.alpha.id}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /<h3 id="brain-recommendations">Recommendations<\/h3>/);
  assert.match(page.body, /Suggested from approved records you can read\. A person decides/);
  assert.match(page.body, /“Alpha retries are bounded” is based on “Alpha retries once”, which was revised after this definition was approved\./);
  assert.match(page.body, /“Alpha retries once” has 2 open reports that it may be outdated\./);
  for (const href of [
    `/definitions/${rule.id}`,
    `/definitions/${rule.id}#propose-change`,
    `/memories/${memory.id}`,
    `/memories/${memory.id}#propose-change`,
  ]) {
    assert.ok(page.body.includes(`href="${href}"`), `links to ${href}`);
  }
  assert.doesNotMatch(page.body, /Nothing needs attention here right now/);

  const definition = await contributor.get(`/definitions/${rule.id}`);
  assert.equal(definition.status, 200);
  assert.match(definition.body, /<section id="propose-change">/);
  const decision = await contributor.get(`/memories/${memory.id}`);
  assert.equal(decision.status, 200);
  assert.match(decision.body, /<details id="propose-change" class="edit">/);

  const reader = await signIn(world.people.reader.id);
  const readerPage = await reader.get(`/projects/${world.alpha.id}`);
  assert.ok(readerPage.body.includes(`href="/definitions/${rule.id}"`));
  assert.ok(!readerPage.body.includes("#propose-change"), "readers get no change forms");
});

test("Overview lists brain recommendations under Needs you", async () => {
  const { world, signIn } = await outdatedRule();
  const contributor = await signIn(world.people.contributor.id);
  const home = await contributor.get("/");
  assert.equal(home.status, 200);
  assert.match(home.body, /class="needs-you/);
  assert.match(home.body, /1 definition is based on decisions that changed in Alpha/);
  assert.ok(home.body.includes(`href="/projects/${world.alpha.id}#brain-recommendations"`));
  assert.match(home.body, /Brain recommendation/);

  const outsider = await signIn(world.people.outsider.id);
  const elsewhere = await outsider.get("/");
  assert.doesNotMatch(elsewhere.body, /based on decisions that changed/);
});

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
  const agent = await personId(env.db, "Coding Agent");
  const payments = await idOf(env.db, "projects", "payments");
  const memories = await listMemories(env.ctx, olivia, { scope: { level: "project", id: payments }, limit: 3 });
  const sources = await (await import("../src/index.ts")).listSources(env.ctx, olivia, { scope: { level: "project", id: payments }, limit: 3 });
  assert.ok(memories[0] && sources[0]);
  const runtime: DecisionGuardWebRuntime = {
    status: () => ({ configured: true, enabled: true, model: "test-model", remainingRequests: 5, agentId: agent }),
    async configure() {},
    async forget() {},
    async createRun() { throw new Error("not used"); },
    async brief(ctx, requesterId, input) {
      return createBrainBrief(ctx, requesterId, { projectId: input.projectId, agentId: agent, model: "test-model", content: "Brief.", citations: [] });
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
  const agent = await personId(env.db, "Coding Agent");
  const payments = await idOf(env.db, "projects", "payments");
  const memories = await listMemories(env.ctx, olivia, { scope: { level: "project", id: payments }, limit: 3 });
  assert.ok(memories[0]);
  const runtime: DecisionGuardWebRuntime = {
    status: () => ({ configured: true, enabled: true, model: "test-model", remainingRequests: 5, agentId: agent }),
    async configure() {},
    async forget() {},
    async createRun() { throw new Error("not used"); },
    async brief(ctx, requesterId, input) {
      return createBrainBrief(ctx, requesterId, {
        projectId: input.projectId,
        agentId: agent,
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
