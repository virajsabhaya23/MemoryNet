import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { approveProposal, proposeChange, ConflictError, createWork, exportWork, listWork } from "../index.ts";
import { createSyntheticEvaluationFixture } from "../evaluation/fixture.ts";

// Isolated synthetic lifecycle demonstration; fixture approvals do not represent human review.
const f = await createSyntheticEvaluationFixture();
try {
  const proposal = await f.propose("Retry requests", "Retry requests at most three times.");
  const decision = await approveProposal(f.ctx, f.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 });
  const spec = "# Retry policy\nRequirement RETRY-001: Retry requests at most three times.\n";
  const workId = await createWork(f.ctx, f.owner.id, { projectId: f.project.id, title: "Synthetic OpenSpec retry change",
    repositoryId: f.repositoryId, branch: "main", codeCommit: "a".repeat(40),
    artifacts: [{ kind: "spec", path: "openspec/changes/retries/specs/transport/spec.md", requirementId: "RETRY-001", sha256: createHash("sha256").update(spec).digest("hex") }],
    decisions: [{ memoryId: decision.id, revision: decision.revision }] });
  const initial = await exportWork(f.ctx, f.agent.id, workId);
  assert.equal(initial.contextStatus, "current");
  const changed = await proposeChange(f.ctx, f.owner.id, { memoryId: decision.id, expectedRevision: 1, kind: "replace", type: "decision",
    title: "Retry requests once", content: "Retry requests at most once.", evidenceSourceIds: [f.source.id] });
  await approveProposal(f.ctx, f.reviewer.id, { proposalId: changed.id, expectedRevision: 1 });
  const affected = await listWork(f.ctx, f.agent.id, f.project.id);
  assert.equal(affected[0]?.contextStatus, "review_needed");
  await assert.rejects(exportWork(f.ctx, f.agent.id, workId), ConflictError);
  console.log(JSON.stringify({ synthetic: true, fixtureApprovals: true, metaCalls: 0,
    initialContext: initial.contextStatus, affectedTasks: affected.length,
    changedDecisionDetected: affected[0]?.issues.some((i) => i.reason === "not_approved"), staleExportBlocked: true,
    verifiedCodeBehavior: false }, null, 2));
} finally { await f.close(); }
