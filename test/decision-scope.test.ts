import assert from "node:assert/strict";
import { test } from "node:test";
import { approveProposal, connectRepository, editProposal, getContext, getMemory, getMemoryHistory, getProposal, getProposalHistory,
  normalizeDecisionApplicability, listRetrievals, proposeChange, proposeMemory, proposeRestore, recordRepositoryAccess, reinstateMemory,
  revokeMemory, suspendMemory, ConflictError, ForbiddenError, NotFoundError, ValidationError, type DecisionApplicabilityInput } from "../src/index.ts";
import { buildWorld, START, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();
type World = Awaited<ReturnType<typeof buildWorld>>;
function scope(branch = "main", repositoryId = "1001", validUntil: Date | null = null): DecisionApplicabilityInput {
  return { repositoryId, branch, validFrom: START, validUntil };
}
async function pending(w: World, applicability = scope(), title = "Scoped queue retries") {
  return proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, type: "decision", title,
    content: `Controlled current engineering guidance for ${title}.`, evidenceSourceIds: [w.sources.alpha.id], applicability });
}
async function approved(w: World, applicability = scope(), title?: string) {
  const proposal = await pending(w, applicability, title);
  return approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
}
async function context(w: World, branch = "main", repositoryId = "1001", limit = 8) {
  return getContext(env.ctx, w.people.reader.id, { projectId: w.alpha.id, query: "queue retries", limit, applicability: { repositoryId, branch } });
}
async function extraRepository(w: World) {
  await connectRepository(env.ctx, w.people.ownerA.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1009", fullName: "synthetic-org-a/applicability" });
  for (const person of [w.people.contributor, w.people.reviewer, w.people.reader, w.people.agent]) await recordRepositoryAccess(env.ctx,
    { principalId: person.id, provider: "github", externalRepositoryId: "1009", canRead: true });
}

test("reviewed repository branch and half-open interval survive exact proposal/memory history", async () => {
  const w = await buildWorld(env.ctx); const metadata = scope("release/1", "1001", new Date(START.getTime() + 10_000));
  const proposal = await pending(w, metadata);
  assert.deepEqual(proposal.applicability, normalizeDecisionApplicability(metadata));
  const memory = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 });
  assert.deepEqual(memory.applicability, normalizeDecisionApplicability(metadata));
  await assert.rejects(getProposalHistory(env.ctx, w.people.reader.id, proposal.id), NotFoundError);
  assert.deepEqual((await getMemoryHistory(env.ctx, w.people.reader.id, memory.id)).versions[0]?.applicability, memory.applicability);
  assert.equal((await context(w, "release/1")).current[0]?.memoryId, memory.id);
  assert.equal((await context(w, "Release/1")).current.length, 0, "exact branch comparison is case sensitive");
});

test("legacy approved knowledge remains project readable and is excluded from explicit scoped context", async () => {
  const w = await buildWorld(env.ctx);
  assert.equal((await getMemory(env.ctx, w.people.reader.id, w.memories.alphaApproved.id)).applicability, null);
  const scoped = await context(w);
  assert.equal(scoped.current.length, 0);
  assert.equal(scoped.notCurrent.length, 0);
  assert.equal((await getContext(env.ctx, w.people.reader.id, { projectId: w.alpha.id, query: "queue retries" })).current[0]?.memoryId, w.memories.alphaApproved.id);
});

test("applicability is filtered before ranking, result limit and retrieval-item logging", async () => {
  const w = await buildWorld(env.ctx);
  for (let i = 0; i < 3; i += 1) await approved(w, scope("other"), `Queue retries queue retries unrelated branch ${i}`);
  const current = await approved(w, scope(), "Scoped queue policy");
  const result = await context(w, "main", "1001", 1);
  assert.deepEqual(result.current.map((item) => item.memoryId), [current.id]);
  assert.equal(result.moreMatches, false);
  const items = await env.db.query<{ memory_id: string }>("SELECT memory_id FROM retrieval_items WHERE retrieval_id=$1", [result.retrievalId]);
  assert.deepEqual(items.rows.map((row) => row.memory_id), [current.id]);
  const trace = (await env.db.query<{ applicability: { branch: string } }>("SELECT applicability FROM retrievals WHERE id=$1", [result.retrievalId])).rows[0]!;
  assert.equal(trace.applicability.branch, "main");
});

test("start is inclusive and end exclusive; historical/future context queries fail closed", async () => {
  const w = await buildWorld(env.ctx); await approved(w, scope("main", "1001", new Date(START.getTime() + 10)));
  assert.equal((await context(w)).current.length, 1);
  env.advance(10);
  assert.equal((await context(w)).current.length, 0);
  for (const at of [START, new Date(START.getTime() + 11)]) await assert.rejects(getContext(env.ctx, w.people.reader.id,
    { projectId: w.alpha.id, query: "queue", applicability: { repositoryId: "1001", branch: "main", at } }), ValidationError);
});

test("scope repository permission is required independently of evidence repository permission", async () => {
  const w = await buildWorld(env.ctx); await extraRepository(w);
  const memory = await approved(w, scope("main", "1009"));
  assert.equal((await context(w, "main", "1009")).current[0]?.memoryId, memory.id);
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reader.id, provider: "github", externalRepositoryId: "1009", canRead: false });
  await assert.rejects(context(w, "main", "1009"), NotFoundError);
  await assert.rejects(getMemory(env.ctx, w.people.reader.id, memory.id), NotFoundError);
  assert.equal((await getMemory(env.ctx, w.people.reader.id, w.memories.alphaApproved.id)).id, w.memories.alphaApproved.id);
});

test("foreign or inaccessible applicability repositories cannot be proposed or reviewed", async () => {
  const w = await buildWorld(env.ctx);
  await assert.rejects(pending(w, scope("main", "1002")), NotFoundError);
  await extraRepository(w);
  const proposal = await pending(w, scope("main", "1009"));
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reviewer.id, provider: "github", externalRepositoryId: "1009", canRead: false });
  await assert.rejects(approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 }), NotFoundError);
});

test("scope edits create a new reviewed proposal revision while old scope is immutable", async () => {
  const w = await buildWorld(env.ctx); const proposal = await pending(w);
  const edited = await editProposal(env.ctx, w.people.contributor.id, { proposalId: proposal.id, expectedRevision: 1, type: proposal.type, title: proposal.title,
    content: proposal.content, ownerId: proposal.ownerId, evidenceSourceIds: [w.sources.alpha.id], applicability: scope("release") });
  assert.equal(edited.revision, 2);
  const history = await getProposalHistory(env.ctx, w.people.reviewer.id, proposal.id);
  assert.deepEqual(history.map((version) => version.applicability?.branch), ["main", "release"]);
  await assert.rejects(approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 }), ConflictError);
  const memory = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 2 });
  assert.equal(memory.applicability?.branch, "release");
  await assert.rejects(env.db.query("UPDATE proposal_revisions SET applicability=jsonb_set(applicability,'{branch}','\"other\"') WHERE proposal_id=$1 AND revision=1", [proposal.id]), /immutable/);
  await assert.rejects(env.db.query("UPDATE memory_revisions SET applicability=NULL,applicability_connection_id=NULL WHERE memory_id=$1", [memory.id]), /immutable/);
});

test("same text may be independently reviewed for different exact branches", async () => {
  const w = await buildWorld(env.ctx);
  const a = await approved(w, scope("main"), "Identical scoped queue retries");
  const b = await approved(w, scope("release"), "Identical scoped queue retries");
  assert.notEqual(a.id, b.id);
  assert.deepEqual((await context(w, "release")).current.map((item) => item.memoryId), [b.id]);
});

test("targeted changes cannot globally retire or move decisions into another applicability", async () => {
  const w = await buildWorld(env.ctx); const memory = await approved(w);
  const base = { expectedRevision: 1, kind: "replace" as const, type: "decision" as const, title: "Replacement queue retries", content: "Controlled new guidance.", evidenceSourceIds: [w.sources.alpha.id] };
  await assert.rejects(proposeChange(env.ctx, w.people.contributor.id, { ...base, memoryId: w.memories.alphaApproved.id, applicability: scope() }), ValidationError);
  for (const applicability of [scope("release"), scope("main", "1001", new Date(START.getTime() + 100)), null]) {
    await assert.rejects(proposeChange(env.ctx, w.people.contributor.id, { ...base, memoryId: memory.id, applicability }), ValidationError);
  }
  const proposal = await proposeChange(env.ctx, w.people.contributor.id, { ...base, memoryId: memory.id });
  assert.deepEqual(proposal.applicability, memory.applicability);
  const replacement = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 });
  assert.equal((await getMemory(env.ctx, w.people.reader.id, memory.id)).status, "superseded");
  assert.equal((await context(w)).current[0]?.memoryId, replacement.id);
});

test("revocation requires reviewer human and exact version; current context excludes revoked text", async () => {
  const w = await buildWorld(env.ctx); const memory = await approved(w);
  const input = { memoryId: memory.id, expectedRevision: 1, reason: "Controlled authority withdrawal" };
  for (const caller of [w.people.agent, w.people.reader, w.people.contributor]) await assert.rejects(revokeMemory(env.ctx, caller.id, input), ForbiddenError);
  await assert.rejects(revokeMemory(env.ctx, w.people.reviewer.id, { ...input, expectedRevision: 2 }), ConflictError);
  const revoked = await revokeMemory(env.ctx, w.people.reviewer.id, input);
  assert.equal(revoked.status, "revoked"); assert.equal(revoked.statusGeneration, 1);
  assert.equal((await context(w)).current.length, 0);
  assert.equal((await context(w)).notCurrent[0]?.status, "revoked");
  assert.equal("content" in (await context(w)).notCurrent[0]!, false);
  assert.equal((await getMemoryHistory(env.ctx, w.people.reader.id, memory.id)).statusChanges[0]?.to, "revoked");
  const audit = await env.db.query<{ action: string }>("SELECT action FROM audit_events WHERE target_id=$1 ORDER BY id DESC", [memory.id]);
  assert.equal(audit.rows[0]?.action, "memory.revoked");
});

test("pre-revocation pending changes cannot undo revocation; a fresh reviewed revision can", async () => {
  const w = await buildWorld(env.ctx); const memory = await approved(w);
  const fields = { memoryId: memory.id, expectedRevision: 1, kind: "revise" as const, type: "decision" as const, title: "Old pending queue retries", content: "Controlled proposed change.", evidenceSourceIds: [w.sources.alpha.id] };
  const stale = await proposeChange(env.ctx, w.people.contributor.id, fields);
  await revokeMemory(env.ctx, w.people.reviewer.id, { memoryId: memory.id, expectedRevision: 1, reason: "Controlled revocation" });
  await assert.rejects(approveProposal(env.ctx, w.people.reviewer.id, { proposalId: stale.id, expectedRevision: 1 }), ConflictError);
  await assert.rejects(reinstateMemory(env.ctx, w.people.reviewer.id, { memoryId: memory.id, expectedRevision: 1, reason: "Attempt bypass" }), ConflictError);
  await assert.rejects(proposeRestore(env.ctx, w.people.contributor.id, { memoryId: memory.id, expectedRevision: 1, fromRevision: 1 }), ConflictError);
  await assert.rejects(env.db.query("UPDATE memories SET status='approved' WHERE id=$1", [memory.id]), /newly reviewed/);
  const fresh = await proposeChange(env.ctx, w.people.contributor.id, { ...fields, title: "Fresh reviewed queue retries" });
  assert.equal(fresh.baseStatusGeneration, 1);
  const reviewed = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: fresh.id, expectedRevision: 1 });
  assert.equal(reviewed.status, "approved"); assert.equal(reviewed.revision, 2); assert.equal(reviewed.statusGeneration, 2);
});

test("same-clock suspend/reinstate cycles still invalidate earlier pending authority", async () => {
  const w = await buildWorld(env.ctx); const memory = await approved(w);
  const proposal = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: memory.id, expectedRevision: 1, kind: "revise", type: "decision", title: "Pending queue revision", content: "Controlled revision.", evidenceSourceIds: [w.sources.alpha.id] });
  await suspendMemory(env.ctx, w.people.contributor.id, { memoryId: memory.id, expectedRevision: 1, reason: "Controlled dispute" });
  await reinstateMemory(env.ctx, w.people.reviewer.id, { memoryId: memory.id, expectedRevision: 1, reason: "Controlled dispute resolved" });
  await assert.rejects(approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 }), ConflictError);
  assert.equal((await getMemory(env.ctx, w.people.reader.id, memory.id)).statusGeneration, 2);
});

test("branch and interval validation rejects wildcard-like or malformed scopes", () => {
  for (const branch of ["", "main*", "main..other", "/main", "main/", "heads//main", ".private", "main.lock", "@", "main@{old}", "main other"]) {
    assert.throws(() => normalizeDecisionApplicability(scope(branch)), ValidationError);
  }
  assert.throws(() => normalizeDecisionApplicability({ ...scope(), validFrom: "2026-10-30" }), ValidationError);
  assert.throws(() => normalizeDecisionApplicability({ ...scope(), validFrom: "2026-02-30T00:00:00Z" }), ValidationError);
  assert.throws(() => normalizeDecisionApplicability({ ...scope(), validFrom: "2026-01-01T24:00:00Z" }), ValidationError);
  assert.equal(normalizeDecisionApplicability({ ...scope(), validFrom: "2026-09-24T04:00:00-05:00" })?.validFrom.toISOString(), START.toISOString());
  assert.throws(() => normalizeDecisionApplicability(scope("main", "1001", new Date(START.getTime()))), ValidationError);
});

test("scoped receipt metadata and searched terms disappear when scope repository access is withdrawn", async () => {
  const w = await buildWorld(env.ctx); await extraRepository(w); await approved(w, scope("main", "1009"));
  const response = await context(w, "main", "1009");
  const visible = await listRetrievals(env.ctx, w.people.reader.id, { projectId: w.alpha.id });
  assert.equal(visible[0]?.id, response.retrievalId);
  assert.equal(visible[0]?.applicability?.repositoryId, "1009");
  assert.equal(visible[0]?.applicability?.branch, "main");
  assert.equal(visible[0]?.applicability?.at.toISOString(), START.toISOString());
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reader.id, provider: "github", externalRepositoryId: "1009", canRead: false });
  assert.deepEqual(await listRetrievals(env.ctx, w.people.reader.id, { projectId: w.alpha.id }), []);
  assert.equal((await getMemory(env.ctx, w.people.reader.id, w.memories.alphaApproved.id)).id, w.memories.alphaApproved.id);
});
