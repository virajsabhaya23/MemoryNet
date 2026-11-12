import assert from "node:assert/strict";
import { test } from "node:test";
import { GuardProviderError } from "../src/decision-guard/errors.ts";
import type { DecisionGuardProvider, GuardInput } from "../src/decision-guard/model.ts";
import type { DecisionGuardWebRuntime } from "../src/decision-guard/runtime.ts";
import { createGuardRun } from "../src/decision-guard/workflow.ts";
import { approveProposal, getMemory, getProposal, getSource, proposeChange, proposeMemory } from "../src/knowledge.ts";
import { recordRepositoryAccess } from "../src/repositories.ts";
import { createApp } from "../src/web/app.ts";
import { APP_PORT } from "../src/web/kit.ts";
import { buildWorld, START, useTestDatabase, type World } from "./helpers.ts";
import { TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();
const TEST_KEY = "controlled-test-key-never-a-real-credential";
const APP_SCOPE = { appRepositoryId: "1001", appBranch: "main", appValidFrom: START.toISOString(), appValidUntil: "" };

function runtimeFor(w: World, includeHints = true) {
  let configured = false;
  let agentId: string | null = null;
  let calls = 0;
  let configurationCalls = 0;
  let maxOutputTokens = 2048;
  let failure: Error | null = null;
  const provider: DecisionGuardProvider = {
    async complete(messages) {
      calls += 1;
      if (failure) throw failure;
      const input = JSON.parse(messages[1]?.content ?? "") as GuardInput;
      const source = input.sources[0]!;
      return {
        provider: "controlled-test-provider", model: "controlled-test-model", usage: { inputTokens: 120, outputTokens: 80 },
        latencyMs: 1234, parameters: { maxOutputTokens: 2048, reasoningEffort: "low" },
        text: JSON.stringify({ candidates: [{ title: "Cache <script>alert(1)</script>", decision: "Synthetic guarded cache decision.",
          evidence: [{ sourceId: source.sourceId, start: 0, end: source.text.length, quote: source.text }],
          possibleConflicts: includeHints ? input.approvedDecisions.map((decision) => ({ memoryId: decision.memoryId, revision: decision.revision, reason: "Synthetic possible conflict for review." })) : [],
        }] }),
      };
    },
  };
  const runtime: DecisionGuardWebRuntime = {
    status: () => ({ configured, enabled: configured && agentId !== null, model: "muse-spark-1.3", remainingRequests: 5 - calls, agentId, maxOutputTokens }),
    async configure(key, options) {
      configurationCalls += 1;
      if (failure) throw new Error(`Internal failure involving ${key}`);
      assert.ok(key === TEST_KEY || (key === "" && configured));
      configured = true;
      agentId = options.agentId;
      maxOutputTokens = options.maxOutputTokens ?? maxOutputTokens;
    },
    async forget() { configured = false; agentId = null; },
    async createRun(ctx, requesterId, input) {
      if (!configured) throw new GuardProviderError("disabled", "Key absent");
      return createGuardRun(ctx, requesterId, agentId!, provider, input);
    },
  };
  return { runtime, get calls() { return calls; }, get configurationCalls() { return configurationCalls; }, fail(error: Error | null) { failure = error; } };
}

function appFor(runtime: DecisionGuardWebRuntime) {
  return createApp(env.ctx, { port: APP_PORT, decisionGuard: runtime });
}

async function signedIn(app: ReturnType<typeof appFor>, id: string) {
  const browser = new TestBrowser(app);
  await browser.signIn(id);
  return browser;
}

test("Meta setup masks the key, never echoes it, and configures without generating", async () => {
  const w = await buildWorld(env.ctx);
  const state = runtimeFor(w);
  const browser = new TestBrowser(appFor(state.runtime));
  const initial = await browser.get("/settings/meta");
  assert.equal(initial.status, 200);
  assert.match(initial.body, /What is your Meta Model API key\?/);
  assert.match(initial.body, /type="password" name="apiKey"/);
  assert.doesNotMatch(initial.body, /name="apiKey"[^>]*value=/);
  assert.match(initial.body, /Live model off/);
  const saved = await browser.system("/settings/meta", { apiKey: TEST_KEY, agentId: w.people.agent.id });
  assert.equal(saved.status, 303);
  const configured = await browser.get("/settings/meta");
  assert.match(configured.body, /Key configured/);
  assert.doesNotMatch(configured.body, new RegExp(TEST_KEY));
  assert.doesNotMatch(saved.body, new RegExp(TEST_KEY));
  assert.equal(state.calls, 0, "saving a key must not dispatch inference");
  assert.equal(state.configurationCalls, 1);
  assert.equal((await browser.system("/settings/meta", { apiKey: "", agentId: w.people.agent.id })).status, 303);
  assert.equal(state.calls, 0);
  assert.equal((await browser.system("/settings/meta/forget")).status, 303);
  assert.equal(state.runtime.status().configured, false);
});

test("settings reject missing tokens, foreign origins and non-agent bindings without disclosing a key on failure", async () => {
  const w = await buildWorld(env.ctx);
  const state = runtimeFor(w);
  const browser = new TestBrowser(appFor(state.runtime));
  const missingToken = await browser.request("POST", "/settings/meta", { body: new URLSearchParams({ apiKey: TEST_KEY, agentId: w.people.agent.id }).toString() });
  assert.equal(missingToken.status, 403);
  const initial = await browser.get("/settings/meta");
  const token = /name="_system" value="([^"]+)"/.exec(initial.body)?.[1] ?? "";
  const foreign = await browser.request("POST", "/settings/meta", { body: new URLSearchParams({ _system: token, apiKey: TEST_KEY, agentId: w.people.agent.id }).toString(), headers: { origin: "https://foreign.invalid" } });
  assert.equal(foreign.status, 403);
  const humanAgent = await browser.system("/settings/meta", { apiKey: TEST_KEY, agentId: w.people.reviewer.id });
  assert.equal(humanAgent.status, 400);
  assert.equal(state.configurationCalls, 0);
  state.fail(new Error("Synthetic internal credential error"));
  const failed = await browser.system("/settings/meta", { apiKey: TEST_KEY, agentId: w.people.agent.id });
  assert.equal(failed.status, 400);
  assert.doesNotMatch(failed.body, new RegExp(TEST_KEY));
  assert.doesNotMatch(failed.body, /Internal failure/);
  assert.equal(state.calls, 0);
});

test("project extraction denies readers and agents before displaying source excerpts", async () => {
  const w = await buildWorld(env.ctx);
  const state = runtimeFor(w);
  const app = appFor(state.runtime);
  const source = await getSource(env.ctx, w.people.contributor.id, w.sources.alpha.id);
  for (const principal of [w.people.reader, w.people.agent, w.people.outsider]) {
    const browser = await signedIn(app, principal.id);
    const denied = await browser.get(`/projects/${w.alpha.id}/decision-guard`);
    assert.ok(denied.status === 403 || denied.status === 404);
    assert.ok(!denied.body.includes(source.excerpt));
  }
  assert.equal(state.calls, 0);
});

test("an explicit extraction produces escaped evidence-backed candidates and a pending agent proposal for human review", async () => {
  const w = await buildWorld(env.ctx);
  const state = runtimeFor(w);
  await state.runtime.configure(TEST_KEY, { agentId: w.people.agent.id });
  const app = appFor(state.runtime);
  const reviewer = await signedIn(app, w.people.reviewer.id);
  const path = `/projects/${w.alpha.id}/decision-guard`;
  const select = await reviewer.get(path);
  assert.equal(select.status, 200);
  assert.match(select.body, /Extract with Meta/);
  assert.equal(state.calls, 0);
  const extracted = await reviewer.post(path, { ...APP_SCOPE, sourceIds: [w.sources.alpha.id] });
  assert.equal(extracted.status, 303);
  assert.equal(state.calls, 1);
  const runPath = extracted.headers.Location ?? "";
  const run = await reviewer.get(runPath);
  assert.equal(run.status, 200);
  assert.match(run.body, /Recorded extraction/);
  assert.match(run.body, /controlled-test-provider/);
  assert.match(run.body, /1,234 ms/);
  assert.match(run.body, /120 input tokens/);
  assert.match(run.body, /80 output tokens/);
  assert.match(run.body, /Output cap: 2048 tokens/);
  assert.match(run.body, /Reasoning effort: low/);
  assert.match(run.body, /Cache &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(run.body, /Cache <script>/);
  assert.match(run.body, /Source says/);
  assert.match(run.body, /Save pending proposal/);
  assert.equal(state.calls, 1, "viewing a run does not generate again");
  const pending = await reviewer.post(`${runPath}/candidates/0/propose`, { kind: "new" });
  assert.equal(pending.status, 303);
  const proposalPath = pending.headers.Location ?? "";
  const proposalId = proposalPath.split("/").at(-1) ?? "";
  const proposal = await getProposal(env.ctx, w.people.reviewer.id, proposalId);
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.proposedBy, w.people.agent.id);
  assert.equal(proposal.ownerId, w.people.reviewer.id);
  const review = await reviewer.get(proposalPath);
  assert.match(review.body, /Review version 1/);
  assert.match(review.body, />Approve</);
  const other = await signedIn(app, w.people.contributor.id);
  const wrongRequester = await other.post(`${runPath}/candidates/0/propose`, { kind: "new" });
  assert.equal(wrongRequester.status, 403);
});

test("typed Meta failures preserve permitted selections and never look like an empty successful extraction", async () => {
  const w = await buildWorld(env.ctx);
  const state = runtimeFor(w);
  await state.runtime.configure(TEST_KEY, { agentId: w.people.agent.id });
  state.fail(new GuardProviderError("busy", "Synthetic private upstream body", 429, 12));
  const browser = await signedIn(appFor(state.runtime), w.people.reviewer.id);
  const path = `/projects/${w.alpha.id}/decision-guard`;
  await browser.get(path);
  const failed = await browser.post(path, { ...APP_SCOPE, sourceIds: [w.sources.alpha.id] });
  assert.equal(failed.status, 503);
  assert.match(failed.body, /Meta is busy\. Try again in 12 seconds/);
  assert.match(failed.body, new RegExp(`value="${w.sources.alpha.id}" checked`));
  assert.doesNotMatch(failed.body, /Synthetic private upstream body/);
  assert.doesNotMatch(failed.body, /Not enough evidence/);
  assert.equal(state.calls, 1);
  const { rows } = await env.db.query<{ count: number }>("SELECT count(*)::int AS count FROM decision_guard_runs");
  assert.equal(rows[0]?.count, 0);
});

test("foreign sources never dispatch and a run becomes unreadable after repository access is revoked", async () => {
  const w = await buildWorld(env.ctx);
  const state = runtimeFor(w);
  await state.runtime.configure(TEST_KEY, { agentId: w.people.agent.id });
  const browser = await signedIn(appFor(state.runtime), w.people.reviewer.id);
  const path = `/projects/${w.alpha.id}/decision-guard`;
  await browser.get(path);
  const foreign = await browser.post(path, { ...APP_SCOPE, sourceIds: [w.sources.beta.id] });
  assert.ok(foreign.status === 403 || foreign.status === 404);
  assert.equal(state.calls, 0);
  const extracted = await browser.post(path, { ...APP_SCOPE, sourceIds: [w.sources.alpha.id] });
  assert.equal(extracted.status, 303);
  const runPath = extracted.headers.Location ?? "";
  assert.equal((await browser.get(runPath)).status, 200);
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reviewer.id, provider: "github", externalRepositoryId: "1001", canRead: false });
  const denied = await browser.get(runPath);
  assert.ok(denied.status === 403 || denied.status === 404);
  assert.doesNotMatch(denied.body, /Synthetic guarded cache decision|Source says|alert\(1\)/);
  const publication = await browser.post(`${runPath}/candidates/0/propose`, { kind: "new" });
  assert.ok(publication.status === 403 || publication.status === 404);
  assert.equal(state.calls, 1);
});

test("a conflict's compared revision stays distinct from its current title and a stale replacement is refused", async () => {
  const w = await buildWorld(env.ctx);
  const scopedProposal = await proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id, type: "decision", title: "Scoped comparison decision", content: "Synthetic guidance in the same reviewed branch scope.",
    evidenceSourceIds: [w.sources.alpha.id], applicability: { repositoryId: "1001", branch: "main", validFrom: START },
  });
  const scopedDecision = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: scopedProposal.id, expectedRevision: 1 });
  const state = runtimeFor(w);
  await state.runtime.configure(TEST_KEY, { agentId: w.people.agent.id });
  const browser = await signedIn(appFor(state.runtime), w.people.reviewer.id);
  const path = `/projects/${w.alpha.id}/decision-guard`;
  await browser.get(path);
  const extracted = await browser.post(path, { ...APP_SCOPE, sourceIds: [w.sources.alpha.id], decisionIds: [scopedDecision.id] });
  assert.equal(extracted.status, 303);
  const runPath = extracted.headers.Location ?? "";
  const change = await proposeChange(env.ctx, w.people.contributor.id, {
    memoryId: scopedDecision.id, expectedRevision: 1, kind: "revise", type: "decision",
    title: "Current revised decision title", content: "Synthetic revised decision that postdates the recorded comparison.",
    evidenceSourceIds: [w.sources.alpha.id],
  });
  await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: change.id, expectedRevision: change.revision });
  const run = await browser.get(runPath);
  assert.equal(run.status, 200);
  assert.match(run.body, /Compared decision[\s\S]*version 1/);
  assert.match(run.body, /Current record:[\s\S]*Current revised decision title[\s\S]*version 2 · approved/);
  assert.match(run.body, /This comparison is stale/);
  const refused = await browser.post(`${runPath}/candidates/0/propose`, { kind: "replace", targetMemoryId: scopedDecision.id });
  assert.equal(refused.status, 409);
  assert.equal(state.calls, 1);
});

test("the review UI offers an explicit compared-decision replacement without asserting a model conflict", async () => {
  const w = await buildWorld(env.ctx);
  const pending = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id,
    type: "decision", title: "Scoped v3 compatibility", content: "Controlled historical guidance while using the older library version.",
    evidenceSourceIds: [w.sources.alpha.id], applicability: { repositoryId: "1001", branch: "main", validFrom: START } });
  const prior = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 });
  const state = runtimeFor(w, false);
  await state.runtime.configure(TEST_KEY, { agentId: w.people.agent.id });
  const browser = await signedIn(appFor(state.runtime), w.people.reviewer.id);
  const path = `/projects/${w.alpha.id}/decision-guard`;
  await browser.get(path);
  const extracted = await browser.post(path, { ...APP_SCOPE, sourceIds: [w.sources.alpha.id], decisionIds: [prior.id] });
  assert.equal(extracted.status, 303);
  const runPath = extracted.headers.Location!;
  const run = await browser.get(runPath);
  assert.equal(run.status, 200);
  assert.match(run.body, /Propose replacing an approved decision/);
  assert.match(run.body, /Choose a compared decision/);
  assert.match(run.body, new RegExp(`value="${prior.id}"`));
  assert.match(run.body, /It does not assert that the model found a conflict/);
  assert.doesNotMatch(run.body, /<h3>Possible conflict<\/h3>/);
  assert.match(run.body, /name="kind" value="new" checked/);
  assert.doesNotMatch(run.body, /name="kind" value="replace" checked/);
  const saved = await browser.post(`${runPath}/candidates/0/propose`, { kind: "replace", targetMemoryId: prior.id });
  assert.equal(saved.status, 303);
  const proposal = await getProposal(env.ctx, w.people.reviewer.id, saved.headers.Location!.split("/").pop()!);
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.changeKind, "replace");
  assert.equal(proposal.targetMemoryId, prior.id);
  assert.equal((await getMemory(env.ctx, w.people.reviewer.id, prior.id)).status, "approved");
  assert.equal(state.calls, 1);
});

test("no-hint UI replacement cannot select an unprovided decision or publish against a changed compared revision", async () => {
  const w = await buildWorld(env.ctx);
  const decisions = [];
  for (const title of ["Selected comparison", "Unselected comparison"]) {
    const pending = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id,
      type: "decision", title, content: "Controlled scoped guidance.", evidenceSourceIds: [w.sources.alpha.id],
      applicability: { repositoryId: "1001", branch: "main", validFrom: START } });
    decisions.push(await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 }));
  }
  const [selected, unselected] = decisions;
  const state = runtimeFor(w, false);
  await state.runtime.configure(TEST_KEY, { agentId: w.people.agent.id });
  const browser = await signedIn(appFor(state.runtime), w.people.reviewer.id);
  const path = `/projects/${w.alpha.id}/decision-guard`;
  await browser.get(path);
  const extracted = await browser.post(path, { ...APP_SCOPE, sourceIds: [w.sources.alpha.id], decisionIds: [selected!.id] });
  assert.equal(extracted.status, 303);
  const runPath = extracted.headers.Location!;
  const run = await browser.get(runPath);
  assert.doesNotMatch(run.body, new RegExp(`value="${unselected!.id}"`));
  for (const targetMemoryId of [unselected!.id, w.memories.betaApproved.id]) {
    const refused = await browser.post(`${runPath}/candidates/0/propose`, { kind: "replace", targetMemoryId });
    assert.equal(refused.status, 400);
  }
  const revision = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: selected!.id,
    expectedRevision: 1, kind: "revise", type: "decision", title: "Changed selected comparison", content: "Controlled new guidance.",
    evidenceSourceIds: [w.sources.alpha.id] });
  await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: revision.id, expectedRevision: 1 });
  const stale = await browser.get(runPath);
  assert.match(stale.body, /A compared decision changed after extraction/);
  assert.match(stale.body, /Replacement from this run will be refused/);
  const refused = await browser.post(`${runPath}/candidates/0/propose`, { kind: "replace", targetMemoryId: selected!.id });
  assert.equal(refused.status, 409);
  assert.equal(state.calls, 1);
});

test("token-limit diagnostics permit an explicit cap change while retaining the masked key and consumed allowance", async () => {
  const w = await buildWorld(env.ctx);
  const state = runtimeFor(w);
  await state.runtime.configure(TEST_KEY, { agentId: w.people.agent.id });
  const browser = await signedIn(appFor(state.runtime), w.people.reviewer.id);
  const settings = await browser.get("/settings/meta");
  assert.match(settings.body, /<summary>Request limits<\/summary>/);
  assert.match(settings.body, /value="2048" selected/);
  assert.doesNotMatch(settings.body, new RegExp(TEST_KEY));
  state.fail(new GuardProviderError("invalid_response", "RAW_PRIVATE_RESPONSE_NOT_FOR_UI", undefined, undefined, "token_limit"));
  const path = `/projects/${w.alpha.id}/decision-guard`;
  await browser.get(path);
  const limited = await browser.post(path, { ...APP_SCOPE, sourceIds: [w.sources.alpha.id] });
  assert.equal(limited.status, 503);
  assert.match(limited.body, /configured output-token limit/);
  assert.match(limited.body, /Meta settings → Request limits/);
  assert.match(limited.body, /choose 4,096 only if your budget permits/);
  assert.doesNotMatch(limited.body, /RAW_PRIVATE_RESPONSE_NOT_FOR_UI/);
  assert.equal(state.calls, 1);
  assert.equal(state.runtime.status().remainingRequests, 4);

  state.fail(null);
  const updated = await browser.system("/settings/meta", { apiKey: "", agentId: w.people.agent.id, maxOutputTokens: "4096" });
  assert.equal(updated.status, 303);
  const configured = await browser.get("/settings/meta");
  assert.match(configured.body, /value="4096" selected/);
  assert.doesNotMatch(configured.body, new RegExp(TEST_KEY));
  assert.equal(state.runtime.status().configured, true);
  assert.equal(state.runtime.status().remainingRequests, 4);
  assert.equal(state.calls, 1, "saving a larger cap makes no extra model request");

  state.fail(new GuardProviderError("invalid_response", "RAW_PRIVATE_RESPONSE_NOT_FOR_UI", undefined, undefined, "token_limit"));
  await browser.get(path);
  const stillLimited = await browser.post(path, { ...APP_SCOPE, sourceIds: [w.sources.alpha.id] });
  assert.match(stillLimited.body, /configured 4,096-token output limit/);
  assert.match(stillLimited.body, /available cap is already selected/);
  assert.doesNotMatch(stillLimited.body, /choose 4,096 only/);
  assert.equal(state.calls, 2);
  const count = await env.db.query<{ count: number }>("SELECT count(*)::int AS count FROM decision_guard_runs");
  assert.equal(count.rows[0]?.count, 0);
});

test("a concurrent cap change does not relabel the allowance used by an in-flight request", async () => {
  const w = await buildWorld(env.ctx);
  const state = runtimeFor(w);
  await state.runtime.configure(TEST_KEY, { agentId: w.people.agent.id });
  state.runtime.createRun = async () => {
    await state.runtime.configure("", { agentId: w.people.agent.id, maxOutputTokens: 4096 });
    throw new GuardProviderError("invalid_response", "controlled token limit", undefined, undefined, "token_limit");
  };
  const browser = await signedIn(appFor(state.runtime), w.people.reviewer.id);
  const path = `/projects/${w.alpha.id}/decision-guard`;
  await browser.get(path);
  const result = await browser.post(path, { ...APP_SCOPE, sourceIds: [w.sources.alpha.id] });
  assert.equal(result.status, 503);
  assert.equal(state.runtime.status().maxOutputTokens, 4096);
  assert.match(result.body, /choose 4,096 only if your budget permits/);
  assert.doesNotMatch(result.body, /configured 4,096-token output limit/);
});

test("request limits reject unsupported or duplicate values and diagnostics do not expose upstream details", async () => {
  const w = await buildWorld(env.ctx);
  const state = runtimeFor(w);
  const browser = await signedIn(appFor(state.runtime), w.people.reviewer.id);
  for (const maxOutputTokens of ["8192", "", ["2048", "4096"]]) {
    const rejected = await browser.system("/settings/meta", { apiKey: TEST_KEY, agentId: w.people.agent.id, maxOutputTokens });
    assert.equal(rejected.status, 400);
    assert.doesNotMatch(rejected.body, new RegExp(TEST_KEY));
  }
  assert.equal(state.configurationCalls, 0);
  await state.runtime.configure(TEST_KEY, { agentId: w.people.agent.id });
  const cases = [
    ["model_mismatch", /returned model ID did not match/],
    ["refusal", /Meta declined to return a decision/],
    ["choice_count", /unexpected number of responses/],
    ["unexpected_tool_call", /tool call instead of decision data/],
  ] as const;
  const path = `/projects/${w.alpha.id}/decision-guard`;
  for (const [diagnostic, expected] of cases) {
    state.fail(new GuardProviderError("invalid_response", "RAW_PRIVATE_RESPONSE_NOT_FOR_UI", undefined, undefined, diagnostic));
    await browser.get(path);
    const failure = await browser.post(path, { ...APP_SCOPE, sourceIds: [w.sources.alpha.id] });
    assert.equal(failure.status, 503);
    assert.match(failure.body, expected);
    assert.match(failure.body, /No draft or proposal was saved/);
    assert.doesNotMatch(failure.body, /RAW_PRIVATE_RESPONSE_NOT_FOR_UI/);
  }
});
