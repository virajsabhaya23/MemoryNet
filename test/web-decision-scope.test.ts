// Product behavior tests use only synthetic principals/evidence in an in-memory database.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionGuardProvider, GuardInput } from "../src/decision-guard/model.ts";
import type { DecisionGuardWebRuntime } from "../src/decision-guard/runtime.ts";
import { createGuardRun, getGuardRun } from "../src/decision-guard/workflow.ts";
import { getMemory, getProposal } from "../src/knowledge.ts";
import { getContext } from "../src/retrieval.ts";
import { createApp } from "../src/web/app.ts";
import { APP_PORT } from "../src/web/kit.ts";
import { buildWorld, START, useTestDatabase } from "./helpers.ts";
import { TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();
const SCOPE = { appRepositoryId: "1001", appBranch: "release/next", appValidFrom: START.toISOString(), appValidUntil: "2026-10-01T00:00:00.000Z" };

function model() {
  let calls = 0;
  const provider: DecisionGuardProvider = { async complete(messages) {
    calls += 1;
    const input = JSON.parse(messages[1]!.content) as GuardInput;
    const source = input.sources[0]!;
    return { provider: "controlled-test-provider", model: "controlled-scope-model", usage: null,
      text: JSON.stringify({ candidates: [{ title: "Controlled scoped decision", decision: "Synthetic scoped engineering guidance.",
        evidence: [{ sourceId: source.sourceId, start: 0, end: source.text.length, quote: source.text }], possibleConflicts: [] }] }) };
  } };
  return { provider, get calls() { return calls; } };
}

async function setup() {
  const w = await buildWorld(env.ctx);
  const m = model();
  const runtime: DecisionGuardWebRuntime = {
    status: () => ({ configured: true, enabled: true, model: "controlled-scope-model", remainingRequests: 5 - m.calls, agentId: w.people.agent.id }),
    async configure() {}, async forget() {},
    createRun: (ctx, requesterId, input) => createGuardRun(ctx, requesterId, w.people.agent.id, m.provider, input),
  };
  const app = createApp(env.ctx, { port: APP_PORT, decisionGuard: runtime });
  const as = async (id: string) => { const browser = new TestBrowser(app); await browser.signIn(id); return browser; };
  return { w, m, app, as };
}

test("manual proposal review and approved history display the exact repository, branch and UTC interval", async () => {
  const { w, as } = await setup();
  const contributor = await as(w.people.contributor.id);
  await contributor.get(`/projects/${w.alpha.id}`);
  const proposed = await contributor.post(`/projects/${w.alpha.id}/proposals`, {
    type: "decision", title: "Scoped release policy", content: "Synthetic release-specific guidance.",
    evidenceSourceIds: [w.sources.alpha.id], ...SCOPE,
  });
  assert.equal(proposed.status, 303);
  const proposalPath = (proposed.headers.Location ?? "").split("?")[0]!;
  const reviewer = await as(w.people.reviewer.id);
  const screen = await reviewer.get(proposalPath);
  assert.match(screen.body, /Proposed applicability/);
  assert.match(screen.body, /GitHub repository ID[\s\S]*1001/);
  assert.match(screen.body, /Exact branch[\s\S]*release\/next/);
  assert.match(screen.body, /2026-09-24T09:00:00\.000Z/);
  assert.match(screen.body, /2026-10-01T00:00:00\.000Z/);
  assert.match(screen.body, /Human approval would apply/);
  const approved = await reviewer.post(`${proposalPath}/approve`, { expectedRevision: "1" });
  assert.equal(approved.status, 303);
  const memoryPath = (approved.headers.Location ?? "").split("?")[0]!;
  const memory = await reviewer.get(memoryPath);
  assert.match(memory.body, /Reviewed applicability/);
  assert.match(memory.body, /release\/next/);
  const history = await reviewer.get(`${memoryPath}/history`);
  assert.match(history.body, /2026-10-01T00:00:00\.000Z/);
});

test("Decision Guard requires explicit scope before dispatch and preserves it through run and pending proposal", async () => {
  const { w, m, as } = await setup();
  const reviewer = await as(w.people.reviewer.id);
  const path = `/projects/${w.alpha.id}/decision-guard`;
  const page = await reviewer.get(path);
  assert.match(page.body, /Reviewed applicability \(required\)/);
  assert.match(page.body, /synthetic-org-a\/alpha-service \(1001\)/);
  assert.doesNotMatch(page.body, new RegExp(`name="decisionIds" value="${w.memories.alphaApproved.id}"`), "legacy decisions are not offered as scoped comparisons");
  const missing = await reviewer.post(path, { sourceIds: [w.sources.alpha.id] });
  assert.equal(missing.status, 400);
  assert.match(missing.body, /Choose a repository, exact branch and UTC valid-from time/);
  assert.equal(m.calls, 0);
  const localTime = await reviewer.post(path, { sourceIds: [w.sources.alpha.id], ...SCOPE, appValidFrom: "2026-09-24T09:00" });
  assert.equal(localTime.status, 400);
  assert.equal(m.calls, 0);
  const impossibleDate = await reviewer.post(path, { sourceIds: [w.sources.alpha.id], ...SCOPE, appValidFrom: "2026-02-30T09:00:00.000Z" });
  assert.equal(impossibleDate.status, 400, "invalid dates must not silently normalize to another day");
  assert.equal(m.calls, 0);
  const duplicated = await reviewer.post(path, { sourceIds: [w.sources.alpha.id], ...SCOPE, appBranch: ["main", "release/next"] });
  assert.equal(duplicated.status, 400);
  assert.equal(m.calls, 0);
  const extracted = await reviewer.post(path, { sourceIds: [w.sources.alpha.id], ...SCOPE });
  assert.equal(extracted.status, 303);
  const runPath = extracted.headers.Location!;
  const run = await reviewer.get(runPath);
  assert.match(run.body, /Proposed applicability/);
  assert.match(run.body, /release\/next/);
  const saved = await reviewer.post(`${runPath}/candidates/0/propose`, { kind: "new", ...SCOPE, appBranch: "tampered-branch" });
  assert.equal(saved.status, 303);
  const proposalId = saved.headers.Location!.split("/").at(-1)!;
  const pending = await getProposal(env.ctx, w.people.reviewer.id, proposalId);
  assert.equal(pending.status, "pending");
  assert.equal(pending.applicability?.branch, "release/next", "browser publication fields cannot rewrite immutable run scope");
  assert.equal(pending.proposedBy, w.people.agent.id);
  const review = await reviewer.get(saved.headers.Location!);
  assert.match(review.body, /Proposed applicability/);
  assert.doesNotMatch(review.body, /name="appBranch"/, "model-linked proposal metadata is immutable");
  assert.equal(m.calls, 1);
});

test("legacy model drafts and memories are labeled unscoped without changing their saved metadata", async () => {
  const { w, m, as } = await setup();
  const legacy = await createGuardRun(env.ctx, w.people.reviewer.id, w.people.agent.id, m.provider, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id],
  });
  const reviewer = await as(w.people.reviewer.id);
  const run = await reviewer.get(`/decision-guard/runs/${legacy.id}`);
  assert.match(run.body, /Legacy: no reviewed applicability/);
  const saved = await reviewer.post(`/decision-guard/runs/${legacy.id}/candidates/0/propose`, { kind: "new" });
  const review = await reviewer.get(saved.headers.Location!);
  assert.match(review.body, /Legacy: no reviewed applicability/);
  assert.doesNotMatch(review.body, /name="appBranch"/);
  assert.equal((await getGuardRun(env.ctx, w.people.reviewer.id, legacy.id)).applicability, null);
  const memory = await reviewer.get(`/memories/${w.memories.alphaApproved.id}`);
  assert.match(memory.body, /Legacy: no reviewed applicability/);
});

test("revocation is a reviewer-only reasoned version-bound action distinct from suspension", async () => {
  const { w, as } = await setup();
  const memoryId = w.memories.alphaApproved.id;
  for (const person of [w.people.reader, w.people.contributor, w.people.agent]) {
    const browser = await as(person.id);
    const page = await browser.get(`/memories/${memoryId}`);
    assert.doesNotMatch(page.body, />Revoke approval</);
    const denied = await browser.post(`/memories/${memoryId}/revoke`, { expectedRevision: "1", reason: "Controlled unauthorized attempt" });
    assert.equal(denied.status, 403);
  }
  const reviewer = await as(w.people.reviewer.id);
  const page = await reviewer.get(`/memories/${memoryId}`);
  assert.match(page.body, /Revoke approval/);
  assert.match(page.body, /differs from temporary suspension/);
  assert.equal((await reviewer.post(`/memories/${memoryId}/revoke`, { expectedRevision: "99", reason: "Controlled stale version" })).status, 409);
  assert.equal((await reviewer.post(`/memories/${memoryId}/revoke`, { expectedRevision: "1", reason: "" })).status, 400);
  const revoked = await reviewer.post(`/memories/${memoryId}/revoke`, { expectedRevision: "1", reason: "Controlled withdrawal of approval" });
  assert.equal(revoked.status, 303);
  assert.equal((await getMemory(env.ctx, w.people.reviewer.id, memoryId)).status, "revoked");
  const historical = await reviewer.get(`/memories/${memoryId}`);
  assert.match(historical.body, /Approval revoked/);
  assert.match(historical.body, /Historical decision/);
  assert.match(historical.body, /ordinary reinstatement is unavailable/);
  assert.doesNotMatch(historical.body, />Reinstate</);
  assert.doesNotMatch(historical.body, />Revoke approval</);
  const history = await reviewer.get(`/memories/${memoryId}/history`);
  assert.match(history.body, /Controlled withdrawal of approval/);
  const context = await getContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, query: w.memories.alphaApproved.title });
  assert.ok(!context.current.some((memory) => memory.memoryId === memoryId));
});

test("a pre-revocation pending change cannot restore authority, while a fresh reviewed change can", async () => {
  const { w, as } = await setup();
  const memoryId = w.memories.alphaApproved.id;
  const contributor = await as(w.people.contributor.id);
  const reviewer = await as(w.people.reviewer.id);
  const fields = { expectedRevision: "1", kind: "revise", type: "decision", title: "Reviewed reauthorization",
    evidenceSourceIds: [w.sources.alpha.id] };
  await contributor.get(`/memories/${memoryId}`);
  const old = await contributor.post(`/memories/${memoryId}/changes`, { ...fields, content: "Synthetic change proposed before authority withdrawal." });
  assert.equal(old.status, 303);
  const oldPath = (old.headers.Location ?? "").split("?")[0]!;
  await reviewer.get(`/memories/${memoryId}`);
  assert.equal((await reviewer.post(`/memories/${memoryId}/revoke`, { expectedRevision: "1", reason: "Controlled withdrawal while change was pending" })).status, 303);
  const stale = await reviewer.get(oldPath);
  assert.match(stale.body, /Approval status changed after this proposal was written/);
  assert.equal((await reviewer.post(`${oldPath}/approve`, { expectedRevision: "1" })).status, 409);
  assert.equal((await getMemory(env.ctx, w.people.reviewer.id, memoryId)).status, "revoked");

  const fresh = await contributor.post(`/memories/${memoryId}/changes`, { ...fields, content: "Synthetic newly reviewed guidance after explicit withdrawal." });
  assert.equal(fresh.status, 303);
  const freshPath = (fresh.headers.Location ?? "").split("?")[0]!;
  const review = await reviewer.get(freshPath);
  assert.match(review.body, /Review version 1/);
  assert.equal((await reviewer.post(`${freshPath}/approve`, { expectedRevision: "1" })).status, 303);
  const current = await getMemory(env.ctx, w.people.reviewer.id, memoryId);
  assert.equal(current.status, "approved");
  assert.equal(current.revision, 2);
  const history = await reviewer.get(`/memories/${memoryId}/history`);
  assert.match(history.body, /Controlled withdrawal while change was pending/);
});
