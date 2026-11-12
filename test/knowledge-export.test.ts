import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveProposal,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  exportKnowledge,
  ForbiddenError,
  getMemory,
  listMemories,
  NotFoundError,
  proposeMemory,
  recordRepositoryAccess,
  revokeRole,
  ValidationError,
  type ScopeRef,
} from "../src/index.ts";
import {
  buildWorld,
  project,
  START,
  titlesOf,
  useTestDatabase,
} from "./helpers.ts";

const env = useTestDatabase();

function organization(id: string): ScopeRef {
  return { level: "organization", id };
}

test("administrators export approved knowledge as plain, portable JSON", async () => {
  const w = await buildWorld(env.ctx);
  const exported = await exportKnowledge(env.ctx, w.people.adminA.id, {
    scope: organization(w.orgA.id),
  });

  assert.equal(exported.format, EXPORT_FORMAT);
  assert.equal(exported.formatVersion, EXPORT_FORMAT_VERSION);
  assert.equal(exported.exportedAt, START.toISOString());
  assert.equal(exported.exportedBy, w.people.adminA.id);
  assert.deepEqual(
    JSON.parse(JSON.stringify(exported)),
    exported,
    "an export holds only plain JSON values",
  );
  assert.deepEqual(exported.organization, {
    id: w.orgA.id,
    slug: "synthetic-org-a",
    name: "Synthetic Org A",
  });
  assert.deepEqual(
    exported.projects.map((p) => p.slug),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    titlesOf(exported.memories),
    [w.memories.alphaApproved.title, w.memories.betaApproved.title].sort(),
  );
  assert.deepEqual(
    exported.memories.find((m) => m.id === w.memories.alphaApproved.id),
    {
      id: w.memories.alphaApproved.id,
      projectId: w.alpha.id,
      ownerId: w.people.contributor.id,
      status: "approved",
      statusGeneration: 0,
      applicability: null,
      revision: 1,
      type: "decision",
      title: w.memories.alphaApproved.title,
      content: w.memories.alphaApproved.content,
      proposalId: w.memories.alphaApproved.proposalId,
      proposedBy: w.people.contributor.id,
      approvedBy: w.people.reviewer.id,
      approvedAt: START.toISOString(),
      evidenceSourceIds: [w.sources.alpha.id],
    },
  );
  assert.deepEqual(
    exported.sources.map((s) => s.id),
    [w.sources.alpha.id, w.sources.beta.id].sort(),
  );
  assert.equal(
    exported.sources.find((s) => s.id === w.sources.alpha.id)?.excerpt,
    w.sources.alpha.excerpt,
  );
  const principalIds = exported.principals.map((p) => p.id);
  for (const person of [
    w.people.adminA,
    w.people.ownerA,
    w.people.contributor,
    w.people.reviewer,
  ]) {
    assert.ok(principalIds.includes(person.id));
  }

  const text = JSON.stringify(exported);
  assert.ok(!text.includes(w.proposals.alphaPending.title), "no proposals");
  assert.ok(!text.includes(w.memories.deltaApproved.title), "no other org");
});

test("only people with the administrator role or higher may export", async () => {
  const w = await buildWorld(env.ctx);
  const alphaOnly = { scope: project(w.alpha.id) };

  await assert.rejects(
    exportKnowledge(env.ctx, w.people.reader.id, alphaOnly),
    ForbiddenError,
  );
  await assert.rejects(
    exportKnowledge(env.ctx, w.people.reviewer.id, alphaOnly),
    ForbiddenError,
  );
  await assert.rejects(exportKnowledge(env.ctx, w.people.agent.id, alphaOnly), {
    name: "ForbiddenError",
    message: /Agents cannot/,
  });
  await assert.rejects(
    exportKnowledge(env.ctx, w.people.ownerB.id, {
      scope: organization(w.orgA.id),
    }),
    NotFoundError,
  );
  await assert.rejects(
    exportKnowledge(env.ctx, w.people.buAdmin.id, {
      scope: organization(w.orgA.id),
    }),
    NotFoundError,
    "a business unit administrator cannot export the whole organization",
  );
  await assert.rejects(
    exportKnowledge(env.ctx, w.people.adminA.id, {
      scope: { level: "team", id: w.orgA.id } as unknown as ScopeRef,
    }),
    ValidationError,
  );

  const platform = await exportKnowledge(env.ctx, w.people.buAdmin.id, {
    scope: { level: "business_unit", id: w.platform.id },
  });
  assert.deepEqual(
    titlesOf(platform.memories),
    [w.memories.alphaApproved.title, w.memories.betaApproved.title].sort(),
  );
  const clinical = await exportKnowledge(env.ctx, w.people.adminA.id, {
    scope: { level: "business_unit", id: w.clinical.id },
  });
  assert.deepEqual(clinical.memories, []);
});

test("an export leaves out memories whose evidence the exporter cannot read", async () => {
  const w = await buildWorld(env.ctx);
  env.advance(1000);
  await recordRepositoryAccess(env.ctx, {
    principalId: w.people.adminA.id,
    provider: "github",
    externalRepositoryId: "1001",
    canRead: false,
  });
  const exported = await exportKnowledge(env.ctx, w.people.adminA.id, {
    scope: organization(w.orgA.id),
  });
  assert.deepEqual(titlesOf(exported.memories), [
    w.memories.betaApproved.title,
  ]);
  assert.deepEqual(
    exported.sources.map((s) => s.id),
    [w.sources.beta.id],
  );
  assert.match(exported.coverage, /could read/);
});

test("knowledge an AI agent proposed stays when that agent is removed", async () => {
  const w = await buildWorld(env.ctx);
  const proposal = await proposeMemory(env.ctx, w.people.agent.id, {
    projectId: w.alpha.id,
    type: "lesson",
    title: "Synthetic lesson suggested by an assistant",
    content: "Synthetic body.",
    evidenceSourceIds: [w.sources.alpha.id],
    ownerId: w.people.contributor.id,
  });
  const memory = await approveProposal(env.ctx, w.people.reviewer.id, {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
  });
  await revokeRole(env.ctx, w.people.adminA.id, {
    principalId: w.people.agent.id,
    scope: project(w.alpha.id),
    reason: "Replaced by another AI tool",
  });

  assert.deepEqual(await listMemories(env.ctx, w.people.agent.id), []);
  const kept = await getMemory(env.ctx, w.people.reader.id, memory.id);
  assert.equal(kept.proposedBy, w.people.agent.id);
  assert.equal(kept.ownerId, w.people.contributor.id);

  const exported = await exportKnowledge(env.ctx, w.people.adminA.id, {
    scope: project(w.alpha.id),
  });
  assert.ok(exported.memories.some((m) => m.id === memory.id));
  assert.deepEqual(
    exported.principals.find((p) => p.id === w.people.agent.id),
    {
      id: w.people.agent.id,
      kind: "agent",
      displayName: "Synthetic Coding Agent",
    },
  );
});

test("each export is audited with counts, never content", async () => {
  const w = await buildWorld(env.ctx);
  await exportKnowledge(env.ctx, w.people.adminA.id, {
    scope: organization(w.orgA.id),
  });
  const { rows } = await env.db.query<{
    actor_id: string;
    target_type: string;
    target_id: string;
    details: Record<string, unknown>;
  }>(
    `SELECT actor_id, target_type, target_id, details FROM audit_events
     WHERE action = 'knowledge.exported'`,
  );
  assert.deepEqual(rows, [
    {
      actor_id: w.people.adminA.id,
      target_type: "organization",
      target_id: w.orgA.id,
      details: { memoryCount: 2, sourceCount: 2 },
    },
  ]);
});
