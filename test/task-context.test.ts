import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveProposal,
  connectRepository,
  createContext,
  listRetrievals,
  proposeChange,
  proposeMemory,
  recordRepositoryAccess,
  recordSource,
  UnavailableError,
  ValidationError,
  verifyLedger,
  type Memory,
} from "../src/index.ts";
import type { MemoryRelationsInput } from "../src/relations.ts";
import { getTaskContext } from "../src/task-context.ts";
import { buildWorld, START, useTestDatabase, type World } from "./helpers.ts";

const env = useTestDatabase();
const scope = { repositoryId: "1001", branch: "main" };

function decide(w: World, title: string, content: string, relations?: MemoryRelationsInput, options: { branch?: string; sourceId?: string } = {}): Promise<Memory> {
  return proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id, type: "decision", title, content, evidenceSourceIds: [options.sourceId ?? w.sources.alpha.id],
    applicability: { repositoryId: "1001", branch: options.branch ?? "main", validFrom: START.toISOString() },
    ...(relations ? { relations } : {}),
  }).then((p) => approveProposal(env.ctx, w.people.reviewer.id, { proposalId: p.id, expectedRevision: p.revision }));
}

async function source(w: World, pr: number, text: string) {
  return recordSource(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1001",
    reference: `pull/${pr}`, url: `https://github.com/synthetic-org-a/alpha-service/pull/${pr}`, excerpt: text });
}

test("text and path seeds pull in what they depend on and conflict with, each with a reason", async () => {
  const w = await buildWorld(env.ctx);
  const auth = await decide(w, "Tokens are signed with ed25519", "Synthetic: every service token uses ed25519 signatures.");
  const clock = await decide(w, "Allow 30 seconds of clock skew", "Synthetic: token validation tolerates 30 seconds of skew.");
  const client = await decide(w, "HTTP client retries idempotent calls", "Synthetic: retry GET and PUT up to three times.",
    { paths: ["src/http/**"], links: [{ relation: "depends_on", memoryId: auth.id }, { relation: "conflicts_with", memoryId: clock.id }] });
  // Its own pull request: sharing evidence would legitimately relate it to the others.
  const notesSource = await source(w, 41, "Synthetic release-notes style discussion.");
  const unrelated = await decide(w, "Release notes use present tense", "Synthetic: write release notes in present tense.", undefined, { sourceId: notesSource.id });
  const result = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "Change how the HTTP client handles failures",
    paths: ["src/http/client.ts"], applicability: scope });
  const ids = result.items.map((item) => item.memoryId);
  assert.equal(ids[0], client.id, "the path-governed decision that also matches the task ranks first");
  assert.ok(ids.includes(auth.id) && ids.includes(clock.id));
  assert.equal(ids.includes(unrelated.id), false);
  const first = result.items[0]!;
  assert.deepEqual(first.reasons.map((r) => r.kind).sort(), ["governs_path", "matched_task"]);
  assert.deepEqual(first.reasons.find((r) => r.kind === "governs_path"), { kind: "governs_path", pattern: "src/http/**", path: "src/http/client.ts" });
  const dependency = result.items.find((item) => item.memoryId === auth.id)!;
  assert.deepEqual(dependency.reasons, [{ kind: "linked", subject: client.id, relation: "depends_on", object: auth.id, replacedObject: null }]);
  assert.ok(dependency.score < first.score);
  assert.deepEqual(result.conflicts, [{ memoryId: client.id, conflictsWith: clock.id, bothDelivered: true }]);
  assert.equal(result.outcome, "results");
  assert.ok(result.budget.usedTokens <= result.budget.maxTokens);
  const receipts = await listRetrievals(env.ctx, w.people.adminA.id, { projectId: w.alpha.id });
  assert.deepEqual(receipts.find((r) => r.id === result.retrievalId)?.items.map((i) => i.memoryId), ids);
  assert.equal((await verifyLedger(env.db)).ok, true);
});

test("depth 0 delivers seeds only, but a decision's conflict is never left out", async () => {
  const w = await buildWorld(env.ctx);
  const auth = await decide(w, "Tokens are signed with ed25519", "Synthetic signing.");
  const clock = await decide(w, "Allow 30 seconds of clock skew", "Synthetic skew.");
  await decide(w, "HTTP client retries idempotent calls", "Synthetic retries.",
    { links: [{ relation: "depends_on", memoryId: auth.id }, { relation: "conflicts_with", memoryId: clock.id }] });
  const result = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "retries in the HTTP client", depth: 0, applicability: scope });
  const ids = result.items.map((item) => item.memoryId);
  assert.equal(ids.includes(auth.id), false);
  assert.equal(ids.includes(clock.id), true);
});

test("a link to a replaced decision resolves to its replacement and is reported as a changed dependency", async () => {
  const w = await buildWorld(env.ctx);
  const old = await decide(w, "Queue payloads are JSON", "Synthetic: queue payloads are JSON objects.");
  const consumer = await decide(w, "Consumers validate queue payload schemas", "Synthetic: consumers validate each payload.",
    { links: [{ relation: "depends_on", memoryId: old.id }] });
  const change = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: old.id, expectedRevision: 1, kind: "replace", type: "decision",
    title: "Queue payloads are protobuf", content: "Synthetic: queue payloads are protobuf messages.", evidenceSourceIds: [w.sources.alpha.id] });
  const replacement = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: change.id, expectedRevision: 1 });
  const result = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "consumers validate schemas", applicability: scope });
  const ids = result.items.map((item) => item.memoryId);
  assert.ok(ids.includes(consumer.id) && ids.includes(replacement.id));
  assert.equal(ids.includes(old.id), false, "replaced guidance is never delivered as current");
  assert.deepEqual(result.changedDependencies, [{ memoryId: consumer.id, linkedTo: old.id, replacedBy: replacement.id }]);
  const reason = result.items.find((item) => item.memoryId === replacement.id)!.reasons[0];
  assert.deepEqual(reason, { kind: "linked", subject: consumer.id, relation: "depends_on", object: replacement.id, replacedObject: old.id });
});

test("only readable, in-scope memories are ever reached; links never reveal hidden ones", async () => {
  const w = await buildWorld(env.ctx);
  await connectRepository(env.ctx, w.people.adminA.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1009", fullName: "synthetic-org-a/alpha-private" });
  for (const who of [w.people.contributor, w.people.reviewer]) await recordRepositoryAccess(env.ctx, { principalId: who.id, provider: "github", externalRepositoryId: "1009", canRead: true });
  const secretSource = await recordSource(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1009",
    reference: "pull/5", url: "https://github.com/synthetic-org-a/alpha-private/pull/5", excerpt: "Synthetic private signing discussion." });
  const hidden = await decide(w, "Private signing keys rotate weekly", "Synthetic hidden signing rule.", undefined, { sourceId: secretSource.id });
  const releaseBranch = await decide(w, "Release branch signing exception", "Synthetic signing exception.", undefined, { branch: "release" });
  const visible = await decide(w, "Signing uses the shared key service", "Synthetic signing service.",
    { links: [{ relation: "depends_on", memoryId: hidden.id }, { relation: "related", memoryId: releaseBranch.id }] });
  const result = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "signing keys", depth: 2, applicability: scope });
  const text = JSON.stringify(result);
  assert.deepEqual(result.items.map((item) => item.memoryId), [visible.id]);
  assert.equal(text.includes(hidden.id), false, "the agent cannot read the private source, so the linked memory stays invisible");
  assert.equal(text.includes(releaseBranch.id), false, "other branches are out of scope even when linked");
});

test("the token budget keeps the best items whole, shortens the rest and counts what was left out", async () => {
  const w = await buildWorld(env.ctx);
  for (let i = 0; i < 6; i++) await decide(w, `Cache invalidation rule ${i}`, `Synthetic cache rule ${i}. ${"Detailed cache guidance. ".repeat(40)}`);
  const generous = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "cache invalidation", maxTokens: 8000, applicability: scope });
  assert.equal(generous.items.length, 6);
  assert.equal(generous.items.every((item) => !item.compact), true);
  const tight = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "cache invalidation", maxTokens: 900, applicability: scope });
  assert.equal(tight.items[0]?.compact, false, "the best match stays whole");
  assert.ok(tight.items.some((item) => item.compact), "lower-ranked matches shrink to previews");
  assert.ok(tight.budget.usedTokens <= 900);
  assert.equal(tight.items.length + tight.omitted, 6);
  const few = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "cache invalidation", maxItems: 2, applicability: scope });
  assert.equal(few.items.length, 2);
  assert.equal(few.omitted, 4);
});

test("bad requests are refused before searching and failures are never empty results", async () => {
  const w = await buildWorld(env.ctx);
  for (const input of [
    { task: "" }, { task: "the a an" }, { task: "x".repeat(2001) }, { task: "ok", paths: ["../etc"] },
    { task: "ok", maxTokens: 50 }, { task: "ok", depth: 3 }, { task: "api_key: sk1234567890abcdefXYZ" },
  ]) {
    await assert.rejects(getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, ...input }), ValidationError, JSON.stringify(input));
  }
  const pathOnly = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "the", paths: ["src/x.ts"], applicability: scope });
  assert.equal(pathOnly.outcome, "no_results");
  await assert.rejects(getTaskContext(env.ctx, w.people.outsider.id, { projectId: w.alpha.id, task: "cache" }));
  const broken = createContext({ async query() { throw new Error("offline"); }, async exec() { throw new Error("offline"); },
    async transaction() { throw new Error("offline"); }, close: async () => {} }, { now: () => START });
  await assert.rejects(getTaskContext(broken, w.people.agent.id, { projectId: w.alpha.id, task: "cache" }), UnavailableError);
});

test("conflicts are reported from either side, and a tight budget says when one side was left out", async () => {
  const w = await buildWorld(env.ctx);
  const seed = await decide(w, "Webhooks retry for 24 hours", `Synthetic webhook retry window. ${"Delivery detail. ".repeat(60)}`);
  const other = await decide(w, "Unrelated partner rule", `Synthetic: deliveries stop after one hour. ${"Partner detail. ".repeat(60)}`,
    { links: [{ relation: "conflicts_with", memoryId: seed.id }] });
  const wide = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "webhooks retry window", depth: 0, applicability: scope });
  assert.deepEqual(wide.items.map((item) => item.memoryId), [seed.id, other.id], "the partner follows its counterpart even at depth 0");
  assert.deepEqual(wide.conflicts, [{ memoryId: other.id, conflictsWith: seed.id, bothDelivered: true }]);
  const tight = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "webhooks retry window", depth: 0, maxTokens: 300, applicability: scope });
  assert.deepEqual(tight.items.map((item) => item.memoryId), [seed.id]);
  assert.deepEqual(tight.conflicts, [{ memoryId: other.id, conflictsWith: seed.id, bothDelivered: false }]);
  assert.ok(tight.omitted >= 1);
});

test("a widely linked decision never makes the agent response invalid; notice lists are bounded and counted", async () => {
  const { parseAgentBinding } = await import("../src/agent-context/binding.ts");
  const { getAgentTaskContext } = await import("../src/agent-context/service.ts");
  const w = await buildWorld(env.ctx);
  const binding = parseAgentBinding({ schemaVersion: 1, token: "e".repeat(64), principalId: w.people.agent.id, projectId: w.alpha.id,
    repositoryId: "1001", branch: "main", expiresAt: new Date(START.getTime() + 86_400_000).toISOString() });
  const shared = await decide(w, "Events are versioned envelopes", "Synthetic: every event carries a schema version.");
  for (let i = 0; i < 41; i++) await decide(w, `Consumer ${i} reads versioned envelopes`, `Synthetic consumer ${i}.`, { links: [{ relation: "depends_on", memoryId: shared.id }] });
  const change = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: shared.id, expectedRevision: 1, kind: "replace", type: "decision",
    title: "Events are protobuf envelopes", content: "Synthetic replacement envelope.", evidenceSourceIds: [w.sources.alpha.id] });
  const replacement = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: change.id, expectedRevision: 1 });
  const result = await getAgentTaskContext(env.ctx, binding, { task: "consumer reads versioned envelopes", maxItems: 20, maxTokens: 8000 });
  assert.equal(result.outcome, "results");
  const delivered = new Set(result.items.map((item) => item.memoryId));
  assert.ok(result.changedDependencies.length > 0 && result.changedDependencies.length <= 40);
  assert.ok(result.changedDependencies.every((c) => delivered.has(c.memoryId) && c.replacedBy === replacement.id));
  assert.equal(result.moreChangedDependencies, 0, "only delivered holders are reported, so 20 items need no truncation");

  for (let i = 0; i < 44; i++) await decide(w, `Envelope exception ${i}`, `Synthetic exception ${i}.`, { links: [{ relation: "conflicts_with", memoryId: replacement.id }] });
  const crowded = await getAgentTaskContext(env.ctx, binding, { task: "protobuf envelopes", maxItems: 5, depth: 0, maxTokens: 8000 });
  assert.ok(crowded.items.some((item) => item.memoryId === replacement.id));
  assert.equal(crowded.conflicts.length, 40);
  assert.equal(crowded.conflicts.length + crowded.moreConflicts, 44);
  assert.ok(crowded.items.length <= 5 + 3 * 5, "conflict partners pulled in per item are capped");
});
