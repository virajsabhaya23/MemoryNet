import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeBrainHealth, createBrainBrief, listBrainActivity, listBrainBriefs } from "../src/brain.ts";
import { createGuardRuntime } from "../src/decision-guard/runtime.ts";
import {
  approveDefinitionProposal,
  approveProposal,
  dismissReport,
  listBrainRecommendations,
  listMemories,
  listWork,
  proposeChange,
  proposeDefinition,
  proposeMemory,
  rejectProposal,
  reportOutdated,
  suspendMemory,
  type BrainRecommendation,
  type BrainRecommendationKind,
  type DecisionApplicabilityInput,
  type Definition,
  type Memory,
  type Principal,
  type ScopeRef,
} from "../src/index.ts";
import { buildWorld, grantRepositoryRead, project, START, useTestDatabase, type World } from "./helpers.ts";
import { idOf, loadExample, openApp, personId } from "./web-helpers.ts";

const env = useTestDatabase();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
  const agent = await personId(env.db, "Coding Agent");
  const payments = await idOf(env.db, "projects", "payments");
  const memories = await listMemories(env.ctx, olivia, { scope: { level: "project", id: payments }, limit: 5 });
  assert.ok(memories[0]);
  const brief = await createBrainBrief(env.ctx, olivia, {
    projectId: payments,
    agentId: agent,
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
    () => createBrainBrief(env.ctx, agent, { projectId: payments, agentId: agent, model: "m", content: "x", citations: [] }),
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

test("ask refuses when no model is configured and stores nothing", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await personId(env.db, "Olivia Owner");
  const payments = await idOf(env.db, "projects", "payments");
  const runtime = createGuardRuntime({});
  await assert.rejects(() => runtime.ask!(env.ctx, olivia, { projectId: payments, question: "What do we know about retries?" }), /Connect a Meta key/);
  const briefs = await listBrainBriefs(env.ctx, olivia, payments);
  assert.equal(briefs.length, 0);
});

test("brain activity assembles briefs and approvals newest first", async () => {
  const app = openApp(env.ctx);
  await loadExample(app);
  const olivia = await personId(env.db, "Olivia Owner");
  const agent = await personId(env.db, "Coding Agent");
  const acme = await idOf(env.db, "organizations", "acme-synthetic");
  const payments = await idOf(env.db, "projects", "payments");
  await createBrainBrief(env.ctx, olivia, {
    projectId: payments, agentId: agent, model: "test-model", content: "Activity brief.", citations: [],
  });
  const activity = await listBrainActivity(env.ctx, olivia, acme);
  assert.ok(activity.length > 0);
  assert.ok(activity.some((event) => event.label.includes("Brain brief")));
  assert.ok(activity.some((event) => event.label.includes("Approved:")));
  for (let i = 1; i < activity.length; i += 1) {
    assert.ok(activity[i - 1]!.at.getTime() >= activity[i]!.at.getTime(), "newest first");
  }
});

async function ruleBasedOn(
  proposer: Principal,
  reviewer: Principal,
  scope: ScopeRef,
  name: string,
  memoryIds: string[],
): Promise<Definition> {
  const proposal = await proposeDefinition(env.ctx, proposer.id, {
    scope,
    kind: "rule",
    name,
    purpose: "Synthetic purpose.",
    responsibilities: ["Synthetic duty"],
    links: memoryIds.map((targetId) => ({ relation: "based_on" as const, targetId })),
  });
  return approveDefinitionProposal(env.ctx, reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
}

async function revise(
  proposer: Principal,
  reviewer: Principal,
  memory: Memory,
  title: string,
  sourceId: string,
  links?: Array<{ relation: "conflicts_with"; memoryId: string }>,
): Promise<Memory> {
  const proposal = await proposeChange(env.ctx, proposer.id, {
    memoryId: memory.id,
    expectedRevision: memory.revision,
    kind: "revise",
    type: memory.type,
    title,
    content: `Synthetic body for "${title}".`,
    evidenceSourceIds: [sourceId],
    ...(links ? { relations: { links } } : {}),
  });
  return approveProposal(env.ctx, reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
}

async function decide(
  proposer: Principal,
  reviewer: Principal,
  projectId: string,
  title: string,
  sourceId: string,
  options: { applicability?: DecisionApplicabilityInput; conflictsWith?: string } = {},
): Promise<Memory> {
  const proposal = await proposeMemory(env.ctx, proposer.id, {
    projectId,
    type: "decision",
    title,
    content: `Synthetic body for "${title}".`,
    evidenceSourceIds: [sourceId],
    ...(options.applicability ? { applicability: options.applicability } : {}),
    ...(options.conflictsWith ? { relations: { links: [{ relation: "conflicts_with", memoryId: options.conflictsWith }] } } : {}),
  });
  return approveProposal(env.ctx, reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
}

function recommendationsFor(callerId: string, world: World, projectId?: string): Promise<BrainRecommendation[]> {
  return listBrainRecommendations(env.ctx, callerId, { organizationId: world.orgA.id, ...(projectId ? { projectId } : {}) });
}

async function ofKind(
  kind: BrainRecommendationKind,
  callerId: string,
  world: World,
  projectId?: string,
): Promise<BrainRecommendation[]> {
  return (await recommendationsFor(callerId, world, projectId)).filter((item) => item.kind === kind);
}

test("recommends reviewing a definition whose based-on decision changed after its approval", async () => {
  const world = await buildWorld(env.ctx);
  const { contributor, reviewer, reader } = world.people;
  const memory = world.memories.alphaApproved;
  const rule = await ruleBasedOn(contributor, reviewer, project(world.alpha.id), "Alpha retries are bounded", [memory.id]);
  assert.deepEqual(await recommendationsFor(contributor.id, world), [], "nothing changed after approval");

  env.advance(60_000);
  const revised = await revise(contributor, reviewer, memory, "Alpha retries once", world.sources.alpha.id);
  const fresh = await ruleBasedOn(contributor, reviewer, project(world.alpha.id), "Alpha retries follow the decision", [memory.id]);
  const [outdated, ...others] = await recommendationsFor(contributor.id, world, world.alpha.id);
  assert.ok(outdated);
  assert.deepEqual(others, [], "a definition approved after the change is current");
  assert.equal(outdated.kind, "definition_outdated");
  assert.equal(outdated.projectId, world.alpha.id);
  assert.equal(outdated.projectName, "Alpha");
  assert.deepEqual(outdated.subject, { kind: "definition", id: rule.id, title: "Alpha retries are bounded" });
  assert.equal(
    outdated.reason,
    "“Alpha retries are bounded” is based on “Alpha retries once”, which was revised after this definition was approved.",
  );
  assert.deepEqual(outdated.related, [{ kind: "memory", id: memory.id, title: "Alpha retries once" }]);
  assert.deepEqual(outdated.actions, [
    { label: "Open the definition", href: `/definitions/${rule.id}` },
    { label: "Propose a change", href: `/definitions/${rule.id}#propose-change` },
    { label: "Open the changed decision", href: `/memories/${memory.id}` },
  ]);
  assert.equal(outdated.at?.getTime(), revised.approvedAt.getTime());
  assert.notEqual(outdated.subject.id, fresh.id);

  const forReader = await ofKind("definition_outdated", reader.id, world);
  assert.deepEqual(
    forReader.map((item) => item.actions.map((action) => action.label)),
    [["Open the definition", "Open the changed decision"]],
    "readers cannot propose, so they get no change form",
  );
  const findings = await analyzeBrainHealth(env.ctx, contributor.id, { organizationId: world.orgA.id });
  assert.deepEqual(findings.find((finding) => finding.kind === "outdated_definitions"), {
    kind: "outdated_definitions",
    projectId: world.alpha.id,
    projectName: "Alpha",
    count: 1,
    href: `/projects/${world.alpha.id}#brain-recommendations`,
    label: "1 definition is based on decisions that changed in Alpha",
  });
});

test("a higher-level definition is recommended only to people who can read the changed decision", async () => {
  const world = await buildWorld(env.ctx);
  const { ownerA, adminA, orgReader, reader } = world.people;
  const beta = world.memories.betaApproved;
  const rule = await ruleBasedOn(ownerA, adminA, { level: "organization", id: world.orgA.id }, "Pin vendor SDKs", [beta.id]);
  env.advance(60_000);
  await revise(ownerA, adminA, beta, "Beta unpins the SDK", world.sources.beta.id);

  const [seen] = await ofKind("definition_outdated", orgReader.id, world);
  assert.ok(seen);
  assert.equal(seen.projectId, null);
  assert.equal(seen.projectName, null);
  assert.deepEqual(seen.subject, { kind: "definition", id: rule.id, title: "Pin vendor SDKs" });
  assert.deepEqual(seen.related, [{ kind: "memory", id: beta.id, title: "Beta unpins the SDK" }]);
  assert.deepEqual(
    (await ofKind("definition_outdated", orgReader.id, world, world.beta.id)).map((item) => item.subject.id),
    [rule.id],
    "listed in the project whose decision changed",
  );
  assert.deepEqual(await recommendationsFor(orgReader.id, world, world.alpha.id), [], "not in other projects");
  const orgFindings = await analyzeBrainHealth(env.ctx, orgReader.id, { organizationId: world.orgA.id });
  assert.deepEqual(orgFindings.find((finding) => finding.kind === "outdated_definitions"), {
    kind: "outdated_definitions",
    projectId: null,
    projectName: null,
    count: 1,
    href: `/definitions/${rule.id}`,
    label: "1 organization or business-unit definition is based on decisions that changed",
  });

  // The alpha reader may read the organization's rule, but not the beta decision it is based on.
  const hidden = await recommendationsFor(reader.id, world);
  assert.deepEqual(hidden, []);
  const readerFindings = await analyzeBrainHealth(env.ctx, reader.id, { organizationId: world.orgA.id });
  assert.ok(!readerFindings.some((finding) => finding.kind === "outdated_definitions"));
  assert.ok(!JSON.stringify(readerFindings).includes(beta.id));
  await assert.rejects(
    () => listBrainRecommendations(env.ctx, reader.id, { organizationId: world.orgA.id, projectId: world.beta.id }),
    /Project not found/,
  );
  await assert.rejects(
    () => listBrainRecommendations(env.ctx, world.people.outsider.id, { organizationId: world.orgA.id }),
    /Organization not found/,
  );
});

test("recommends a revision when a current decision has repeated open outdated reports", async () => {
  const world = await buildWorld(env.ctx);
  const { reader, agent, contributor, reviewer, orgReader, buAdmin, adminA } = world.people;
  const memory = world.memories.alphaApproved;
  await reportOutdated(env.ctx, reader.id, { memoryId: memory.id, reason: "Synthetic: the queue changed" });
  assert.deepEqual(await ofKind("recurring_reports", contributor.id, world), [], "one report is not a pattern");

  env.advance(60_000);
  const second = await reportOutdated(env.ctx, agent.id, { memoryId: memory.id, reason: "Synthetic: retries differ now" });
  const [recurring] = await ofKind("recurring_reports", contributor.id, world, world.alpha.id);
  assert.ok(recurring);
  assert.deepEqual(recurring.subject, { kind: "memory", id: memory.id, title: "Alpha uses queue retries" });
  assert.equal(recurring.reason, "“Alpha uses queue retries” has 2 open reports that it may be outdated.");
  assert.deepEqual(recurring.actions, [
    { label: "Open the decision", href: `/memories/${memory.id}` },
    { label: "Propose a revision", href: `/memories/${memory.id}#propose-change` },
  ]);
  assert.equal(recurring.at?.getTime(), second.reportedAt.getTime());
  assert.deepEqual(
    (await ofKind("recurring_reports", reader.id, world)).map((item) => item.actions.map((action) => action.label)),
    [["Open the decision"]],
  );

  const beta = world.memories.betaApproved;
  await reportOutdated(env.ctx, orgReader.id, { memoryId: beta.id, reason: "Synthetic: the vendor fixed it" });
  await reportOutdated(env.ctx, buAdmin.id, { memoryId: beta.id, reason: "Synthetic: 4.3 is out" });
  assert.deepEqual(
    (await ofKind("recurring_reports", adminA.id, world)).map((item) => item.subject.id).sort(),
    [memory.id, beta.id].sort(),
  );
  assert.deepEqual(
    (await ofKind("recurring_reports", reader.id, world)).map((item) => item.subject.id),
    [memory.id],
    "reports on a decision the reader cannot read stay hidden",
  );

  await dismissReport(env.ctx, reviewer.id, { reportId: second.id, reason: "Synthetic: still correct" });
  assert.deepEqual(await ofKind("recurring_reports", contributor.id, world), [], "a dismissed report no longer counts");
});

test("recommends updating an agent's instructions when reviewers keep rejecting its attempts on a decision", async () => {
  const world = await buildWorld(env.ctx);
  const { agent, contributor, reviewer, reader } = world.people;
  const memory = world.memories.alphaApproved;
  const evidenceSourceIds = [world.sources.alpha.id];
  const rejectAll = async (proposal: { id: string; revision: number }) =>
    rejectProposal(env.ctx, reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision, reason: "Synthetic: contradicts the decision" });

  await rejectAll(await proposeChange(env.ctx, agent.id, {
    memoryId: memory.id, expectedRevision: memory.revision, kind: "revise", type: "decision",
    title: "Alpha retries forever", content: "Synthetic unbounded retries.", evidenceSourceIds,
  }));
  await rejectAll(await proposeChange(env.ctx, contributor.id, {
    memoryId: memory.id, expectedRevision: memory.revision, kind: "replace", type: "decision",
    title: "Alpha drops retries", content: "Synthetic human proposal.", evidenceSourceIds,
  }));
  assert.deepEqual(await ofKind("rejected_agent_attempts", contributor.id, world), [], "one agent attempt is not a pattern; people's do not count");

  env.advance(100 * DAY);
  await grantRepositoryRead(env.ctx, "1001", [agent, contributor, reviewer, reader]);
  const last = await rejectAll(await proposeMemory(env.ctx, agent.id, {
    projectId: world.alpha.id, type: "decision", title: "Alpha retries without backoff",
    content: "Synthetic retries with no delay.", evidenceSourceIds, ownerId: contributor.id,
    relations: { links: [{ relation: "conflicts_with", memoryId: memory.id }] },
  }));

  const [attempts] = await ofKind("rejected_agent_attempts", contributor.id, world, world.alpha.id);
  assert.ok(attempts);
  assert.deepEqual(attempts.subject, { kind: "memory", id: memory.id, title: "Alpha uses queue retries" });
  assert.equal(
    attempts.reason,
    "Reviewers rejected 2 agent proposals in the last 180 days that would change or contradict “Alpha uses queue retries”.",
  );
  assert.deepEqual(attempts.related, []);
  assert.deepEqual(attempts.actions, [
    { label: "Open the decision", href: `/memories/${memory.id}` },
    { label: "Update the agent's instructions", href: `/scopes/project/${world.alpha.id}/definitions` },
  ]);
  assert.equal(attempts.at?.getTime(), last.reviewedAt?.getTime());
  for (const viewer of [reader, agent]) {
    assert.deepEqual(await ofKind("rejected_agent_attempts", viewer.id, world), [], `${viewer.displayName} never gets this kind`);
    const findings = await analyzeBrainHealth(env.ctx, viewer.id, { organizationId: world.orgA.id });
    assert.ok(!findings.some((finding) => finding.kind === "rejected_agent_attempts"));
  }

  const proposal = await proposeDefinition(env.ctx, contributor.id, {
    scope: project(world.alpha.id), kind: "agent", name: "Alpha coding agent",
    purpose: "Synthetic purpose.", responsibilities: ["Synthetic duty"], runsAs: agent.id,
  });
  const agentDefinition = await approveDefinitionProposal(env.ctx, reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
  const [linked] = await ofKind("rejected_agent_attempts", reviewer.id, world);
  assert.deepEqual(linked?.related, [{ kind: "definition", id: agentDefinition.id, title: "Alpha coding agent" }]);
  assert.deepEqual(linked?.actions.at(-1), {
    label: "Update the agent's instructions",
    href: `/definitions/${agentDefinition.id}#propose-change`,
  });
  const findings = await analyzeBrainHealth(env.ctx, reviewer.id, { organizationId: world.orgA.id });
  assert.equal(findings.find((finding) => finding.kind === "rejected_agent_attempts")?.count, 1);

  // 190 days after the first rejection, only the second is inside the window.
  env.advance(90 * DAY);
  await grantRepositoryRead(env.ctx, "1001", [contributor, reviewer]);
  assert.deepEqual(await ofKind("rejected_agent_attempts", contributor.id, world), []);
});

test("recommends resolving current decisions linked as conflicting while they can apply together", async () => {
  const world = await buildWorld(env.ctx);
  const { contributor, reviewer, reader, orgReader, ownerA, adminA } = world.people;
  const source = world.sources.alpha.id;
  const main = { repositoryId: "1001", branch: "main", validFrom: START.toISOString() };
  const base = await decide(contributor, reviewer, world.alpha.id, "Alpha deploys on Fridays", source, { applicability: main });
  env.advance(60_000);
  const rival = await decide(contributor, reviewer, world.alpha.id, "Alpha never deploys on Fridays", source, {
    applicability: main, conflictsWith: base.id,
  });
  await decide(contributor, reviewer, world.alpha.id, "Release branches freeze on Fridays", source, {
    applicability: { ...main, branch: "release/next" }, conflictsWith: base.id,
  });
  env.advance(60_000);
  const brief = await decide(contributor, reviewer, world.alpha.id, "Alpha deploys on Fridays this morning", source, {
    applicability: { ...main, validUntil: new Date(START.getTime() + 2 * HOUR).toISOString() }, conflictsWith: base.id,
  });
  const pairs = async () => (await ofKind("conflicting_decisions", reader.id, world, world.alpha.id))
    .map((item) => [item.subject.id, item.related.map((record) => record.id)]);

  assert.deepEqual(await pairs(), [[brief.id, [base.id]], [rival.id, [base.id]]], "another branch can never overlap; newest first");
  const [, pair] = await ofKind("conflicting_decisions", reader.id, world);
  assert.ok(pair);
  assert.equal(pair.reason, "“Alpha never deploys on Fridays” and “Alpha deploys on Fridays” are linked as conflicting, and both can apply now.");
  assert.deepEqual(pair.actions, [
    { label: "Open the decision", href: `/memories/${rival.id}` },
    { label: "Open the conflicting decision", href: `/memories/${base.id}` },
  ]);
  assert.equal(pair.at?.getTime(), rival.approvedAt.getTime());

  env.advance(60_000);
  await revise(contributor, reviewer, base, "Alpha deploys on Fridays after review", source, [
    { relation: "conflicts_with", memoryId: rival.id },
  ]);
  assert.deepEqual(
    (await pairs()).sort(),
    [[base.id, [rival.id]], [brief.id, [base.id]]].sort(),
    "a pair linked from both sides counts once, led by its newest version",
  );

  env.advance(3 * HOUR);
  await grantRepositoryRead(env.ctx, "1001", [contributor, reader]);
  assert.deepEqual(await pairs(), [[base.id, [rival.id]]], "a window that has ended cannot overlap now");
  const findings = await analyzeBrainHealth(env.ctx, reader.id, { organizationId: world.orgA.id });
  assert.deepEqual(findings.find((finding) => finding.kind === "conflicting_decisions"), {
    kind: "conflicting_decisions",
    projectId: world.alpha.id,
    projectName: "Alpha",
    count: 1,
    href: `/projects/${world.alpha.id}#brain-recommendations`,
    label: "1 pair of current decisions linked as conflicting in Alpha",
  });
  await suspendMemory(env.ctx, contributor.id, { memoryId: rival.id, expectedRevision: rival.revision, reason: "Synthetic dispute" });
  assert.deepEqual(await pairs(), [], "a suspended decision is not current");

  await grantRepositoryRead(env.ctx, "1002", [ownerA, adminA, orgReader]);
  const betaRival = await decide(ownerA, adminA, world.beta.id, "Beta floats the SDK version", world.sources.beta.id, {
    conflictsWith: world.memories.betaApproved.id,
  });
  assert.ok((await ofKind("conflicting_decisions", orgReader.id, world)).some((item) => item.subject.id === betaRival.id));
  assert.ok(!JSON.stringify(await recommendationsFor(reader.id, world)).includes(betaRival.id), "no leak to a reader without access");
});

test("recommendations come newest first and are capped", async () => {
  const world = await buildWorld(env.ctx);
  const { contributor, reviewer, reader, agent } = world.people;
  const memory = world.memories.alphaApproved;
  await ruleBasedOn(contributor, reviewer, project(world.alpha.id), "Alpha retries are bounded", [memory.id]);
  env.advance(60_000);
  await revise(contributor, reviewer, memory, "Alpha retries once", world.sources.alpha.id);
  env.advance(60_000);
  await decide(contributor, reviewer, world.alpha.id, "Alpha retries in the client", world.sources.alpha.id, { conflictsWith: memory.id });
  env.advance(60_000);
  await reportOutdated(env.ctx, reader.id, { memoryId: memory.id, reason: "Synthetic: unclear" });
  await reportOutdated(env.ctx, agent.id, { memoryId: memory.id, reason: "Synthetic: outdated" });

  const all = await recommendationsFor(contributor.id, world);
  assert.deepEqual(all.map((item) => item.kind), ["recurring_reports", "conflicting_decisions", "definition_outdated"]);
  const capped = await listBrainRecommendations(env.ctx, contributor.id, { organizationId: world.orgA.id, limit: 1 });
  assert.deepEqual(capped, all.slice(0, 1));
  await assert.rejects(
    () => listBrainRecommendations(env.ctx, contributor.id, { organizationId: world.orgA.id, limit: 201 }),
    /limit must be at most 200/,
  );
});
