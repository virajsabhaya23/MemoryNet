import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveProposal,
  ConflictError,
  getMemory,
  getProposal,
  getSource,
  listMemories,
  listProposals,
  MEMORY_TYPES,
  NotFoundError,
  proposeMemory,
  recordSource,
  rejectProposal,
  revokeRole,
  ValidationError,
} from "../src/index.ts";
import { buildWorld, project, titlesOf, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();

test("stores every kind of knowledge with its project, owner, and evidence", async () => {
  const w = await buildWorld(env.ctx);
  const approvedIds: string[] = [];
  for (const type of MEMORY_TYPES) {
    const proposal = await proposeMemory(env.ctx, w.people.contributor.id, {
      projectId: w.alpha.id,
      type,
      title: `Synthetic ${type}`,
      content: `Synthetic ${type} body.`,
      evidenceSourceIds: [w.sources.alpha.id],
    });
    const memory = await approveProposal(env.ctx, w.people.reviewer.id, {
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
    });
    assert.equal(memory.type, type);
    assert.equal(memory.projectId, w.alpha.id);
    assert.equal(
      memory.ownerId,
      w.people.contributor.id,
      "a person who proposes owns the memory by default",
    );
    assert.equal(memory.approvedBy, w.people.reviewer.id);
    assert.equal(memory.evidence.length, 1);
    approvedIds.push(memory.id);
  }

  const readable = await listMemories(env.ctx, w.people.reader.id, {
    scope: project(w.alpha.id),
  });
  assert.deepEqual(
    readable
      .filter((memory) => approvedIds.includes(memory.id))
      .map((memory) => memory.type)
      .sort(),
    [...MEMORY_TYPES].sort(),
  );
});

test("each memory carries its source link, excerpt, and revision", async () => {
  const w = await buildWorld(env.ctx);
  const memory = await getMemory(
    env.ctx,
    w.people.reader.id,
    w.memories.alphaApproved.id,
  );
  assert.deepEqual(memory.evidence, [
    {
      sourceId: w.sources.alpha.id,
      reference: "pull/11",
      url: "https://github.com/synthetic-org-a/alpha-service/pull/11",
      revision: "0123456789abcdef0123456789abcdef01234567",
      excerpt: w.sources.alpha.excerpt,
      capturedAt: w.sources.alpha.capturedAt,
      flags: [],
    },
  ]);
});

test("every memory has an accountable owner who is a person in the project", async () => {
  const w = await buildWorld(env.ctx);
  const input = {
    projectId: w.alpha.id,
    type: "decision" as const,
    title: "Synthetic owned decision",
    content: "Synthetic body.",
    evidenceSourceIds: [w.sources.alpha.id],
  };

  for (const ownerId of [
    w.people.agent.id,
    w.people.outsider.id,
    w.people.reviewerB.id,
    "not-a-uuid",
  ]) {
    await assert.rejects(
      proposeMemory(env.ctx, w.people.contributor.id, { ...input, ownerId }),
      ValidationError,
    );
  }

  const named = await proposeMemory(env.ctx, w.people.agent.id, {
    ...input,
    ownerId: w.people.reader.id,
  });
  const memory = await approveProposal(env.ctx, w.people.reviewer.id, {
    proposalId: named.id,
    expectedRevision: named.revision,
  });
  assert.equal(memory.ownerId, w.people.reader.id);
  assert.equal(memory.proposedBy, w.people.agent.id);

  const ownerLeaves = await proposeMemory(env.ctx, w.people.contributor.id, {
    ...input,
    title: "Synthetic decision whose owner leaves",
    ownerId: w.people.reader.id,
  });
  await revokeRole(env.ctx, w.people.adminA.id, {
    principalId: w.people.reader.id,
    scope: project(w.alpha.id),
    reason: "Moved to another team",
  });
  await assert.rejects(
    approveProposal(env.ctx, w.people.reviewer.id, {
      proposalId: ownerLeaves.id,
      expectedRevision: ownerLeaves.revision,
    }),
    { name: "ConflictError", message: /owner/ },
  );
});

test("proposals and raw source excerpts stay apart from approved knowledge", async () => {
  const w = await buildWorld(env.ctx);
  const source = await recordSource(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    provider: "github",
    externalRepositoryId: "1001",
    reference: "pull/13",
    url: "https://github.com/synthetic-org-a/alpha-service/pull/13",
    excerpt: "Synthetic raw discussion: should we stop retrying forever?",
  });
  const proposal = await proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    type: "failed_approach",
    title: "Unbounded retries overloaded the queue",
    content: "Synthetic summary written by a person.",
    evidenceSourceIds: [source.id],
  });

  for (const person of Object.values(w.people)) {
    const titles = titlesOf(await listMemories(env.ctx, person.id));
    assert.ok(!titles.includes(proposal.title));
    await assert.rejects(
      getMemory(env.ctx, person.id, proposal.id),
      NotFoundError,
    );
  }
  assert.equal(
    (await getSource(env.ctx, w.people.reader.id, source.id)).excerpt,
    source.excerpt,
    "raw excerpts are read as sources, never as memories",
  );

  const rejected = await proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    type: "rationale",
    title: "Synthetic rejected reason",
    content: "Synthetic body.",
    evidenceSourceIds: [source.id],
  });
  await rejectProposal(env.ctx, w.people.reviewer.id, {
    proposalId: rejected.id,
    expectedRevision: rejected.revision,
    reason: "The evidence does not support it",
  });

  const memory = await approveProposal(env.ctx, w.people.reviewer.id, {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
  });
  assert.notEqual(memory.id, proposal.id, "approved knowledge gets its own ID");
  assert.equal(memory.proposalId, proposal.id);
  assert.equal(
    (await getProposal(env.ctx, w.people.contributor.id, proposal.id)).memoryId,
    memory.id,
  );
  assert.deepEqual(
    titlesOf(await listMemories(env.ctx, w.people.reader.id)),
    [w.memories.alphaApproved.title, proposal.title].sort(),
  );
  assert.deepEqual(
    titlesOf(
      await listProposals(env.ctx, w.people.contributor.id, {
        status: "rejected",
      }),
    ),
    [rejected.title],
  );
});

test("only one of two simultaneous approvals publishes a proposal", async () => {
  const w = await buildWorld(env.ctx);
  const pending = w.proposals.alphaPending;
  const results = await Promise.allSettled(
    [w.people.reviewer, w.people.ownerA].map((person) =>
      approveProposal(env.ctx, person.id, {
        proposalId: pending.id,
        expectedRevision: pending.revision,
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.ok(failure?.reason instanceof ConflictError);
  const { rows } = await env.db.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM memory_revisions WHERE proposal_id = $1",
    [pending.id],
  );
  assert.equal(rows[0]?.count, 1);
});

test("the database itself refuses agent owners, agent approvers, self-review, and outside evidence", async () => {
  const w = await buildWorld(env.ctx);
  const memory = w.memories.alphaApproved;

  await assert.rejects(
    env.db.query(
      `INSERT INTO memories (project_id, owner_id, status, current_revision, created_at)
       VALUES ($1, $2, 'approved', 1, now())`,
      [w.alpha.id, w.people.agent.id],
    ),
    /foreign key/,
  );
  await assert.rejects(
    env.db.query(
      `INSERT INTO memory_revisions (project_id, memory_id, revision, type, title, content,
                                     proposal_id, proposal_revision, approved_by, approved_at)
       VALUES ($1, $2, 2, 'decision', 'Synthetic', 'Synthetic', $3, 1, $4, now())`,
      [w.alpha.id, memory.id, w.proposals.alphaPending.id, w.people.agent.id],
    ),
    // The approval check runs before foreign keys; agents can never hold an approval either.
    /foreign key|different approvals/,
  );
  await assert.rejects(
    env.db.query(
      `UPDATE memory_proposals SET status = 'rejected', reviewed_by = proposed_by,
                                   reviewed_at = now()
       WHERE id = $1`,
      [w.proposals.alphaPending.id],
    ),
    /check constraint/,
  );
  await assert.rejects(
    env.db.query(
      `INSERT INTO memory_evidence (project_id, memory_id, revision, source_id)
       VALUES ($1, $2, 1, $3)`,
      [w.alpha.id, memory.id, w.sources.beta.id],
    ),
    /foreign key/,
  );
});
