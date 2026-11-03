// Synthetic engineering fixtures, not human approval or coding-agent research evidence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGuardRun } from "../src/decision-guard/workflow.ts";
import type { DecisionGuardProvider, GuardInput } from "../src/decision-guard/model.ts";
import { approveProposal, getMemory, proposeChange, proposeMemory } from "../src/knowledge.ts";
import { revokeMemory } from "../src/history.ts";
import { getContext } from "../src/retrieval.ts";
import { createApp } from "../src/web/app.ts";
import { APP_PORT } from "../src/web/kit.ts";
import { buildWorld, START, useTestDatabase } from "./helpers.ts";
import { openApp, TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();

async function scenario() {
  const w = await buildWorld(env.ctx);
  const first = await proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id, type: "decision", title: "Synthetic transport policy",
    content: "Use the synthetic legacy transport for queue requests.", evidenceSourceIds: [w.sources.alpha.id],
    applicability: { repositoryId: "1001", branch: "release/next", validFrom: START, validUntil: null },
  });
  const old = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: first.id, expectedRevision: first.revision });
  const replacement = await proposeChange(env.ctx, w.people.contributor.id, {
    memoryId: old.id, expectedRevision: old.revision, kind: "replace", type: "decision",
    title: "Synthetic fetch policy", content: "Use synthetic fetch for queue requests.", evidenceSourceIds: [w.sources.alpha.id],
  });
  const app = openApp(env.ctx);
  const as = async (id: string) => { const browser = new TestBrowser(app); await browser.signIn(id); return browser; };
  const retrieve = () => getContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, query: "queue requests",
    applicability: { repositoryId: "1001", branch: "release/next" } });
  return { w, old, replacement, as, retrieve };
}

test("the inspector keeps pending replacement authority separate from old/new text, evidence and code outcome", async () => {
  const { w, old, replacement, as, retrieve } = await scenario();
  const screen = await (await as(w.people.reviewer.id)).get(`/proposals/${replacement.id}`);
  assert.equal(screen.status, 200);
  assert.match(screen.body, /aria-label="Decision-change inspector"/);
  assert.match(screen.body, /Existing decision, version 1/);
  assert.match(screen.body, /Use the synthetic legacy transport/);
  assert.match(screen.body, /Proposed text, version 1[\s\S]*Use synthetic fetch/);
  assert.match(screen.body, /Evidence for review/);
  assert.match(screen.body, /release\/next/);
  assert.match(screen.body, /2026-09-24T09:00:00\.000Z/);
  assert.match(screen.body, /pending proposal supplies no current agent guidance/);
  assert.match(screen.body, /No executable coding result is attached/);
  assert.doesNotMatch(screen.body, /Code passed|Compliant code/);
  assert.deepEqual((await retrieve()).current.map((item) => item.memoryId), [old.id]);
  assert.equal((await getMemory(env.ctx, w.people.reviewer.id, old.id)).status, "approved", "viewing cannot approve or replace");
});

test("delivery receipts obey existing viewer access and remain historical after replacement and revocation", async () => {
  const { w, old, replacement, as, retrieve } = await scenario();
  const before = await retrieve();
  const reviewer = await as(w.people.reviewer.id);
  const reviewerScreen = await reviewer.get(`/proposals/${replacement.id}`);
  assert.doesNotMatch(reviewerScreen.body, new RegExp(before.retrievalId), "a reviewer cannot inspect another caller's receipts");
  assert.match(reviewerScreen.body, /No matching delivery receipt is visible to you/);
  const admin = await as(w.people.adminA.id);
  const adminScreen = await admin.get(`/proposals/${replacement.id}`);
  assert.match(adminScreen.body, new RegExp(before.retrievalId));
  assert.match(adminScreen.body, /approved at retrieval/);
  assert.match(adminScreen.body, /does not show that an agent followed it/);

  const current = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: replacement.id, expectedRevision: replacement.revision });
  const after = await retrieve();
  assert.deepEqual(after.current.map((item) => item.memoryId), [current.id]);
  await revokeMemory(env.ctx, w.people.reviewer.id, { memoryId: current.id, expectedRevision: current.revision, reason: "Synthetic withdrawal after delivery" });
  const historical = await admin.get(`/proposals/${replacement.id}`);
  assert.match(historical.body, new RegExp(before.retrievalId));
  assert.match(historical.body, new RegExp(after.retrievalId));
  assert.match(historical.body, /published memory&#39;s present status, applicability and access permissions determine/);
  assert.equal((await getMemory(env.ctx, w.people.reviewer.id, old.id)).status, "superseded");
  assert.equal((await retrieve()).current.length, 0, "historical delivery does not restore revoked authority");
});

test("extracted conflict comparison shows view-time old/new guidance and flags changed authority", async () => {
  const { w, old } = await scenario();
  const provider: DecisionGuardProvider = { async complete(messages) {
    const input = JSON.parse(messages[1]!.content) as GuardInput;
    const source = input.sources[0]!;
    return { provider: "controlled-test-provider", model: "controlled-inspector-model", usage: null,
      text: JSON.stringify({ candidates: [{ title: "Synthetic candidate", decision: "Use synthetic fetch for queue requests.",
        evidence: [{ sourceId: source.sourceId, start: 0, end: source.text.length, quote: source.text }],
        possibleConflicts: [{ memoryId: old.id, revision: old.revision, reason: "Synthetic possible conflict" }] }] }) };
  } };
  const run = await createGuardRun(env.ctx, w.people.reviewer.id, w.people.agent.id, provider, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id], decisionIds: [old.id], applicability: old.applicability,
  });
  const reviewer = new TestBrowser(createApp(env.ctx, { port: APP_PORT, decisionGuard: {
    status: () => ({ configured: false, enabled: false, model: "controlled-inspector-model", remainingRequests: 0, agentId: w.people.agent.id }),
    async configure() {}, async forget() {}, async createRun() { throw new Error("This test only views an existing run"); },
  } }));
  await reviewer.signIn(w.people.reviewer.id);
  const before = await reviewer.get(`/decision-guard/runs/${run.id}`);
  assert.equal(before.status, 200);
  assert.match(before.body, /aria-label="Compared decision and suggestion"/);
  assert.match(before.body, /Existing guidance at time of viewing[\s\S]*Use the synthetic legacy transport/);
  assert.match(before.body, /Suggested change for human review[\s\S]*Use synthetic fetch/);
  await revokeMemory(env.ctx, w.people.reviewer.id, { memoryId: old.id, expectedRevision: old.revision, reason: "Synthetic revocation after extraction" });
  const changed = await reviewer.get(`/decision-guard/runs/${run.id}`);
  assert.match(changed.body, /This comparison is stale/);
  assert.match(changed.body, /Current record:[\s\S]*revoked/);
});
