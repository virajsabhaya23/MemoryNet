import assert from "node:assert/strict";
import { test } from "node:test";
import { createGuardRun, getGuardProposalProvenance, getGuardRun, publishGuardCandidate } from "../src/decision-guard/workflow.ts";
import type { DecisionGuardProvider } from "../src/decision-guard/model.ts";
import { approveProposal, connectRepository, editProposal, getMemory, getProposal, proposeChange, proposeMemory, recordSource, recordRepositoryAccess, revokeRole, ValidationError, NotFoundError, ConflictError, ForbiddenError } from "../src/index.ts";
import type { Database } from "../src/db.ts";
import { buildWorld, project, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();
function provider(beforeReturn?: () => Promise<void>, includeHints = true) {
  const state = { calls: 0 };
  const model: DecisionGuardProvider = { async complete(messages) {
    state.calls += 1;
    const input = JSON.parse(messages[1]!.content);
    const source = input.sources[0];
    await beforeReturn?.();
    return { provider: "controlled-test-double", model: "controlled-model", usage: { inputTokens: 100, outputTokens: 30 },
      text: JSON.stringify({ candidates: [{ title: "Controlled model-derived decision", decision: "Controlled proposed engineering decision; human review required.",
        evidence: [{ sourceId: source.sourceId, start: 0, end: source.text.length, quote: source.text }],
        possibleConflicts: includeHints ? input.approvedDecisions.map((memory: { memoryId: string; revision: number }) => ({ memoryId: memory.memoryId, revision: memory.revision, reason: "Controlled possible conflict, not replacement authority." })) : [],
      }] }),
    };
  } };
  return { model, state };
}
async function create(w: Awaited<ReturnType<typeof buildWorld>>, p = provider(), decisions = true) {
  return createGuardRun(env.ctx, w.people.reviewer.id, w.people.agent.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id], decisionIds: decisions ? [w.memories.alphaApproved.id] : [],
  });
}
async function counts() {
  return (await env.db.query<{ runs: string; publications: string; proposals: string; memories: string }>(
    "SELECT (SELECT count(*) FROM decision_guard_runs)::text runs,(SELECT count(*) FROM decision_guard_publications)::text publications,(SELECT count(*) FROM memory_proposals)::text proposals,(SELECT count(*) FROM memories)::text memories",
  )).rows[0]!;
}
async function extraSource(w: Awaited<ReturnType<typeof buildWorld>>) {
  await connectRepository(env.ctx, w.people.ownerA.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1009", fullName: "synthetic-org-a/extra-context" });
  for (const person of [w.people.reviewer, w.people.agent]) await recordRepositoryAccess(env.ctx, { principalId: person.id, provider: "github", externalRepositoryId: "1009", canRead: true });
  return recordSource(env.ctx, w.people.reviewer.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1009", reference: "pull/99", url: "https://github.com/synthetic-org-a/extra-context/pull/99", revision: "a".repeat(40), excerpt: "Controlled additional engineering context." });
}

test("single extraction persists an immutable unreviewed run without publishing trusted knowledge", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider(); const before = await counts();
  const run = await create(w, p);
  assert.equal(p.state.calls, 1);
  assert.equal(run.requesterId, w.people.reviewer.id);
  assert.equal(run.agentId, w.people.agent.id);
  assert.equal(run.extraction.reviewState, "unreviewed");
  assert.equal(run.extraction.sourceSnapshots[0]?.text, w.sources.alpha.excerpt);
  assert.deepEqual(run.publications, []);
  const after = await counts();
  assert.equal(Number(after.runs), Number(before.runs) + 1);
  assert.equal(after.proposals, before.proposals);
  assert.equal(after.memories, before.memories);
  await assert.rejects(env.db.query("UPDATE decision_guard_runs SET extraction='{}'::jsonb WHERE id=$1", [run.id]));
  await assert.rejects(env.db.query("DELETE FROM decision_guard_run_sources WHERE run_id=$1", [run.id]));
});

test("selected candidate becomes agent-authored pending proposal with exact revision provenance", async () => {
  const w = await buildWorld(env.ctx); const run = await create(w);
  const proposal = await publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "new" });
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.proposedBy, w.people.agent.id);
  assert.equal(proposal.ownerId, w.people.reviewer.id);
  assert.equal(proposal.title, run.extraction.candidates[0]?.title);
  const provenance = await getGuardProposalProvenance(env.ctx, w.people.reviewer.id, proposal.id, 1);
  assert.equal(provenance?.run.id, run.id);
  assert.equal(provenance?.publication.proposalRevision, 1);
  assert.deepEqual(provenance?.candidate.evidence, run.extraction.candidates[0]?.evidence);
  assert.equal(await getGuardProposalProvenance(env.ctx, w.people.reviewer.id, proposal.id, 2), null);
  await assert.rejects(env.db.query("UPDATE decision_guard_publications SET proposal_revision=2 WHERE proposal_id=$1", [proposal.id]));
  await assert.rejects(approveProposal(env.ctx, w.people.agent.id, { proposalId: proposal.id, expectedRevision: 1 }), ForbiddenError);
  // The actual requesting human can approve the unedited agent-authored version.
  const approved = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 });
  assert.equal(approved.status, "approved");
});

test("explicit replacement remains pending and preserves prior authority until real human approval", async () => {
  const w = await buildWorld(env.ctx); const run = await create(w);
  const proposal = await publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "replace", targetMemoryId: w.memories.alphaApproved.id });
  assert.equal(proposal.changeKind, "replace");
  assert.equal(proposal.baseRevision, 1);
  assert.equal((await getMemory(env.ctx, w.people.reviewer.id, w.memories.alphaApproved.id)).status, "approved");
  const replacement = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
  const old = await getMemory(env.ctx, w.people.reviewer.id, w.memories.alphaApproved.id);
  assert.equal(old.status, "superseded");
  assert.equal(old.supersededBy, replacement.id);
  const replay = await publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "replace", targetMemoryId: w.memories.alphaApproved.id });
  assert.equal(replay.id, proposal.id);
});

test("an explicit human replacement can select a compared decision without a model conflict hint", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider(undefined, false);
  const run = await create(w, p);
  assert.deepEqual(run.extraction.candidates[0]?.possibleConflicts, []);
  assert.deepEqual(run.comparedDecisions, [{ memoryId: w.memories.alphaApproved.id, revision: 1 }]);
  const proposal = await publishGuardCandidate(env.ctx, w.people.reviewer.id, {
    runId: run.id, candidateIndex: 0, kind: "replace", targetMemoryId: w.memories.alphaApproved.id,
  });
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.changeKind, "replace");
  assert.equal(proposal.baseRevision, 1);
  assert.equal((await getMemory(env.ctx, w.people.reviewer.id, w.memories.alphaApproved.id)).status, "approved");
  const provenance = await getGuardProposalProvenance(env.ctx, w.people.reviewer.id, proposal.id, 1);
  assert.deepEqual(provenance?.candidate.possibleConflicts, [], "human selection never rewrites the model's observed hints");
  assert.equal(provenance?.publication.targetMemoryId, w.memories.alphaApproved.id);
  const replacement = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 });
  assert.equal((await getMemory(env.ctx, w.people.reviewer.id, w.memories.alphaApproved.id)).supersededBy, replacement.id);
  assert.equal(p.state.calls, 1);
});

test("no-hint replacement rejects uncompared, forged and stale targets without widening the immutable comparison set", async () => {
  const w = await buildWorld(env.ctx);
  const unselectedProposal = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id,
    type: "decision", title: "Unselected current decision", content: "Controlled separate guidance not included in extraction.",
    evidenceSourceIds: [w.sources.alpha.id] });
  const unselected = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: unselectedProposal.id, expectedRevision: 1 });
  const run = await create(w, provider(undefined, false));
  const before = await counts();
  for (const targetMemoryId of [unselected.id, w.memories.betaApproved.id]) {
    await assert.rejects(publishGuardCandidate(env.ctx, w.people.reviewer.id, {
      runId: run.id, candidateIndex: 0, kind: "replace", targetMemoryId,
    }), ValidationError);
  }
  assert.deepEqual(await counts(), before);
  const empty = await create(w, provider(undefined, false), false);
  assert.deepEqual(empty.comparedDecisions, []);
  await assert.rejects(publishGuardCandidate(env.ctx, w.people.reviewer.id, {
    runId: empty.id, candidateIndex: 0, kind: "replace", targetMemoryId: w.memories.alphaApproved.id,
  }), ValidationError);
  const revision = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: w.memories.alphaApproved.id,
    expectedRevision: 1, kind: "revise", type: "decision", title: "New compared revision", content: "Controlled changed guidance.",
    evidenceSourceIds: [w.sources.alpha.id] });
  await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: revision.id, expectedRevision: 1 });
  const afterRevision = await counts();
  await assert.rejects(publishGuardCandidate(env.ctx, w.people.reviewer.id, {
    runId: run.id, candidateIndex: 0, kind: "replace", targetMemoryId: w.memories.alphaApproved.id,
  }), ConflictError);
  assert.deepEqual(await counts(), afterRevision);
});

test("concurrent/repeated selected-candidate publication is idempotent", async () => {
  const w = await buildWorld(env.ctx); const run = await create(w);
  const input = { runId: run.id, candidateIndex: 0, kind: "new" as const };
  const before = await counts();
  const [a, b] = await Promise.all([publishGuardCandidate(env.ctx, w.people.reviewer.id, input), publishGuardCandidate(env.ctx, w.people.reviewer.id, input)]);
  assert.equal(a.id, b.id);
  const after = await counts();
  assert.equal(Number(after.publications), Number(before.publications) + 1);
  assert.equal(Number(after.proposals), Number(before.proposals) + 1);
  await assert.rejects(publishGuardCandidate(env.ctx, w.people.reviewer.id, { ...input, kind: "replace", targetMemoryId: w.memories.alphaApproved.id }), ConflictError);
});

test("forged replacement targets, absent indices and another human publishing are refused", async () => {
  const w = await buildWorld(env.ctx); const run = await create(w);
  await assert.rejects(publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "replace", targetMemoryId: w.memories.betaApproved.id }), ValidationError);
  await assert.rejects(publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 5, kind: "new" }), ValidationError);
  await assert.rejects(publishGuardCandidate(env.ctx, w.people.contributor.id, { runId: run.id, candidateIndex: 0, kind: "new" }), ForbiddenError);
  assert.equal((await getGuardRun(env.ctx, w.people.reviewer.id, run.id)).publications.length, 0);
});

test("requester and bound agent independently require contributor and source permissions", async () => {
  const w = await buildWorld(env.ctx); const p = provider();
  const input = { projectId: w.alpha.id, sourceIds: [w.sources.alpha.id] };
  await assert.rejects(createGuardRun(env.ctx, w.people.reader.id, w.people.agent.id, p.model, input));
  await assert.rejects(createGuardRun(env.ctx, w.people.reviewer.id, w.people.contributor.id, p.model, input), ValidationError);
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.agent.id, provider: "github", externalRepositoryId: "1001", canRead: false });
  await assert.rejects(createGuardRun(env.ctx, w.people.reviewer.id, w.people.agent.id, p.model, input), NotFoundError);
  assert.equal(p.state.calls, 0);
});

test("permission revocation after extraction blocks run reads, publish and provenance reads", async () => {
  const w = await buildWorld(env.ctx); const run = await create(w);
  const proposal = await publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "new" });
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reviewer.id, provider: "github", externalRepositoryId: "1001", canRead: false });
  await assert.rejects(getGuardRun(env.ctx, w.people.reviewer.id, run.id), NotFoundError);
  await assert.rejects(publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "new" }), NotFoundError);
  await assert.rejects(getGuardProposalProvenance(env.ctx, w.people.reviewer.id, proposal.id), NotFoundError);
});

test("agent permission withdrawn before publication prevents pending write", async () => {
  const w = await buildWorld(env.ctx); const run = await create(w); const before = await counts();
  await revokeRole(env.ctx, w.people.adminA.id, { principalId: w.people.agent.id, scope: project(w.alpha.id), reason: "Controlled test revocation" });
  await assert.rejects(publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "new" }), NotFoundError);
  assert.deepEqual(await counts(), before);
});

test("source snapshots changing before publication invalidate the model draft", async () => {
  const w = await buildWorld(env.ctx); const run = await create(w); const before = await counts();
  await env.db.query("UPDATE sources SET excerpt=$1 WHERE id=$2", ["Controlled changed source text", w.sources.alpha.id]);
  await assert.rejects(publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "new" }), ConflictError);
  assert.deepEqual(await counts(), before);
});

test("newly approved decision versions invalidate an earlier unpublished model draft", async () => {
  const w = await buildWorld(env.ctx); const run = await create(w);
  const revision = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: w.memories.alphaApproved.id, expectedRevision: 1, kind: "revise", type: "decision", title: "Controlled revised guidance", content: "Controlled changed decision context.", evidenceSourceIds: [w.sources.alpha.id] });
  await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: revision.id, expectedRevision: 1 });
  const before = await counts();
  await assert.rejects(publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "replace", targetMemoryId: w.memories.alphaApproved.id }), ConflictError);
  assert.deepEqual(await counts(), before);
});

test("requester access revoked during model inference prevents persistent draft", async () => {
  const w = await buildWorld(env.ctx); const before = await counts();
  const p = provider(async () => {
    env.advance(1);
    await recordRepositoryAccess(env.ctx, { principalId: w.people.reviewer.id, provider: "github", externalRepositoryId: "1001", canRead: false });
  });
  await assert.rejects(create(w, p), NotFoundError);
  assert.equal(p.state.calls, 1);
  assert.deepEqual(await counts(), before);
});

test("publication provenance failure rolls back the pending proposal atomically", async () => {
  const w = await buildWorld(env.ctx); const run = await create(w); const before = await counts(); const original = env.ctx;
  const db: Database = {
    query: (sql, params) => original.db.query(sql, params), exec: (sql) => original.db.exec(sql), close: () => original.db.close(),
    transaction: (fn) => original.db.transaction(async (tx) => fn({
      exec: (sql) => tx.exec(sql), async query<T>(sql: string, params?: unknown[]) {
        if (sql.includes("INSERT INTO decision_guard_publications")) throw new Error("Controlled provenance write failure");
        return tx.query<T>(sql, params);
      },
    })),
  };
  await assert.rejects(publishGuardCandidate({ ...original, db }, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "new" }), /Controlled provenance write failure/);
  assert.deepEqual(await counts(), before);
});

test("uncited selected inputs remain proposal and approved-memory access dependencies", async () => {
  const w = await buildWorld(env.ctx); const extra = await extraSource(w); const p = provider();
  const run = await createGuardRun(env.ctx, w.people.reviewer.id, w.people.agent.id, p.model, { projectId: w.alpha.id, sourceIds: [w.sources.alpha.id, extra.id] });
  const proposal = await publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "new" });
  await assert.rejects(editProposal(env.ctx, w.people.reviewer.id, {
    proposalId: proposal.id, expectedRevision: 1, type: proposal.type, title: proposal.title, content: proposal.content,
    evidenceSourceIds: [w.sources.alpha.id], ownerId: proposal.ownerId,
  }), ValidationError);
  assert.equal(run.extraction.candidates[0]!.evidence.length, 1);
  assert.equal(proposal.evidence.length, 2, "all model inputs, not only exact quotes, constrain derived content");
  const citedId = run.extraction.candidates[0]!.evidence[0]!.sourceId;
  const uncited = [w.sources.alpha, extra].find((source) => source.id !== citedId)!;
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reviewer.id, provider: "github", externalRepositoryId: uncited.externalRepositoryId, canRead: false });
  await assert.rejects(getProposal(env.ctx, w.people.reviewer.id, proposal.id), NotFoundError);
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reviewer.id, provider: "github", externalRepositoryId: uncited.externalRepositoryId, canRead: true });
  const approved = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 });
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reviewer.id, provider: "github", externalRepositoryId: uncited.externalRepositoryId, canRead: false });
  await assert.rejects(getMemory(env.ctx, w.people.reviewer.id, approved.id), NotFoundError);
});

test("conflict-decision evidence remains a dependency even when only another input is quoted", async () => {
  const w = await buildWorld(env.ctx); const extra = await extraSource(w); const p = provider();
  const run = await createGuardRun(env.ctx, w.people.reviewer.id, w.people.agent.id, p.model, { projectId: w.alpha.id, sourceIds: [extra.id], decisionIds: [w.memories.alphaApproved.id] });
  const proposal = await publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "new" });
  assert.equal(run.extraction.candidates[0]!.evidence[0]!.sourceId, extra.id);
  assert.deepEqual(proposal.evidence.map((item) => item.sourceId).sort(), [extra.id, w.sources.alpha.id].sort());
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reviewer.id, provider: "github", externalRepositoryId: "1001", canRead: false });
  await assert.rejects(getProposal(env.ctx, w.people.reviewer.id, proposal.id), NotFoundError);
  await assert.rejects(getGuardRun(env.ctx, w.people.reviewer.id, run.id), NotFoundError);
});

test("combined model-context dependencies exceeding proposal limit are refused before disclosure", async () => {
  const w = await buildWorld(env.ctx); const extra = await extraSource(w); const p = provider();
  const sources = [];
  for (let i = 0; i < 20; i += 1) sources.push(await recordSource(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id, provider: "github", externalRepositoryId: "1001", reference: `pull/${100 + i}`,
    url: `https://github.com/synthetic-org-a/alpha-service/pull/${100 + i}`, revision: "a".repeat(40), excerpt: `Controlled evidence item ${i}`,
  }));
  const pending = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, type: "decision", title: "Controlled many-source decision", content: "Controlled approved context with twenty dependencies.", evidenceSourceIds: sources.map((source) => source.id) });
  const approved = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: pending.id, expectedRevision: 1 });
  const before = await counts();
  await assert.rejects(createGuardRun(env.ctx, w.people.reviewer.id, w.people.agent.id, p.model, { projectId: w.alpha.id, sourceIds: [extra.id], decisionIds: [approved.id] }), /dependency limit/);
  assert.equal(p.state.calls, 0);
  assert.deepEqual(await counts(), before);
});

test("requester-only source revocation at final dual admission blocks the single provider call", async () => {
  const w = await buildWorld(env.ctx); const p = provider(); const original = env.ctx; const before = await counts();
  let transactions = 0;
  let revoked = false;
  const db: Database = {
    query: (sql, params) => original.db.query(sql, params), exec: (sql) => original.db.exec(sql), close: () => original.db.close(),
    async transaction(fn) {
      transactions += 1;
      if (transactions === 3) {
        revoked = true;
        env.advance(1);
        await recordRepositoryAccess(env.ctx, { principalId: w.people.reviewer.id, provider: "github", externalRepositoryId: "1001", canRead: false });
      }
      return original.db.transaction(fn);
    },
  };
  await assert.rejects(createGuardRun({ ...original, db }, w.people.reviewer.id, w.people.agent.id, p.model, { projectId: w.alpha.id, sourceIds: [w.sources.alpha.id] }), NotFoundError);
  assert.equal(revoked, true);
  assert.equal(p.state.calls, 0);
  assert.deepEqual(await counts(), before);
});

test("database prevents linked proposal content or dependency downgrades while human approval still works", async () => {
  const w = await buildWorld(env.ctx); const extra = await extraSource(w); const p = provider();
  const run = await createGuardRun(env.ctx, w.people.reviewer.id, w.people.agent.id, p.model, { projectId: w.alpha.id, sourceIds: [w.sources.alpha.id, extra.id] });
  const proposal = await publishGuardCandidate(env.ctx, w.people.reviewer.id, { runId: run.id, candidateIndex: 0, kind: "new" });
  const attempted = [
    ["UPDATE memory_proposals SET content='Controlled changed content' WHERE id=$1", [proposal.id]],
    ["UPDATE memory_proposals SET revision=revision+1 WHERE id=$1", [proposal.id]],
    ["DELETE FROM proposal_evidence WHERE proposal_id=$1 AND source_id=$2", [proposal.id, extra.id]],
    ["UPDATE proposal_evidence SET source_id=source_id WHERE proposal_id=$1", [proposal.id]],
    ["INSERT INTO proposal_evidence(project_id,proposal_id,source_id) VALUES($1,$2,$3)", [w.alpha.id, proposal.id, extra.id]],
    ["DELETE FROM proposal_revision_evidence WHERE proposal_id=$1", [proposal.id]],
    ["UPDATE proposal_revision_evidence SET source_id=source_id WHERE proposal_id=$1", [proposal.id]],
    ["UPDATE proposal_revisions SET content='Controlled changed version' WHERE proposal_id=$1", [proposal.id]],
    ["DELETE FROM proposal_revisions WHERE proposal_id=$1", [proposal.id]],
  ] as const;
  for (const [sql, params] of attempted) await assert.rejects(env.db.query(sql, [...params]), /immutable/);
  const unchanged = await getProposal(env.ctx, w.people.reviewer.id, proposal.id);
  assert.equal(unchanged.revision, 1);
  assert.equal(unchanged.evidence.length, 2);
  const approved = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 });
  assert.equal(approved.evidence.length, 2);
});

test("likely secrets generated in model output are refused before draft persistence", async () => {
  const w = await buildWorld(env.ctx); const before = await counts(); const base = provider();
  const generatedSecret: DecisionGuardProvider = { async complete(messages) {
    const result = await base.model.complete(messages);
    const parsed = JSON.parse(result.text);
    parsed.candidates[0].decision += " Controlled fixture api_key=testing123456value";
    return { ...result, text: JSON.stringify(parsed) };
  } };
  await assert.rejects(createGuardRun(env.ctx, w.people.reviewer.id, w.people.agent.id, generatedSecret, { projectId: w.alpha.id, sourceIds: [w.sources.alpha.id] }),
    (error: unknown) => error instanceof ValidationError && !error.message.includes("testing123456value"));
  assert.deepEqual(await counts(), before);
});
