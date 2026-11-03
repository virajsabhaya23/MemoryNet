import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveDefinitionProposal,
  approveProposal,
  ConflictError,
  ForbiddenError,
  getDefinition,
  getDefinitionProposal,
  listDefinitionProposals,
  listDefinitions,
  NotFoundError,
  proposeChange,
  proposeDefinition,
  proposeDefinitionChange,
  proposeDefinitionRetirement,
  rejectDefinitionProposal,
  suspendMemory,
  ValidationError,
  type Definition,
  type DefinitionKind,
  type DefinitionLink,
  type MemoryNetContext,
  type Principal,
  type ScopeRef,
} from "../src/index.ts";
import { buildWorld, project, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();

function content(
  name: string,
  extra: { links?: DefinitionLink[]; runsAs?: string; ownerId?: string } = {},
) {
  return {
    name,
    purpose: `Synthetic purpose of ${name}.`,
    responsibilities: [`Synthetic duty of ${name}`],
    boundaries: ["Never changes production data"],
    instructions: "Synthetic step one.\nSynthetic step two.",
    ...extra,
  };
}

async function approvedDefinition(
  ctx: MemoryNetContext,
  proposer: Principal,
  reviewer: Principal,
  scope: ScopeRef,
  kind: DefinitionKind,
  name: string,
  extra: Parameters<typeof content>[1] = {},
): Promise<Definition> {
  const proposal = await proposeDefinition(ctx, proposer.id, {
    scope,
    kind,
    ...content(name, extra),
  });
  return approveDefinitionProposal(ctx, reviewer.id, {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
  });
}

function organization(id: string): ScopeRef {
  return { level: "organization", id };
}

function names(definitions: Definition[]): string[] {
  return definitions.map((definition) => definition.name).sort();
}

test("a contributor proposes a rule and a different reviewer approves it as version 1", async () => {
  const ctx = env.ctx;
  const world = await buildWorld(ctx);
  const { contributor, reviewer, reader, agent, outsider } = world.people;
  const proposal = await proposeDefinition(ctx, contributor.id, {
    scope: project(world.alpha.id),
    kind: "rule",
    ...content("Alpha retries are bounded", {
      links: [
        { relation: "based_on", targetId: world.memories.alphaApproved.id },
      ],
    }),
  });
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.action, "create");
  assert.equal(
    proposal.ownerId,
    contributor.id,
    "the owner defaults to the person proposing",
  );
  assert.deepEqual(
    await listDefinitions(ctx, reader.id, { organizationId: world.orgA.id }),
    [],
  );

  await assert.rejects(
    approveDefinitionProposal(ctx, contributor.id, {
      proposalId: proposal.id,
      expectedRevision: 1,
    }),
    ForbiddenError,
    "nobody approves their own proposal",
  );
  for (const hidden of [reader, agent, outsider]) {
    await assert.rejects(
      getDefinitionProposal(ctx, hidden.id, proposal.id),
      NotFoundError,
    );
  }
  await assert.rejects(
    approveDefinitionProposal(ctx, reviewer.id, {
      proposalId: proposal.id,
      expectedRevision: 2,
    }),
    ConflictError,
    "approval names the exact version",
  );
  const definition = await approveDefinitionProposal(ctx, reviewer.id, {
    proposalId: proposal.id,
    expectedRevision: 1,
  });
  assert.equal(definition.revision, 1);
  assert.equal(definition.status, "active");
  assert.equal(definition.approvedBy, reviewer.id);
  assert.deepEqual(definition.links, [
    { relation: "based_on", targetId: world.memories.alphaApproved.id },
  ]);

  const view = await getDefinition(ctx, reader.id, definition.id);
  assert.deepEqual(
    view.linkedMemories.map((memory) => memory.id),
    [world.memories.alphaApproved.id],
  );
  assert.equal(view.pending, null, "readers never see proposals");
  assert.equal(view.history.length, 1);
  await assert.rejects(
    getDefinition(ctx, outsider.id, definition.id),
    NotFoundError,
  );

  const audit = await env.db.query<{
    action: string;
    details: Record<string, unknown>;
  }>(
    "SELECT action, details FROM audit_events WHERE action LIKE 'definition.%' ORDER BY id",
  );
  assert.deepEqual(
    audit.rows.map((row) => row.action),
    ["definition.proposed", "definition.approved"],
  );
  assert.doesNotMatch(
    JSON.stringify(audit.rows),
    /Alpha retries are bounded|Synthetic duty/,
  );
});

test("guidance flows down to the projects inside, never sideways", async () => {
  const ctx = env.ctx;
  const world = await buildWorld(ctx);
  const { ownerA, adminA, buAdmin, reader, orgReader, outsider, ownerB } =
    world.people;
  await approvedDefinition(
    ctx,
    ownerA,
    adminA,
    organization(world.orgA.id),
    "rule",
    "No secrets in chat",
  );
  await approvedDefinition(
    ctx,
    buAdmin,
    ownerA,
    { level: "business_unit", id: world.platform.id },
    "instruction",
    "Platform services log in JSON",
  );
  const gammaSkill = await approvedDefinition(
    ctx,
    adminA,
    ownerA,
    project(world.gamma.id),
    "skill",
    "Gamma triage",
  );

  const orgA = { organizationId: world.orgA.id };
  assert.deepEqual(names(await listDefinitions(ctx, reader.id, orgA)), [
    "No secrets in chat",
    "Platform services log in JSON",
  ]);
  assert.deepEqual(names(await listDefinitions(ctx, orgReader.id, orgA)), [
    "Gamma triage",
    "No secrets in chat",
    "Platform services log in JSON",
  ]);
  assert.deepEqual(await listDefinitions(ctx, outsider.id, orgA), []);
  assert.deepEqual(await listDefinitions(ctx, ownerB.id, orgA), []);
  await assert.rejects(
    getDefinition(ctx, reader.id, gammaSkill.id),
    NotFoundError,
  );
});

test("links point to the same level or above, of a fitting kind, and to knowledge the proposer can read", async () => {
  const ctx = env.ctx;
  const world = await buildWorld(ctx);
  const { ownerA, adminA, contributor, reviewer, reader, agent } = world.people;
  const gammaSkill = await approvedDefinition(
    ctx,
    adminA,
    ownerA,
    project(world.gamma.id),
    "skill",
    "Gamma triage",
  );
  const orgRule = await approvedDefinition(
    ctx,
    ownerA,
    adminA,
    organization(world.orgA.id),
    "rule",
    "SDK versions are pinned",
    {
      links: [
        { relation: "based_on", targetId: world.memories.betaApproved.id },
      ],
    },
  );
  const alpha = project(world.alpha.id);
  const propose = (
    kind: DefinitionKind,
    links: DefinitionLink[],
    extra: { runsAs?: string } = {},
  ) =>
    proposeDefinition(ctx, contributor.id, {
      scope: alpha,
      kind,
      ...content(`Synthetic ${kind} ${links.length}`, { links, ...extra }),
    });

  await assert.rejects(
    propose("agent", [{ relation: "uses", targetId: gammaSkill.id }]),
    ValidationError,
    "no sideways links",
  );
  await assert.rejects(
    propose("agent", [{ relation: "uses", targetId: orgRule.id }]),
    ValidationError,
    "agents use skills, not rules",
  );
  await assert.rejects(
    propose("rule", [{ relation: "uses", targetId: orgRule.id }]),
    /A rule cannot have a "uses" link/,
  );
  await assert.rejects(
    propose("rule", [
      { relation: "based_on", targetId: world.memories.betaApproved.id },
    ]),
    ValidationError,
    "memories must be inside the level and readable",
  );
  await assert.rejects(
    propose("rule", [{ relation: "follows", targetId: orgRule.id }], {
      runsAs: agent.id,
    }),
    /Only an agent/,
  );
  const followsUp = await propose(
    "agent",
    [{ relation: "follows", targetId: orgRule.id }],
    { runsAs: agent.id },
  );
  assert.equal(followsUp.runsAs, agent.id);
  await assert.rejects(
    proposeDefinition(ctx, ownerA.id, {
      scope: organization(world.orgA.id),
      kind: "agent",
      ...content("Org agent", { runsAs: agent.id }),
    }),
    /runsAs must be an agent account with a role covering this level/,
  );
  await assert.rejects(
    proposeDefinition(ctx, ownerA.id, {
      scope: organization(world.orgA.id),
      kind: "rule",
      ...content("Owned by a project reader", { ownerId: reader.id }),
    }),
    /ownerId must be a person with a role covering this level/,
  );

  const readerView = await getDefinition(ctx, reader.id, orgRule.id);
  assert.deepEqual(
    readerView.definition.links,
    [],
    "links to knowledge the reader cannot read are left out",
  );
  assert.deepEqual(readerView.linkedMemories, []);
  const approved = await approveDefinitionProposal(ctx, reviewer.id, {
    proposalId: followsUp.id,
    expectedRevision: 1,
  });
  const ruleView = await getDefinition(ctx, reader.id, orgRule.id);
  assert.deepEqual(
    ruleView.usedBy.map((use) => [use.relation, use.definition.id]),
    [["follows", approved.id]],
  );
});

test("two changes at once: the second approval gets a conflict instead of overwriting", async () => {
  const ctx = env.ctx;
  const world = await buildWorld(ctx);
  const { contributor, reviewer, agent } = world.people;
  const skill = await approvedDefinition(
    ctx,
    contributor,
    reviewer,
    project(world.alpha.id),
    "skill",
    "Summarize a PR",
  );
  const change = (by: Principal, duty: string) =>
    proposeDefinitionChange(ctx, by.id, {
      definitionId: skill.id,
      baseRevision: 1,
      ...content("Summarize a PR"),
      responsibilities: [...skill.responsibilities, duty],
    });
  const first = await change(contributor, "Quote the merge commit");
  const second = await change(agent, "Name the reviewers");
  assert.equal(
    second.ownerId,
    contributor.id,
    "a change keeps the current owner unless it names another",
  );

  await approveDefinitionProposal(ctx, reviewer.id, {
    proposalId: first.id,
    expectedRevision: 1,
  });
  await assert.rejects(
    approveDefinitionProposal(ctx, reviewer.id, {
      proposalId: second.id,
      expectedRevision: 1,
    }),
    /it is now at version 2/,
  );
  await assert.rejects(
    change(contributor, "Anything"),
    /Reload to see version 2/,
  );
  await assert.rejects(
    proposeDefinitionChange(ctx, contributor.id, {
      definitionId: skill.id,
      baseRevision: 2,
      ...content("Summarize a PR"),
      responsibilities: [...skill.responsibilities, "Quote the merge commit"],
    }),
    /Nothing changed/,
  );
  const rejected = await rejectDefinitionProposal(ctx, reviewer.id, {
    proposalId: second.id,
    expectedRevision: 1,
    reason: "Written against version 1",
  });
  assert.equal(rejected.status, "rejected");
  const view = await getDefinition(ctx, contributor.id, skill.id);
  assert.equal(view.definition.revision, 2);
  assert.deepEqual(view.definition.responsibilities, [
    "Synthetic duty of Summarize a PR",
    "Quote the merge commit",
  ]);
  assert.deepEqual(view.pending, []);
});

test("retiring keeps the history, and restoring older content needs a new review", async () => {
  const ctx = env.ctx;
  const world = await buildWorld(ctx);
  const { contributor, reviewer } = world.people;
  const alpha = project(world.alpha.id);
  const skill = await approvedDefinition(
    ctx,
    contributor,
    reviewer,
    alpha,
    "skill",
    "Check a change",
  );
  const retire = await proposeDefinitionRetirement(ctx, contributor.id, {
    definitionId: skill.id,
    baseRevision: 1,
    reason: "Replaced by the review checklist",
  });
  const retired = await approveDefinitionProposal(ctx, reviewer.id, {
    proposalId: retire.id,
    expectedRevision: 1,
  });
  assert.equal(retired.status, "retired");
  assert.equal(retired.revision, 2);
  assert.equal(
    retired.name,
    "Check a change",
    "a retired version keeps its content",
  );
  await assert.rejects(
    proposeDefinition(ctx, contributor.id, {
      scope: alpha,
      kind: "agent",
      ...content("Uses a retired skill", {
        links: [{ relation: "uses", targetId: skill.id }],
      }),
    }),
    /must be active/,
  );

  const restore = await proposeDefinitionChange(ctx, contributor.id, {
    definitionId: skill.id,
    baseRevision: 2,
    ...content("Check a change"),
    changeNote: "Restore version 1",
  });
  const restored = await approveDefinitionProposal(ctx, reviewer.id, {
    proposalId: restore.id,
    expectedRevision: 1,
  });
  assert.equal(restored.status, "active");
  assert.equal(restored.revision, 3);
  const view = await getDefinition(ctx, contributor.id, skill.id);
  assert.deepEqual(
    view.history.map((version) => [
      version.revision,
      version.status,
      version.changeNote,
    ]),
    [
      [3, "active", "Restore version 1"],
      [2, "retired", "Replaced by the review checklist"],
      [1, "active", null],
    ],
  );
});

test("secrets are refused, personal data is flagged, and names are unique per kind and level", async () => {
  const ctx = env.ctx;
  const world = await buildWorld(ctx);
  const { contributor, reviewer } = world.people;
  const alpha = project(world.alpha.id);
  await assert.rejects(
    proposeDefinition(ctx, contributor.id, {
      scope: alpha,
      kind: "instruction",
      ...content("Deploy steps"),
      instructions: "Use password=Synthetic42Value when deploying.",
    }),
    /instructions looks like it contains a secret/,
  );
  const flagged = await proposeDefinition(ctx, contributor.id, {
    scope: alpha,
    kind: "instruction",
    ...content("Escalation contact"),
    purpose: "Escalate to synthetic.person@example.com.",
  });
  assert.deepEqual(flagged.flags, ["personal_data"]);
  await assert.rejects(
    proposeDefinition(ctx, contributor.id, {
      scope: alpha,
      kind: "instruction",
      ...content("escalation CONTACT"),
    }),
    /already waiting for review/,
  );
  await approveDefinitionProposal(ctx, reviewer.id, {
    proposalId: flagged.id,
    expectedRevision: 1,
  });
  await assert.rejects(
    proposeDefinition(ctx, contributor.id, {
      scope: alpha,
      kind: "instruction",
      ...content("Escalation contact"),
    }),
    /An active instruction with this name already exists here/,
  );
  const sameNameOtherKind = await proposeDefinition(ctx, contributor.id, {
    scope: alpha,
    kind: "rule",
    ...content("Escalation contact"),
  });
  assert.equal(sameNameOtherKind.status, "pending");
});

test("agents propose for a named person but never see proposals or review", async () => {
  const ctx = env.ctx;
  const world = await buildWorld(ctx);
  const { agent, contributor, reviewer } = world.people;
  const alpha = project(world.alpha.id);
  await assert.rejects(
    proposeDefinition(ctx, agent.id, {
      scope: alpha,
      kind: "skill",
      ...content("Agent skill"),
    }),
    /Agents must name a person/,
  );
  const proposal = await proposeDefinition(ctx, agent.id, {
    scope: alpha,
    kind: "skill",
    ...content("Agent skill", { ownerId: contributor.id }),
  });
  await assert.rejects(
    getDefinitionProposal(ctx, agent.id, proposal.id),
    NotFoundError,
  );
  assert.deepEqual(
    await listDefinitionProposals(ctx, agent.id, {
      organizationId: world.orgA.id,
    }),
    [],
  );
  await assert.rejects(
    approveDefinitionProposal(ctx, agent.id, {
      proposalId: proposal.id,
      expectedRevision: 1,
    }),
    ForbiddenError,
  );
  const seen = await getDefinitionProposal(ctx, reviewer.id, proposal.id);
  assert.equal(seen.proposal.proposedBy, agent.id);
});

test("only reviewers at the definition's own level approve it", async () => {
  const ctx = env.ctx;
  const world = await buildWorld(ctx);
  const { ownerA, adminA, contributor, reviewer, orgReader } = world.people;
  await assert.rejects(
    proposeDefinition(ctx, contributor.id, {
      scope: organization(world.orgA.id),
      kind: "rule",
      ...content("Project people cannot write org rules"),
    }),
    NotFoundError,
  );
  const proposal = await proposeDefinition(ctx, ownerA.id, {
    scope: organization(world.orgA.id),
    kind: "rule",
    ...content("Org rule"),
  });
  for (const lower of [reviewer, orgReader]) {
    await assert.rejects(
      approveDefinitionProposal(ctx, lower.id, {
        proposalId: proposal.id,
        expectedRevision: 1,
      }),
      NotFoundError,
    );
  }
  const approved = await approveDefinitionProposal(ctx, adminA.id, {
    proposalId: proposal.id,
    expectedRevision: 1,
  });
  assert.deepEqual(approved.scope, organization(world.orgA.id));
});

test("a link to knowledge that is later suspended or replaced stays visible and reviewable, but new links need current knowledge", async () => {
  const ctx = env.ctx;
  const world = await buildWorld(ctx);
  const { contributor, reviewer, reader } = world.people;
  const memory = world.memories.alphaApproved;
  const basedOnMemory = [{ relation: "based_on" as const, targetId: memory.id }];
  const rule = await approvedDefinition(
    ctx,
    contributor,
    reviewer,
    project(world.alpha.id),
    "rule",
    "Alpha retries are bounded",
    { links: basedOnMemory },
  );
  const pendingNew = await proposeDefinition(ctx, contributor.id, {
    scope: project(world.alpha.id),
    kind: "instruction",
    ...content("Alpha retry notes", { links: basedOnMemory }),
  });
  await suspendMemory(ctx, contributor.id, {
    memoryId: memory.id,
    expectedRevision: memory.revision,
    reason: "Synthetic dispute",
  });

  const view = await getDefinition(ctx, reader.id, rule.id);
  assert.deepEqual(view.definition.links, basedOnMemory);
  assert.deepEqual(
    view.linkedMemories.map((item) => [item.id, item.status]),
    [[memory.id, "suspended"]],
    "suspended knowledge stays readable, so the link stays visible",
  );
  await assert.rejects(
    proposeDefinition(ctx, contributor.id, {
      scope: project(world.alpha.id),
      kind: "rule",
      ...content("Alpha waits for review", { links: basedOnMemory }),
    }),
    ValidationError,
    "a new link needs current knowledge",
  );
  await assert.rejects(
    approveDefinitionProposal(ctx, reviewer.id, {
      proposalId: pendingNew.id,
      expectedRevision: pendingNew.revision,
    }),
    ConflictError,
    "a link written while the memory was current is refused once it is not",
  );

  const change = await proposeDefinitionChange(ctx, contributor.id, {
    definitionId: rule.id,
    baseRevision: rule.revision,
    ...content("Alpha retries are bounded", { links: basedOnMemory }),
    purpose: "Synthetic purpose, reworded.",
  });
  assert.equal(
    (await getDefinitionProposal(ctx, reviewer.id, change.id)).proposal.id,
    change.id,
  );
  assert.deepEqual(
    (
      await listDefinitionProposals(ctx, reviewer.id, {
        organizationId: world.orgA.id,
        status: "pending",
      })
    )
      .map((item) => item.id)
      .sort(),
    [change.id, pendingNew.id].sort(),
  );
  const next = await approveDefinitionProposal(ctx, reviewer.id, {
    proposalId: change.id,
    expectedRevision: change.revision,
  });
  assert.deepEqual(next.links, basedOnMemory, "a change may keep its link");

  const replacement = await proposeChange(ctx, contributor.id, {
    memoryId: memory.id,
    expectedRevision: memory.revision,
    kind: "replace",
    type: "decision",
    title: "Alpha retries twice",
    content: "Synthetic replacement body.",
    evidenceSourceIds: [world.sources.alpha.id],
  });
  await approveProposal(ctx, reviewer.id, {
    proposalId: replacement.id,
    expectedRevision: replacement.revision,
  });
  const replaced = await getDefinition(ctx, reader.id, rule.id);
  assert.deepEqual(
    replaced.linkedMemories.map((item) => [item.id, item.status]),
    [[memory.id, "superseded"]],
  );
});
