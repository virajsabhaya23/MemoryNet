import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveDefinitionProposal,
  approveProposal,
  assignRole,
  connectRepository,
  createContext,
  createPrincipal,
  listRetrievals,
  proposeChange,
  proposeDefinition,
  proposeDefinitionRetirement,
  proposeMemory,
  recordRepositoryAccess,
  recordSource,
  UnavailableError,
  ValidationError,
  verifyLedger,
  type Definition,
  type DefinitionKind,
  type Memory,
  type ScopeRef,
} from "../src/index.ts";
import type { DefinitionContentInput } from "../src/definitions.ts";
import type { MemoryRelationsInput } from "../src/relations.ts";
import { getTaskContext } from "../src/task-context.ts";
import { buildWorld, project, START, useTestDatabase, type World } from "./helpers.ts";

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

/** An approved definition: the organization owner proposes it and an organization administrator approves it. */
async function define(w: World, scopeRef: ScopeRef, kind: DefinitionKind, name: string, extra: Partial<DefinitionContentInput> = {}): Promise<Definition> {
  const proposal = await proposeDefinition(env.ctx, w.people.ownerA.id, { scope: scopeRef, kind, name, purpose: `Synthetic purpose of ${name}.`,
    responsibilities: [`Synthetic duty of ${name}`], instructions: `Synthetic instructions for ${name}.`, ...extra });
  return approveDefinitionProposal(env.ctx, w.people.adminA.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
}

const organization = (w: World): ScopeRef => ({ level: "organization", id: w.orgA.id });

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

test("definitions follow the project's own chain: never sideways, retired or another agent's, and each is receipted", async () => {
  const w = await buildWorld(env.ctx);
  const { agent, adminA } = w.people;
  // The agent may read beta and gamma too, so leaving their definitions out is scope, not permission.
  for (const other of [w.beta, w.gamma]) await assignRole(env.ctx, adminA.id, { principalId: agent.id, scope: project(other.id), role: "reader" });
  const otherAgent = await createPrincipal(env.ctx, { kind: "agent", displayName: "Synthetic Release Agent" });
  await assignRole(env.ctx, adminA.id, { principalId: otherAgent.id, scope: project(w.alpha.id), role: "reader" });
  const alpha = project(w.alpha.id);
  const orgRule = await define(w, organization(w), "rule", "No secrets in chat");
  const unitInstruction = await define(w, { level: "business_unit", id: w.platform.id }, "instruction", "Platform services log in JSON");
  const sideways = [
    await define(w, { level: "business_unit", id: w.clinical.id }, "instruction", "Clinical tools keep audit trails"),
    await define(w, project(w.beta.id), "rule", "Beta pins the SDK"),
    await define(w, project(w.gamma.id), "skill", "Queue consumer triage"),
    await define(w, alpha, "agent", "Alpha release agent", { runsAs: otherAgent.id }),
    await define(w, alpha, "skill", "Release notes"),
  ];
  const projectRule = await define(w, alpha, "rule", "Alpha retries are bounded");
  const projectInstruction = await define(w, alpha, "instruction", "Alpha uses structured errors");
  const ownAgent = await define(w, alpha, "agent", "Alpha coding agent", { runsAs: agent.id });
  const skill = await define(w, alpha, "skill", "Queue consumer review");
  const retired = await define(w, alpha, "rule", "Alpha freezes deploys");
  const retire = await proposeDefinitionRetirement(env.ctx, w.people.ownerA.id, { definitionId: retired.id, baseRevision: 1, reason: "Synthetic: lifted" });
  await approveDefinitionProposal(env.ctx, adminA.id, { proposalId: retire.id, expectedRevision: 1 });

  const result = await getTaskContext(env.ctx, agent.id, { projectId: w.alpha.id, task: "Change the queue consumer", paths: ["src/queue/consumer.ts"],
    maxTokens: 8000, applicability: scope });
  assert.deepEqual(result.definitions.map((d) => d.definitionId), [ownAgent.id, projectRule.id, projectInstruction.id, unitInstruction.id, orgRule.id, skill.id],
    "own agent definition, then rules and instructions from the project up, then matching skills");
  assert.equal(result.moreDefinitions, 0);
  assert.equal(result.outcome, "no_results", "definitions never change the decision outcome");
  const text = JSON.stringify(result);
  for (const hidden of [...sideways, retired]) assert.equal(text.includes(hidden.id), false, hidden.name);
  const byId = new Map(result.definitions.map((d) => [d.definitionId, d]));
  assert.deepEqual(byId.get(ownAgent.id)?.reasons, [{ kind: "runs_as_caller" }]);
  assert.deepEqual(byId.get(orgRule.id)?.reasons, [{ kind: "applies_to_scope" }]);
  assert.deepEqual(byId.get(skill.id)?.reasons, [{ kind: "matched_task" }, { kind: "matched_path", path: "src/queue/consumer.ts", pattern: null }]);
  assert.deepEqual(byId.get(unitInstruction.id)?.scope, { level: "business_unit", id: w.platform.id });
  const full = byId.get(projectRule.id)!;
  assert.deepEqual([full.revision, full.kind, full.compact, full.shortened, full.reviewNeeded, full.basedOn, full.approvedBy],
    [1, "rule", false, false, false, [], adminA.id]);
  assert.deepEqual([full.responsibilities, full.instructions], [["Synthetic duty of Alpha retries are bounded"], "Synthetic instructions for Alpha retries are bounded."]);
  assert.ok(result.budget.usedTokens <= result.budget.maxTokens);

  const pins = await env.db.query<{ definition_id: string; revision: number }>(
    "SELECT definition_id, revision FROM retrieval_definitions WHERE retrieval_id = $1 ORDER BY position", [result.retrievalId]);
  assert.deepEqual(pins.rows, result.definitions.map((d) => ({ definition_id: d.definitionId, revision: d.revision })));
  const [record] = await listRetrievals(env.ctx, adminA.id, { projectId: w.alpha.id });
  assert.deepEqual(record?.definitions.map((d) => [d.definitionId, d.revision, d.kind, d.name]),
    result.definitions.map((d) => [d.definitionId, d.revision, d.kind, d.name]));
  assert.equal((await verifyLedger(env.db)).ok, true);
});

test("skills match the task words or the files, including path patterns written in appliesTo", async () => {
  const w = await buildWorld(env.ctx);
  const alpha = project(w.alpha.id);
  const charges = await define(w, alpha, "skill", "Payment handling", { appliesTo: "Changes under src/payments/** and docs/payments.md." });
  const words = await define(w, alpha, "skill", "Webhook delivery checks");
  await define(w, alpha, "skill", "Search ranking", { appliesTo: "src/search/**" });
  const result = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "fix a flaky test",
    paths: ["src/payments/charge.ts", "docs/payments.md", "src/webhooks/delivery.ts"], applicability: scope });
  assert.deepEqual(result.definitions.map((d) => [d.definitionId, d.reasons]), [
    [charges.id, [{ kind: "matched_path", path: "src/payments/charge.ts", pattern: "src/payments/**" },
      { kind: "matched_path", path: "docs/payments.md", pattern: "docs/payments.md" }]],
    [words.id, [{ kind: "matched_path", path: "src/webhooks/delivery.ts", pattern: null }]],
  ]);
});

test("definitions take at most about 35% of the budget and six items, shrink to previews and count what was left out", async () => {
  const w = await buildWorld(env.ctx);
  const decision = await decide(w, "Cache invalidation is explicit", "Synthetic: invalidate caches explicitly.");
  const long = "Synthetic detailed guidance. ".repeat(60);
  for (let i = 0; i < 8; i++) {
    await define(w, organization(w), "rule", `Organization rule ${i}`, { instructions: long, boundaries: [`Synthetic boundary ${i}`] });
  }
  const wide = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "cache invalidation", maxTokens: 8000, applicability: scope });
  assert.deepEqual(wide.definitions.map((d) => d.name), [0, 1, 2, 3, 4, 5].map((i) => `Organization rule ${i}`));
  assert.equal(wide.moreDefinitions, 2);
  const tokens = wide.definitions.reduce((sum, d) => sum + Math.ceil(JSON.stringify(d).length / 4), 0);
  assert.ok(tokens <= 8000 * 0.35, `${tokens} tokens of definitions`);
  const [whole, preview] = [wide.definitions.find((d) => !d.compact)!, wide.definitions.find((d) => d.compact)!];
  assert.ok(whole.instructions.length <= 1500 && whole.shortened && whole.boundaries.length === 1);
  assert.ok(preview.instructions.length <= 240 && preview.shortened);
  assert.deepEqual([preview.responsibilities, preview.boundaries, preview.purpose], [[], [], "Synthetic purpose of " + preview.name + "."]);
  assert.deepEqual(wide.items.map((item) => item.memoryId), [decision.id], "decisions keep the rest of the budget");
  assert.equal(wide.items[0]?.compact, false);
  assert.ok(wide.budget.usedTokens <= 8000 && wide.budget.usedTokens >= tokens);

  const tight = await getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "cache invalidation", maxTokens: 300, applicability: scope });
  assert.deepEqual([tight.definitions, tight.moreDefinitions], [[], 8]);
  assert.deepEqual(tight.items.map((item) => item.memoryId), [decision.id], "the best decision is still delivered");
});

test("reviewNeeded flags a definition whose decision changed after its approval, naming only decisions the agent may read", async () => {
  const w = await buildWorld(env.ctx);
  await connectRepository(env.ctx, w.people.adminA.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1009", fullName: "synthetic-org-a/alpha-private" });
  for (const who of [w.people.contributor, w.people.reviewer]) await recordRepositoryAccess(env.ctx, { principalId: who.id, provider: "github", externalRepositoryId: "1009", canRead: true });
  const privateSource = await recordSource(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1009",
    reference: "pull/7", url: "https://github.com/synthetic-org-a/alpha-private/pull/7", excerpt: "Synthetic private session discussion." });
  const replaced = await decide(w, "Sessions use signed cookies", "Synthetic: sessions live in HttpOnly cookies.");
  const hiddenlyReplaced = await decide(w, "Tokens rotate daily", "Synthetic: rotate tokens every day.");
  const revised = await decide(w, "Session idle timeout is 30 minutes", "Synthetic: idle sessions end after 30 minutes.");
  const unchanged = await decide(w, "Sessions are bound to one device", "Synthetic: one device per session.");
  const links = [replaced, hiddenlyReplaced, revised, unchanged].map((memory) => ({ relation: "based_on" as const, targetId: memory.id }));
  const rule = await define(w, project(w.alpha.id), "rule", "Session handling follows the session decisions", { links });
  // Beta knowledge the agent cannot read: the link and its later revision stay invisible.
  const hiddenBasis = w.memories.betaApproved;
  const orgRule = await define(w, organization(w), "rule", "SDK versions are pinned", { links: [{ relation: "based_on", targetId: hiddenBasis.id }] });
  const ask = () => getTaskContext(env.ctx, w.people.agent.id, { projectId: w.alpha.id, task: "logging format", maxTokens: 8000, applicability: scope });
  const sorted = <T extends { memoryId: string }>(items: readonly T[]) => [...items].sort((a, b) => a.memoryId.localeCompare(b.memoryId));

  const before = await ask();
  const fresh = before.definitions.find((d) => d.definitionId === rule.id)!;
  assert.equal(fresh.reviewNeeded, false);
  assert.deepEqual(sorted(fresh.basedOn), sorted(links.map((link) => ({ memoryId: link.targetId, change: null, replacedBy: null }))));
  assert.deepEqual(before.definitions.find((d) => d.definitionId === orgRule.id)?.basedOn, []);

  env.advance(60_000);
  const change = (memory: Memory, kind: "replace" | "revise", title: string, sourceId = w.sources.alpha.id) =>
    proposeChange(env.ctx, w.people.contributor.id, { memoryId: memory.id, expectedRevision: memory.revision, kind, type: "decision", title,
      content: `Synthetic: ${title}.`, evidenceSourceIds: [sourceId] })
      .then((p) => approveProposal(env.ctx, w.people.reviewer.id, { proposalId: p.id, expectedRevision: p.revision }));
  const replacement = await change(replaced, "replace", "Sessions live on the server");
  const hiddenReplacement = await change(hiddenlyReplaced, "replace", "Tokens rotate hourly", privateSource.id);
  await change(revised, "revise", "Session idle timeout is 15 minutes");
  const beta = await proposeChange(env.ctx, w.people.ownerA.id, { memoryId: hiddenBasis.id, expectedRevision: 1, kind: "revise", type: "decision",
    title: "Beta pins the SDK minor version", content: "Synthetic beta revision.", evidenceSourceIds: [w.sources.beta.id] });
  await approveProposal(env.ctx, w.people.adminA.id, { proposalId: beta.id, expectedRevision: beta.revision });

  const after = await ask();
  const stale = after.definitions.find((d) => d.definitionId === rule.id)!;
  assert.equal(stale.reviewNeeded, true);
  assert.deepEqual(sorted(stale.basedOn), sorted([
    { memoryId: replaced.id, change: "superseded", replacedBy: replacement.id },
    { memoryId: hiddenlyReplaced.id, change: "superseded", replacedBy: null },
    { memoryId: revised.id, change: "revised", replacedBy: null },
    { memoryId: unchanged.id, change: null, replacedBy: null },
  ]));
  const org = after.definitions.find((d) => d.definitionId === orgRule.id)!;
  assert.deepEqual([org.reviewNeeded, org.basedOn], [false, []], "a change the agent cannot read is never revealed");
  const text = JSON.stringify(after);
  assert.equal(text.includes(hiddenReplacement.id) || text.includes(hiddenBasis.id), false);
});
