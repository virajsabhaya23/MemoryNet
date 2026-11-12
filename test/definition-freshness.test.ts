import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveDefinitionProposal,
  approveProposal,
  basedOnChanges,
  getDefinition,
  proposeChange,
  proposeDefinition,
  suspendMemory,
  type Definition,
  type Memory,
  type MemoryNetContext,
  type Principal,
} from "../src/index.ts";
import { buildWorld, project, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();

async function ruleBasedOn(
  ctx: MemoryNetContext,
  proposer: Principal,
  reviewer: Principal,
  projectId: string,
  memoryId: string,
): Promise<Definition> {
  const proposal = await proposeDefinition(ctx, proposer.id, {
    scope: project(projectId),
    kind: "rule",
    name: "Alpha retries are bounded",
    purpose: "Synthetic purpose.",
    responsibilities: ["Synthetic duty"],
    boundaries: [],
    instructions: "Synthetic instructions.",
    links: [{ relation: "based_on", targetId: memoryId }],
  });
  return approveDefinitionProposal(ctx, reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
}

async function changesFor(ctx: MemoryNetContext, readerId: string, definitionId: string) {
  const view = await getDefinition(ctx, readerId, definitionId);
  return basedOnChanges(view.definition, new Map(view.linkedMemories.map((memory) => [memory.id, memory])));
}

test("a definition stays fresh until the decision it is based on changes after its approval", async () => {
  const world = await buildWorld(env.ctx);
  const { contributor, reviewer, reader } = world.people;
  const memory = world.memories.alphaApproved;
  const rule = await ruleBasedOn(env.ctx, contributor, reviewer, world.alpha.id, memory.id);
  assert.deepEqual(await changesFor(env.ctx, reader.id, rule.id), []);

  env.advance(60_000);
  const revision = await proposeChange(env.ctx, contributor.id, {
    memoryId: memory.id,
    expectedRevision: memory.revision,
    kind: "revise",
    type: "decision",
    title: "Alpha retries once",
    content: "Synthetic revised body.",
    evidenceSourceIds: [world.sources.alpha.id],
  });
  await approveProposal(env.ctx, reviewer.id, { proposalId: revision.id, expectedRevision: revision.revision });
  const revised = await changesFor(env.ctx, reader.id, rule.id);
  assert.equal(revised.length, 1);
  assert.equal(revised[0]!.change, "revised");
  assert.equal(revised[0]!.memoryId, memory.id);
  assert.equal(revised[0]!.revision, memory.revision + 1);
  assert.equal(revised[0]!.title, "Alpha retries once");
  assert.equal(revised[0]!.replacedBy, null);
});

test("a replaced or suspended decision marks the definition, with the replacement named", async () => {
  const world = await buildWorld(env.ctx);
  const { contributor, reviewer, reader } = world.people;
  const memory = world.memories.alphaApproved;
  const rule = await ruleBasedOn(env.ctx, contributor, reviewer, world.alpha.id, memory.id);

  env.advance(60_000);
  await suspendMemory(env.ctx, contributor.id, { memoryId: memory.id, expectedRevision: memory.revision, reason: "Synthetic dispute" });
  const suspended = await changesFor(env.ctx, reader.id, rule.id);
  assert.deepEqual(suspended.map((item) => [item.change, item.status]), [["suspended", "suspended"]]);
  assert.ok(suspended[0]!.changedAt instanceof Date);
});

test("a decision the caller cannot read is skipped, never revealed", () => {
  const link = { relation: "based_on" as const, targetId: "00000000-0000-4000-8000-000000000001" };
  const approvedAt = new Date("2026-09-24T09:00:00.000Z");
  assert.deepEqual(basedOnChanges({ links: [link], approvedAt }, new Map()), []);

  const later = { id: link.targetId, title: "Synthetic", status: "superseded", revision: 2, approvedAt, statusChangedAt: new Date("2026-09-25T09:00:00.000Z"), supersededBy: "00000000-0000-4000-8000-000000000002" } as Memory;
  const [change] = basedOnChanges({ links: [link, link], approvedAt }, new Map([[link.targetId, later]]));
  assert.equal(change?.change, "superseded");
  assert.equal(change?.replacedBy, "00000000-0000-4000-8000-000000000002");
  assert.equal(basedOnChanges({ links: [link, link], approvedAt }, new Map([[link.targetId, later]])).length, 1, "a repeated link counts once");
});
