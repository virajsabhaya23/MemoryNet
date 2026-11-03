import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveDefinitionProposal,
  getNetwork,
  NotFoundError,
  proposeDefinition,
  proposeDefinitionChange,
  proposeDefinitionRetirement,
  suspendMemory,
  type Definition,
  type DefinitionKind,
  type DefinitionLink,
  type MemoryNetContext,
  type NetworkGraph,
  type Principal,
  type ScopeRef,
} from "../src/index.ts";
import { buildWorld, project, useTestDatabase, type World } from "./helpers.ts";

const env = useTestDatabase();

async function define(
  ctx: MemoryNetContext,
  proposer: Principal,
  reviewer: Principal,
  scope: ScopeRef,
  kind: DefinitionKind,
  name: string,
  extra: { links?: DefinitionLink[]; runsAs?: string } = {},
): Promise<Definition> {
  const proposal = await proposeDefinition(ctx, proposer.id, {
    scope,
    kind,
    name,
    purpose: `Synthetic purpose of ${name}.`,
    responsibilities: [`Synthetic duty of ${name}`],
    ...extra,
  });
  return approveDefinitionProposal(ctx, reviewer.id, {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
  });
}

/** Org rule based on Beta knowledge, a Platform instruction, an org skill, and an Alpha agent using them. */
async function buildNetwork(world: World) {
  const ctx = env.ctx;
  const { ownerA, adminA, buAdmin, contributor, reviewer, agent } =
    world.people;
  const orgRule = await define(
    ctx,
    ownerA,
    adminA,
    { level: "organization", id: world.orgA.id },
    "rule",
    "SDK versions are pinned",
    {
      links: [
        { relation: "based_on", targetId: world.memories.betaApproved.id },
      ],
    },
  );
  const orgSkill = await define(
    ctx,
    ownerA,
    adminA,
    { level: "organization", id: world.orgA.id },
    "skill",
    "Summarize a merged PR",
    {
      links: [{ relation: "follows", targetId: orgRule.id }],
    },
  );
  const platformInstruction = await define(
    ctx,
    buAdmin,
    ownerA,
    { level: "business_unit", id: world.platform.id },
    "instruction",
    "Platform services log in JSON",
  );
  const alphaAgent = await define(
    ctx,
    contributor,
    reviewer,
    project(world.alpha.id),
    "agent",
    "Alpha review assistant",
    {
      runsAs: agent.id,
      links: [
        { relation: "uses", targetId: orgSkill.id },
        { relation: "follows", targetId: platformInstruction.id },
        { relation: "based_on", targetId: world.memories.alphaApproved.id },
      ],
    },
  );
  return { orgRule, orgSkill, platformInstruction, alphaAgent };
}

function nodeIds(graph: NetworkGraph, kind?: string): string[] {
  return graph.nodes
    .filter((node) => kind === undefined || node.kind === kind)
    .map((node) => node.id)
    .sort();
}

function edgeTriples(graph: NetworkGraph): string[] {
  return graph.edges
    .map((edge) => `${edge.from} ${edge.relation} ${edge.to}`)
    .sort();
}

test("the owner's network holds exactly the readable records and their links", async () => {
  const world = await buildWorld(env.ctx);
  const built = await buildNetwork(world);
  const { ownerA, contributor, buAdmin, agent } = world.people;
  const graph = await getNetwork(env.ctx, ownerA.id, world.orgA.id);

  assert.deepEqual(
    graph.clusters.map((cluster) => `${cluster.level}:${cluster.name}`),
    [
      "organization:Synthetic Org A",
      "business_unit:Clinical Tools",
      "project:Gamma",
      "business_unit:Platform",
      "project:Alpha",
      "project:Beta",
    ],
  );
  assert.deepEqual(
    nodeIds(graph, "memory"),
    [
      `memory:${world.memories.alphaApproved.id}`,
      `memory:${world.memories.betaApproved.id}`,
    ].sort(),
  );
  assert.deepEqual(
    nodeIds(graph, "source"),
    [
      `source:${world.sources.alpha.id}`,
      `source:${world.sources.beta.id}`,
    ].sort(),
  );
  assert.equal(graph.nodes.filter((node) => node.kind === "agent").length, 1);
  const alphaAgent = `definition:${built.alphaAgent.id}`;
  const expected = [
    `memory:${world.memories.alphaApproved.id} cites source:${world.sources.alpha.id}`,
    `memory:${world.memories.betaApproved.id} cites source:${world.sources.beta.id}`,
    `principal:${contributor.id} owns memory:${world.memories.alphaApproved.id}`,
    `principal:${ownerA.id} owns memory:${world.memories.betaApproved.id}`,
    `principal:${ownerA.id} owns definition:${built.orgRule.id}`,
    `principal:${ownerA.id} owns definition:${built.orgSkill.id}`,
    `principal:${buAdmin.id} owns definition:${built.platformInstruction.id}`,
    `principal:${contributor.id} owns ${alphaAgent}`,
    `definition:${built.orgRule.id} based_on memory:${world.memories.betaApproved.id}`,
    `definition:${built.orgSkill.id} follows definition:${built.orgRule.id}`,
    `${alphaAgent} uses definition:${built.orgSkill.id}`,
    `${alphaAgent} follows definition:${built.platformInstruction.id}`,
    `${alphaAgent} based_on memory:${world.memories.alphaApproved.id}`,
    `${alphaAgent} runs_as principal:${agent.id}`,
  ].sort();
  assert.deepEqual(edgeTriples(graph), expected);

  const ids = new Set(graph.nodes.map((node) => node.id));
  const clusters = new Set(graph.clusters.map((cluster) => cluster.id));
  for (const edge of graph.edges) {
    assert.ok(
      ids.has(edge.from) && ids.has(edge.to),
      `edge ${edge.id} joins two shown nodes`,
    );
    assert.ok(
      edge.why.length > 0 && edge.table.length > 0,
      "every edge says where it comes from",
    );
  }
  for (const node of graph.nodes) {
    assert.ok(
      clusters.has(node.clusterId),
      `node ${node.id} sits in a shown group`,
    );
  }
  const cluster = (id: string) =>
    graph.nodes.find((node) => node.id === id)?.clusterId;
  assert.equal(
    cluster(`definition:${built.orgRule.id}`),
    `organization:${world.orgA.id}`,
  );
  assert.equal(
    cluster(`definition:${built.platformInstruction.id}`),
    `business_unit:${world.platform.id}`,
  );
  assert.equal(cluster(alphaAgent), `project:${world.alpha.id}`);
  assert.equal(
    cluster(`principal:${contributor.id}`),
    `project:${world.alpha.id}`,
    "people sit in the smallest group holding what they own",
  );
  assert.equal(
    cluster(`principal:${ownerA.id}`),
    `organization:${world.orgA.id}`,
  );
  assert.equal(cluster(`principal:${agent.id}`), `project:${world.alpha.id}`);
});

test("a project reader sees only their part, and nothing hidden leaks through names, links, or counts", async () => {
  const world = await buildWorld(env.ctx);
  const built = await buildNetwork(world);
  const graph = await getNetwork(
    env.ctx,
    world.people.reader.id,
    world.orgA.id,
  );
  assert.deepEqual(
    graph.clusters.map((cluster) => cluster.name),
    ["Synthetic Org A", "Platform", "Alpha"],
  );
  assert.ok(
    nodeIds(graph).includes(`definition:${built.orgRule.id}`),
    "organization rules reach the projects inside",
  );
  assert.ok(
    !graph.edges.some(
      (edge) => edge.to === `memory:${world.memories.betaApproved.id}`,
    ),
    "the link to Beta knowledge is left out",
  );
  const text = JSON.stringify(graph);
  for (const hidden of [
    "Beta",
    "Gamma",
    "Clinical Tools",
    world.memories.betaApproved.id,
    world.memories.betaApproved.title,
    world.sources.beta.id,
    world.memories.deltaApproved.title,
  ]) {
    assert.ok(
      !text.includes(hidden),
      `the reader's network never mentions ${hidden}`,
    );
  }
  assert.ok(
    graph.clusters.every((cluster) => cluster.pendingNewDefinitions === null),
  );
  const agentNode = graph.nodes.find(
    (node) => node.id === `definition:${built.alphaAgent.id}`,
  );
  assert.ok(agentNode && "pendingChanges" in agentNode.details);
  assert.equal(
    agentNode.details.pendingChanges,
    null,
    "readers see no proposal counts",
  );
  assert.equal(
    agentNode.details.runsAsRole,
    undefined,
    "only administrators see the agent account's role",
  );
});

test("people outside the organization get nothing", async () => {
  const world = await buildWorld(env.ctx);
  await buildNetwork(world);
  await assert.rejects(
    getNetwork(env.ctx, world.people.outsider.id, world.orgA.id),
    NotFoundError,
  );
  await assert.rejects(
    getNetwork(env.ctx, world.people.ownerB.id, world.orgA.id),
    NotFoundError,
  );
  const orgB = await getNetwork(env.ctx, world.people.ownerB.id, world.orgB.id);
  assert.ok(!JSON.stringify(orgB).includes("Synthetic Org A"));
});

test("work in progress, retired guidance, and agent accounts are shown as they really are", async () => {
  const world = await buildWorld(env.ctx);
  const built = await buildNetwork(world);
  const { ownerA, adminA, contributor, reviewer, reader } = world.people;
  await proposeDefinitionChange(env.ctx, contributor.id, {
    definitionId: built.alphaAgent.id,
    baseRevision: 1,
    name: "Alpha review assistant",
    purpose: "Synthetic purpose of Alpha review assistant.",
    responsibilities: [
      "Synthetic duty of Alpha review assistant",
      "Quote memory IDs",
    ],
    runsAs: world.people.agent.id,
    links: built.alphaAgent.links,
  });
  await proposeDefinition(env.ctx, contributor.id, {
    scope: project(world.alpha.id),
    kind: "skill",
    name: "Pending skill",
    purpose: "Synthetic.",
    responsibilities: ["Synthetic"],
  });
  const retire = await proposeDefinitionRetirement(env.ctx, ownerA.id, {
    definitionId: built.orgSkill.id,
    baseRevision: 1,
    reason: "Synthetic retirement",
  });
  await approveDefinitionProposal(env.ctx, adminA.id, {
    proposalId: retire.id,
    expectedRevision: 1,
  });

  const agentDetails = async (who: Principal) => {
    const graph = await getNetwork(env.ctx, who.id, world.orgA.id);
    const node = graph.nodes.find(
      (item) => item.id === `definition:${built.alphaAgent.id}`,
    );
    if (!node || !("pendingChanges" in node.details))
      throw new Error("agent node missing");
    return { graph, details: node.details };
  };
  const asReviewer = await agentDetails(reviewer);
  assert.equal(asReviewer.details.pendingChanges, 1);
  assert.deepEqual(asReviewer.details.warnings, [
    "Uses “Summarize a merged PR”, which is retired.",
  ]);
  assert.equal(
    asReviewer.graph.clusters.find(
      (cluster) => cluster.id === `project:${world.alpha.id}`,
    )?.pendingNewDefinitions,
    1,
  );
  const skill = asReviewer.graph.nodes.find(
    (node) => node.id === `definition:${built.orgSkill.id}`,
  );
  assert.equal(skill?.status, "retired");
  assert.equal((await agentDetails(reader)).details.pendingChanges, null);
  assert.equal((await agentDetails(adminA)).details.runsAsRole, "contributor");
  assert.equal(asReviewer.details.runsAsRole, undefined);
});

test("guidance based on knowledge that is no longer current says so, and no line points at it", async () => {
  const world = await buildWorld(env.ctx);
  const built = await buildNetwork(world);
  const { contributor, reviewer } = world.people;
  const memory = world.memories.alphaApproved;
  await proposeDefinitionChange(env.ctx, contributor.id, {
    definitionId: built.alphaAgent.id,
    baseRevision: 1,
    name: "Alpha review assistant",
    purpose: "Synthetic purpose, reworded.",
    responsibilities: ["Synthetic duty of Alpha review assistant"],
    runsAs: world.people.agent.id,
    links: built.alphaAgent.links,
  });
  await suspendMemory(env.ctx, contributor.id, {
    memoryId: memory.id,
    expectedRevision: memory.revision,
    reason: "Synthetic dispute",
  });

  const graph = await getNetwork(env.ctx, reviewer.id, world.orgA.id);
  assert.ok(
    !nodeIds(graph).includes(`memory:${memory.id}`),
    "only current knowledge is drawn",
  );
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from) && ids.has(edge.to), `${edge.id} is drawn`);
  }
  const agentNode = graph.nodes.find(
    (node) => node.id === `definition:${built.alphaAgent.id}`,
  );
  assert.ok(agentNode && "pendingChanges" in agentNode.details);
  assert.deepEqual(agentNode.details.warnings, [
    `Based on “${memory.title}”, which is suspended.`,
  ]);
  assert.equal(
    agentNode.details.pendingChanges,
    1,
    "a change that keeps the link still counts as waiting",
  );
});
