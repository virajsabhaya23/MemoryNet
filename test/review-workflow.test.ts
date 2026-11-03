import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveProposal,
  assignRole,
  buildCheckSummary,
  ConflictError,
  connectRepository,
  editProposal,
  getProposal,
  getProposalHistory,
  listReviewQueue,
  NotFoundError,
  proposeMemory,
  recordRepositoryAccess,
  recordSource,
  ValidationError,
  type MemoryNetContext,
  type Proposal,
} from "../src/index.ts";
import { buildWorld, project, useTestDatabase, type World } from "./helpers.ts";

const env = useTestDatabase();

function editOf(
  proposal: Proposal,
  changes: Partial<Parameters<typeof editProposal>[2]> = {},
) {
  return {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
    type: proposal.type,
    title: proposal.title,
    content: `${proposal.content} Synthetic clarification.`,
    evidenceSourceIds: proposal.evidence.map((item) => item.sourceId),
    ownerId: proposal.ownerId,
    ...changes,
  };
}

async function auditActions(ctx: MemoryNetContext): Promise<string[]> {
  const { rows } = await ctx.db.query<{ action: string }>(
    "SELECT action FROM audit_events ORDER BY id",
  );
  return rows.map((row) => row.action);
}

function ids(items: Array<{ id: string }>): string[] {
  return items.map((item) => item.id);
}

test("editing a pending proposal adds a version, keeps the earlier one, and approval records which version", async () => {
  const w = await buildWorld(env.ctx);
  const original = w.proposals.alphaPending;
  const edited = await editProposal(env.ctx, w.people.contributor.id, {
    ...editOf(original),
    changeNote: "Say which cache",
  });
  assert.equal(edited.revision, 2);
  assert.match(edited.content, /Synthetic clarification/);

  const history = await getProposalHistory(
    env.ctx,
    w.people.reviewer.id,
    original.id,
  );
  assert.deepEqual(
    history.map((version) => [
      version.revision,
      version.authoredBy,
      version.changeNote,
    ]),
    [
      [1, w.people.contributor.id, null],
      [2, w.people.contributor.id, "Say which cache"],
    ],
  );
  assert.equal(
    history[0]?.content,
    original.content,
    "the first version is kept as written",
  );

  const memory = await approveProposal(env.ctx, w.people.reviewer.id, {
    proposalId: original.id,
    expectedRevision: 2,
  });
  assert.equal(memory.proposalRevision, 2);
  assert.equal(memory.content, edited.content);
  assert.ok((await auditActions(env.ctx)).includes("memory.proposal_edited"));
});

test("only the proposer or a reviewer may edit, and never a reader or an agent", async () => {
  const w = await buildWorld(env.ctx);
  const pending = w.proposals.alphaPending;
  await assert.rejects(
    editProposal(env.ctx, w.people.reader.id, editOf(pending)),
    NotFoundError,
  );
  await assert.rejects(
    editProposal(env.ctx, w.people.agent.id, editOf(pending)),
    { name: "ForbiddenError", message: /Agents cannot/ },
  );
  await assignRole(env.ctx, w.people.adminA.id, {
    principalId: w.people.outsider.id,
    scope: project(w.alpha.id),
    role: "contributor",
  });
  await assert.rejects(
    editProposal(env.ctx, w.people.outsider.id, editOf(pending)),
    { name: "ForbiddenError", message: /proposed it or a reviewer/ },
  );
  const byReviewer = await editProposal(
    env.ctx,
    w.people.reviewer.id,
    editOf(pending),
  );
  assert.equal(byReviewer.revision, 2);
});

test("anyone who wrote a version cannot review the proposal, even in the database", async () => {
  const w = await buildWorld(env.ctx);
  const pending = w.proposals.alphaPending;
  await editProposal(env.ctx, w.people.reviewer.id, editOf(pending));
  await assert.rejects(
    approveProposal(env.ctx, w.people.reviewer.id, {
      proposalId: pending.id,
      expectedRevision: 2,
    }),
    { name: "ForbiddenError", message: /different person/ },
  );
  await assert.rejects(
    env.db.query(
      `UPDATE memory_proposals SET status = 'rejected', reviewed_by = $2, reviewed_at = now(),
                                   review_reason = 'Synthetic'
       WHERE id = $1`,
      [pending.id, w.people.reviewer.id],
    ),
    /cannot review/,
  );
  const memory = await approveProposal(env.ctx, w.people.ownerA.id, {
    proposalId: pending.id,
    expectedRevision: 2,
  });
  assert.equal(memory.approvedBy, w.people.ownerA.id);
});

test("edits name the version they change, so parallel edits and stale reviews conflict", async () => {
  const w = await buildWorld(env.ctx);
  const pending = w.proposals.alphaPending;
  const results = await Promise.allSettled([
    editProposal(
      env.ctx,
      w.people.contributor.id,
      editOf(pending, { title: "Alpha may drop the L1 cache" }),
    ),
    editProposal(
      env.ctx,
      w.people.reviewer.id,
      editOf(pending, { title: "Alpha may drop the L2 cache" }),
    ),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.ok(failure?.reason instanceof ConflictError);
  assert.match(String(failure.reason.message), /Reload to see/);

  await assert.rejects(
    approveProposal(env.ctx, w.people.ownerA.id, {
      proposalId: pending.id,
      expectedRevision: 1,
    }),
    ConflictError,
  );
  assert.equal(
    (await getProposal(env.ctx, w.people.ownerA.id, pending.id)).revision,
    2,
  );
});

test("edits pass the same checks as new proposals", async () => {
  const w = await buildWorld(env.ctx);
  const pending = w.proposals.alphaPending;
  const as = w.people.contributor.id;
  await assert.rejects(
    editProposal(
      env.ctx,
      as,
      editOf(pending, { content: "Synthetic: password=Synthetic9Secret" }),
    ),
    { name: "ValidationError", message: /secret/ },
  );
  await assert.rejects(
    editProposal(env.ctx, as, editOf(pending, { content: pending.content })),
    {
      name: "ValidationError",
      message: /Nothing changed/,
    },
  );
  await assert.rejects(
    editProposal(
      env.ctx,
      as,
      editOf(pending, {
        title: w.memories.alphaApproved.title,
        content: w.memories.alphaApproved.content,
      }),
    ),
    { name: "ConflictError", message: /already approved knowledge/ },
  );
  await assert.rejects(
    editProposal(
      env.ctx,
      as,
      editOf(pending, { evidenceSourceIds: [w.sources.beta.id] }),
    ),
    ValidationError,
  );
  await assert.rejects(
    editProposal(
      env.ctx,
      as,
      editOf(pending, { ownerId: w.people.reviewerB.id }),
    ),
    ValidationError,
  );
  const flagged = await editProposal(
    env.ctx,
    as,
    editOf(pending, {
      content: "Synthetic: ask synthetic.person@example.com first.",
    }),
  );
  assert.deepEqual(flagged.flags, ["personal_data"]);

  await approveProposal(env.ctx, w.people.reviewer.id, {
    proposalId: pending.id,
    expectedRevision: flagged.revision,
  });
  await assert.rejects(
    editProposal(
      env.ctx,
      as,
      editOf(flagged, { expectedRevision: flagged.revision }),
    ),
    { name: "ConflictError", message: /already been reviewed/ },
  );
});

test("the review queue lists only proposals the caller may review", async () => {
  const w = await buildWorld(env.ctx);
  const pendingId = w.proposals.alphaPending.id;
  assert.deepEqual(ids(await listReviewQueue(env.ctx, w.people.reviewer.id)), [
    pendingId,
  ]);
  assert.deepEqual(
    ids(await listReviewQueue(env.ctx, w.people.contributor.id)),
    [],
  );
  assert.deepEqual(
    ids(await listReviewQueue(env.ctx, w.people.reviewerB.id)),
    [],
  );
  assert.deepEqual(ids(await listReviewQueue(env.ctx, w.people.agent.id)), []);
  assert.deepEqual(ids(await listReviewQueue(env.ctx, w.people.ownerA.id)), [
    pendingId,
  ]);

  await editProposal(
    env.ctx,
    w.people.reviewer.id,
    editOf(w.proposals.alphaPending),
  );
  assert.deepEqual(
    ids(await listReviewQueue(env.ctx, w.people.reviewer.id)),
    [],
    "an author no longer sees it as reviewable",
  );
});

async function hiddenSourceSetup(w: World) {
  await connectRepository(env.ctx, w.people.adminA.id, {
    projectId: w.alpha.id,
    provider: "github",
    externalRepositoryId: "1005",
    fullName: "synthetic-org-a/alpha-docs",
  });
  await recordRepositoryAccess(env.ctx, {
    principalId: w.people.contributor.id,
    provider: "github",
    externalRepositoryId: "1005",
    canRead: true,
  });
  return recordSource(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    provider: "github",
    externalRepositoryId: "1005",
    reference: "pull/5",
    url: "https://github.com/synthetic-org-a/alpha-docs/pull/5",
    excerpt: "Synthetic excerpt from a repository the reviewer cannot read.",
  });
}

test("history hides a version whose evidence the caller cannot read", async () => {
  const w = await buildWorld(env.ctx);
  const hidden = await hiddenSourceSetup(w);
  const proposal = await proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    type: "lesson",
    title: "Synthetic lesson from private docs",
    content: "Synthetic text drawn from the private repository.",
    evidenceSourceIds: [hidden.id],
  });
  await editProposal(
    env.ctx,
    w.people.contributor.id,
    editOf(proposal, {
      title: "Synthetic lesson with public evidence",
      content: "Synthetic text supported by the public pull request.",
      evidenceSourceIds: [w.sources.alpha.id],
    }),
  );
  const history = await getProposalHistory(
    env.ctx,
    w.people.reviewer.id,
    proposal.id,
  );
  assert.equal(history[0]?.readable, false);
  assert.equal(history[0]?.title, null);
  assert.equal(history[0]?.content, null);
  assert.equal(history[1]?.readable, true);
  assert.equal(history[1]?.title, "Synthetic lesson with public evidence");
});

test("check summaries count proposals and link to the review screen, never showing titles or content", async () => {
  const w = await buildWorld(env.ctx);
  const base = "http://localhost:3050";
  const summary = await buildCheckSummary(env.ctx, {
    provider: "github",
    externalRepositoryId: "1001",
    pullRequestNumber: 11,
    reviewBaseUrl: base,
  });
  assert.ok(summary);
  assert.equal(summary.conclusion, "neutral");
  assert.equal(summary.title, "1 memory proposal waiting for review");
  assert.equal(
    summary.detailsUrl,
    `${base}/proposals/${w.proposals.alphaPending.id}`,
  );
  assert.match(summary.summary, /version 1: pending/);
  assert.match(summary.summary, /version 1: approved/);
  for (const hiddenText of [
    w.proposals.alphaPending.title,
    w.proposals.alphaPending.content,
    w.memories.alphaApproved.title,
  ]) {
    assert.ok(!summary.summary.includes(hiddenText));
    assert.ok(!summary.title.includes(hiddenText));
  }

  const none = await buildCheckSummary(env.ctx, {
    provider: "github",
    externalRepositoryId: "1001",
    pullRequestNumber: 99,
    reviewBaseUrl: base,
  });
  assert.equal(none?.title, "No memory proposals cite this pull request yet");
  assert.equal(none?.detailsUrl, `${base}/review`);
  assert.equal(
    await buildCheckSummary(env.ctx, {
      provider: "github",
      externalRepositoryId: "9999",
      pullRequestNumber: 1,
      reviewBaseUrl: base,
    }),
    null,
    "no check for repositories no project uses",
  );
  await assert.rejects(
    buildCheckSummary(env.ctx, {
      provider: "github",
      externalRepositoryId: "1001",
      pullRequestNumber: 11,
      reviewBaseUrl: "javascript:alert(1)",
    }),
    ValidationError,
  );
});
