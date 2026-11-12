import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveProposal,
  ConflictError,
  editProposal,
  ForbiddenError,
  getApprovalStatus,
  getMemory,
  getProjectPolicy,
  proposeMemory,
  recordApproval,
  rejectProposal,
  setProjectPolicy,
  ValidationError,
  verifyLedger,
} from "../src/index.ts";
import { buildWorld, useTestDatabase, type World } from "./helpers.ts";

const env = useTestDatabase();

function requireTwo(w: World, extra: Partial<{ agentProposals: boolean; agentPendingLimit: number }> = {}) {
  return setProjectPolicy(env.ctx, w.people.adminA.id, {
    projectId: w.alpha.id, expectedRevision: 0, requiredApprovals: 2,
    agentProposals: extra.agentProposals ?? true, agentPendingLimit: extra.agentPendingLimit ?? 25,
    reason: "Constraints need a second reviewer",
  });
}

async function approvalRows(proposalId: string): Promise<number> {
  return (await env.db.query<{ count: number }>("SELECT count(*)::int AS count FROM proposal_approvals WHERE proposal_id=$1", [proposalId])).rows[0]!.count;
}

test("without a policy one reviewer publishes, as before, and the approval is recorded", async () => {
  const w = await buildWorld(env.ctx);
  const policy = await getProjectPolicy(env.ctx, w.people.reader.id, w.alpha.id);
  assert.deepEqual([policy.revision, policy.requiredApprovals, policy.agentProposals, policy.agentPendingLimit], [0, 1, true, 25]);
  assert.equal(w.memories.alphaApproved.approvals, 1);
  const pending = w.proposals.alphaPending;
  const memory = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 });
  assert.equal(memory.approvals, 1);
  assert.equal(await approvalRows(pending.id), 1);
  await assert.rejects(getProjectPolicy(env.ctx, w.people.ownerB.id, w.alpha.id));
});

test("only administrators change the policy, with a reason, naming the version they saw", async () => {
  const w = await buildWorld(env.ctx);
  for (const who of [w.people.reviewer, w.people.contributor, w.people.reader]) {
    await assert.rejects(setProjectPolicy(env.ctx, who.id, { projectId: w.alpha.id, expectedRevision: 0, requiredApprovals: 2, agentProposals: true, agentPendingLimit: 25, reason: "x" }), ForbiddenError);
  }
  await assert.rejects(setProjectPolicy(env.ctx, w.people.agent.id, { projectId: w.alpha.id, expectedRevision: 0, requiredApprovals: 1, agentProposals: true, agentPendingLimit: 99, reason: "agents cannot" }), ForbiddenError);
  await assert.rejects(setProjectPolicy(env.ctx, w.people.adminA.id, { projectId: w.alpha.id, expectedRevision: 0, requiredApprovals: 4, agentProposals: true, agentPendingLimit: 25, reason: "too many" }), ValidationError);
  await assert.rejects(setProjectPolicy(env.ctx, w.people.adminA.id, { projectId: w.alpha.id, expectedRevision: 0, requiredApprovals: 1, agentProposals: true, agentPendingLimit: 25, reason: "same" }), /Nothing changed/);
  const saved = await requireTwo(w);
  assert.equal(saved.revision, 1);
  assert.equal(saved.changedBy, w.people.adminA.id);
  await assert.rejects(requireTwo(w), ConflictError);
  const audit = await env.db.query<{ action: string }>("SELECT action FROM audit_events WHERE action='policy.changed'");
  assert.equal(audit.rows.length, 1);
  await assert.rejects(env.db.query("UPDATE project_policy_revisions SET required_approvals=1"), /append-only/);
});

test("two required approvals: one reviewer cannot publish, a second different reviewer does", async () => {
  const w = await buildWorld(env.ctx);
  await requireTwo(w);
  const pending = w.proposals.alphaPending;
  await assert.rejects(approveProposal(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 }), /requires 2 different reviewers/);
  assert.equal(await approvalRows(pending.id), 0, "a refused publication writes nothing");
  await assert.rejects(recordApproval(env.ctx, w.people.contributor.id, { proposalId: pending.id, expectedRevision: 1 }), ForbiddenError);
  const first = await recordApproval(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1, reason: "Looks right" });
  assert.deepEqual(first, { status: "awaiting_approvals", proposalId: pending.id, revision: 1, approvals: 1, required: 2 });
  await assert.rejects(recordApproval(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 }), /already approved/);
  const status = await getApprovalStatus(env.ctx, w.people.adminA.id, pending.id);
  assert.deepEqual(status.approvals.map((a) => a.reviewerId), [w.people.reviewer.id]);
  assert.equal(status.required, 2);
  const second = await recordApproval(env.ctx, w.people.adminA.id, { proposalId: pending.id, expectedRevision: 1 });
  assert.equal(second.status, "published");
  if (second.status !== "published") return;
  assert.equal(second.memory.approvals, 2);
  assert.equal((await getMemory(env.ctx, w.people.reader.id, second.memory.id)).approvals, 2);
  assert.equal((await verifyLedger(env.db)).ok, true);
});

test("editing a proposal starts a new version that needs its own approvals; rejection needs one reviewer", async () => {
  const w = await buildWorld(env.ctx);
  await requireTwo(w);
  const pending = w.proposals.alphaPending;
  await recordApproval(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 });
  const edited = await editProposal(env.ctx, w.people.contributor.id, { proposalId: pending.id, expectedRevision: 1, type: "decision",
    title: pending.title, content: `${pending.content} Clarified.`, evidenceSourceIds: [w.sources.alpha.id], ownerId: w.people.contributor.id });
  assert.equal(edited.revision, 2);
  const after = await recordApproval(env.ctx, w.people.adminA.id, { proposalId: pending.id, expectedRevision: 2 });
  assert.equal(after.status, "awaiting_approvals");
  assert.equal(after.approvals, 1, "the version 1 approval does not carry over");
  const rejected = await rejectProposal(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 2, reason: "Superseded by discussion" });
  assert.equal(rejected.status, "rejected");
  await assert.rejects(recordApproval(env.ctx, w.people.ownerA.id, { proposalId: pending.id, expectedRevision: 2 }), ConflictError);
});

test("lowering the policy lets an earlier approver publish without approving twice", async () => {
  const w = await buildWorld(env.ctx);
  await requireTwo(w);
  const pending = w.proposals.alphaPending;
  await recordApproval(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 });
  await setProjectPolicy(env.ctx, w.people.adminA.id, { projectId: w.alpha.id, expectedRevision: 1, requiredApprovals: 1, agentProposals: true, agentPendingLimit: 25, reason: "Back to one reviewer" });
  const result = await recordApproval(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 });
  assert.equal(result.status, "published");
  assert.equal(await approvalRows(pending.id), 1);
});

test("the database refuses publication without enough approvals and approvals by authors", async () => {
  const w = await buildWorld(env.ctx);
  await requireTwo(w);
  const pending = w.proposals.alphaPending;
  await assert.rejects(env.db.query(
    "INSERT INTO proposal_approvals (project_id, proposal_id, revision, reviewer_id, approved_at) VALUES ($1, $2, 1, $3, now())",
    [w.alpha.id, pending.id, w.people.contributor.id]), /author of a proposal version cannot approve/);
  await assert.rejects(env.db.query(
    "INSERT INTO proposal_approvals (project_id, proposal_id, revision, reviewer_id, approved_at) VALUES ($1, $2, 1, $3, now())",
    [w.alpha.id, pending.id, w.people.agent.id]), /foreign key|violates/);
  await recordApproval(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 });
  await env.db.exec("BEGIN");
  try {
    await env.db.query("UPDATE memory_proposals SET status='approved', reviewed_by=$2, reviewed_at=now(), memory_id=$3 WHERE id=$1",
      [pending.id, w.people.reviewer.id, w.memories.alphaApproved.id]);
    await assert.rejects(env.db.query(`INSERT INTO memory_revisions (project_id, memory_id, revision, type, title, content, proposal_id, proposal_revision, approved_by, approved_at)
      VALUES ($1, $2, 2, 'decision', 'Forged', 'Forged', $3, 1, $4, now())`, [w.alpha.id, w.memories.alphaApproved.id, pending.id, w.people.reviewer.id]),
    /needs 2 different approvals/);
  } finally {
    await env.db.exec("ROLLBACK");
  }
  await assert.rejects(env.db.query("DELETE FROM proposal_approvals"), /append-only/);
});

test("agent proposals follow the project policy: off, or limited per agent", async () => {
  const w = await buildWorld(env.ctx);
  const agentProposal = (title: string) => proposeMemory(env.ctx, w.people.agent.id, { projectId: w.alpha.id, type: "lesson", title,
    content: `Synthetic agent lesson ${title}.`, evidenceSourceIds: [w.sources.alpha.id], ownerId: w.people.contributor.id });
  await requireTwo(w, { agentProposals: false });
  await assert.rejects(agentProposal("Blocked lesson"), /does not accept proposals from agents/);
  await setProjectPolicy(env.ctx, w.people.adminA.id, { projectId: w.alpha.id, expectedRevision: 1, requiredApprovals: 2, agentProposals: true, agentPendingLimit: 1, reason: "One at a time" });
  await agentProposal("First lesson");
  await assert.rejects(agentProposal("Second lesson"), /limit is 1/);
  await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, type: "lesson", title: "People are not limited",
    content: "Synthetic human lesson.", evidenceSourceIds: [w.sources.alpha.id] });
});

test("an approval stops counting when its reviewer loses the role or access, and the published count never overstates", async () => {
  const { revokeRole, recordRepositoryAccess } = await import("../src/index.ts");
  const w = await buildWorld(env.ctx);
  await requireTwo(w);
  const pending = w.proposals.alphaPending;
  await recordApproval(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 });
  await revokeRole(env.ctx, w.people.adminA.id, { principalId: w.people.reviewer.id, scope: { level: "project", id: w.alpha.id }, reason: "Left the team" });
  const status = await getApprovalStatus(env.ctx, w.people.adminA.id, pending.id);
  assert.deepEqual(status.approvals.map((a) => [a.reviewerId, a.counts]), [[w.people.reviewer.id, false]]);
  const second = await recordApproval(env.ctx, w.people.adminA.id, { proposalId: pending.id, expectedRevision: 1 });
  assert.equal(second.status, "awaiting_approvals", "the departed reviewer's approval no longer counts");
  assert.equal(second.approvals, 1);
  // Losing repository access has the same effect as losing the role.
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.adminA.id, provider: "github", externalRepositoryId: "1001", canRead: false });
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.adminA.id, provider: "github", externalRepositoryId: "1001", canRead: true });
  const third = await recordApproval(env.ctx, w.people.ownerA.id, { proposalId: pending.id, expectedRevision: 1 });
  assert.equal(third.status, "published");
  if (third.status !== "published") return;
  assert.equal(third.memory.approvals, 2);
  await revokeRole(env.ctx, w.people.ownerA.id, { principalId: w.people.adminA.id, scope: { level: "organization", id: w.orgA.id }, reason: "Changed teams" });
  assert.equal((await getMemory(env.ctx, w.people.reader.id, third.memory.id)).approvals, 2, "the count recorded at publication stays");
});

test("the database refuses a published approval count higher than the approvals that still count", async () => {
  const w = await buildWorld(env.ctx);
  const pending = w.proposals.alphaPending;
  await recordApproval(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 }).catch(() => undefined);
  const { rows } = await env.db.query<{ approval_count: number | null }>(
    "SELECT approval_count FROM memory_revisions WHERE proposal_id = $1", [pending.id]);
  assert.equal(rows[0]?.approval_count, 1, "a default-policy publication records one counted approval");
  const next = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, type: "lesson", title: "Forged count",
    content: "Synthetic.", evidenceSourceIds: [w.sources.alpha.id] });
  await recordApproval(env.ctx, w.people.reviewer.id, { proposalId: next.id, expectedRevision: 1 }).catch(() => undefined);
  await env.db.exec("BEGIN");
  try {
    const memory = (await env.db.query<{ id: string }>("INSERT INTO memories (project_id, owner_id, status, current_revision, created_at) VALUES ($1, $2, 'approved', 1, now()) RETURNING id",
      [w.alpha.id, w.people.contributor.id])).rows[0]!;
    await assert.rejects(env.db.query(`INSERT INTO memory_revisions (project_id, memory_id, revision, type, title, content, proposal_id, proposal_revision, approved_by, approved_at, approval_count)
      VALUES ($1, $2, 1, 'lesson', 'Forged count', 'Synthetic.', $3, 1, $4, now(), 3)`, [w.alpha.id, memory.id, next.id, w.people.reviewer.id]), /different approvals/);
  } finally {
    await env.db.exec("ROLLBACK");
  }
});

test("a concurrent policy raise and approval never surface a raw policy-trigger error", async () => {
  const w = await buildWorld(env.ctx);
  const pending = w.proposals.alphaPending;
  const outcomes = await Promise.allSettled([
    approveProposal(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 }),
    setProjectPolicy(env.ctx, w.people.adminA.id, { projectId: w.alpha.id, expectedRevision: 0, requiredApprovals: 3,
      agentProposals: true, agentPendingLimit: 25, reason: "Raise the bar mid-review" }),
  ]);
  for (const outcome of outcomes) {
    if (outcome.status !== "rejected") continue;
    const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    assert.ok(outcome.reason instanceof ConflictError, `expected a domain conflict, got: ${message}`);
    assert.doesNotMatch(message, /Publication needs|check_violation|23514/);
  }
});
