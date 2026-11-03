import assert from "node:assert/strict";
import { test } from "node:test";
import { approveProposal, proposeMemory, proposeChange, suspendMemory, reinstateMemory, revokeMemory,
  connectRepository, recordSource, recordRepositoryAccess, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../src/index.ts";
import { createWork, listWork, exportWork, closeWork, type WorkInput } from "../src/work.ts";
import { buildWorld, START, useTestDatabase } from "./helpers.ts";
import { openApp, TestBrowser } from "./web-helpers.ts";

const env = useTestDatabase();
async function setup(validUntil: Date | null = null) {
  const w = await buildWorld(env.ctx);
  const proposal = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id,
    type: "decision", title: "Retry policy", content: "Retry at most three times.", evidenceSourceIds: [w.sources.alpha.id],
    applicability: { repositoryId: "1001", branch: "main", validFrom: START, validUntil } });
  const memory = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 });
  const input: WorkInput = { projectId: w.alpha.id, title: "Update retry implementation", repositoryId: "1001", branch: "main",
    codeCommit: "1".repeat(40), artifacts: [{ kind: "spec", path: "openspec/changes/retries/specs/retries/spec.md", requirementId: "RETRY-001", sha256: "2".repeat(64) }],
    decisions: [{ memoryId: memory.id, revision: 1 }] };
  return { w, memory, input };
}

test("work pins approved versions, exports provenance and hashes, and closes without rewriting baseline", async () => {
  const { w, memory, input } = await setup();
  const id = await createWork(env.ctx, w.people.contributor.id, input);
  const [item] = await listWork(env.ctx, w.people.reader.id, w.alpha.id);
  assert.equal(item?.contextStatus, "current");
  assert.equal(item?.work.pins[0]?.revision, 1);
  const bundle = await exportWork(env.ctx, w.people.reader.id, id);
  assert.equal(bundle.decisions[0]?.content, memory.content);
  assert.equal(bundle.decisions[0]?.contentSha256.length, 64);
  assert.equal(bundle.decisions[0]?.citations[0]?.sourceId, w.sources.alpha.id);
  assert.match(bundle.verification, /have not been verified/);
  await assert.rejects(env.db.query("UPDATE decision_work SET title='changed' WHERE id=$1", [id]));
  await closeWork(env.ctx, w.people.contributor.id, id);
  assert.deepEqual(await listWork(env.ctx, w.people.reader.id, w.alpha.id), []);
  await assert.rejects(exportWork(env.ctx, w.people.reader.id, id), ConflictError);
  await assert.rejects(env.db.query("UPDATE decision_work SET closed_at=NULL WHERE id=$1", [id]));
});

test("a mid-task revision invalidates context, blocks export, and does not silently update the pin", async () => {
  const { w, memory, input } = await setup();
  const id = await createWork(env.ctx, w.people.agent.id, input);
  const proposal = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: memory.id, expectedRevision: 1,
    kind: "revise", type: "decision", title: "New retry policy", content: "Retry at most once.", evidenceSourceIds: [w.sources.alpha.id] });
  // A pending suggestion has no effect on the baseline.
  assert.equal((await listWork(env.ctx, w.people.reader.id, w.alpha.id))[0]?.contextStatus, "current");
  await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 });
  const [item] = await listWork(env.ctx, w.people.reader.id, w.alpha.id);
  assert.equal(item?.contextStatus, "review_needed");
  assert.ok(item?.issues.some((i) => i.reason === "revision_changed"));
  assert.equal(item?.work.pins[0]?.revision, 1);
  await assert.rejects(exportWork(env.ctx, w.people.reader.id, id), ConflictError);
  await assert.rejects(createWork(env.ctx, w.people.contributor.id, input), ConflictError);
  const fresh = await createWork(env.ctx, w.people.contributor.id, { ...input, decisions: [{ memoryId: memory.id, revision: 2 }] });
  assert.equal((await exportWork(env.ctx, w.people.reader.id, fresh)).decisions[0]?.revision, 2);
});

test("suspension and reinstatement still require review, revocation cannot be exported", async () => {
  const { w, memory, input } = await setup();
  const id = await createWork(env.ctx, w.people.contributor.id, input);
  const action = { memoryId: memory.id, expectedRevision: 1, reason: "Synthetic authority check" };
  await suspendMemory(env.ctx, w.people.contributor.id, action);
  assert.ok((await listWork(env.ctx, w.people.reader.id, w.alpha.id))[0]?.issues.some((i) => i.reason === "not_approved"));
  await reinstateMemory(env.ctx, w.people.reviewer.id, action);
  assert.deepEqual((await listWork(env.ctx, w.people.reader.id, w.alpha.id))[0]?.issues.map((i) => i.reason), ["lifecycle_changed"]);
  await revokeMemory(env.ctx, w.people.reviewer.id, action);
  await assert.rejects(exportWork(env.ctx, w.people.reader.id, id), ConflictError);
});

test("exact branch, repository and time boundaries are preserved", async () => {
  const { w, input } = await setup(new Date(START.getTime() + 60_000));
  await assert.rejects(createWork(env.ctx, w.people.contributor.id, { ...input, branch: "feature" }), ConflictError);
  await assert.rejects(createWork(env.ctx, w.people.contributor.id, { ...input, repositoryId: "1002" }), NotFoundError);
  const id = await createWork(env.ctx, w.people.contributor.id, input);
  env.advance(60_000);
  assert.deepEqual((await listWork(env.ctx, w.people.reader.id, w.alpha.id))[0]?.issues.map((i) => i.reason), ["outside_validity"]);
  await assert.rejects(exportWork(env.ctx, w.people.reader.id, id), ConflictError);
});

test("permission loss hides entire work record and export; readers cannot create or close", async () => {
  const { w, input } = await setup();
  const id = await createWork(env.ctx, w.people.contributor.id, input);
  await assert.rejects(createWork(env.ctx, w.people.reader.id, input), ForbiddenError);
  await assert.rejects(closeWork(env.ctx, w.people.reader.id, id), ForbiddenError);
  await assert.rejects(listWork(env.ctx, w.people.ownerB.id, w.alpha.id), NotFoundError);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reader.id, provider: "github", externalRepositoryId: "1001", canRead: false });
  assert.deepEqual(await listWork(env.ctx, w.people.reader.id, w.alpha.id), []);
  await assert.rejects(exportWork(env.ctx, w.people.reader.id, id), NotFoundError);
});

test("invalid and unscoped baselines are refused atomically", async () => {
  const { w, input } = await setup();
  for (const bad of [ { ...input, codeCommit: "main" }, { ...input, artifacts: [{ ...input.artifacts[0]!, path: "../secret" }] },
    { ...input, decisions: [...input.decisions, ...input.decisions] }, { ...input, projectId: w.beta.id },
    { ...input, decisions: [{ memoryId: w.memories.alphaApproved.id, revision: 1 }] } ]) {
    await assert.rejects(createWork(env.ctx, w.people.contributor.id, bad));
  }
  await assert.rejects(createWork(env.ctx, w.people.contributor.id, { ...input, extra: "spoof" } as WorkInput), ValidationError);
  assert.equal((await env.db.query<{ count: number }>("SELECT count(*)::int count FROM decision_work")).rows[0]?.count, 0);
});

test("web workflow creates a spec hash, downloads scoped context, and shows changes with CSRF protection", async () => {
  const { w, memory, input } = await setup();
  const app = openApp(env.ctx), browser = new TestBrowser(app);
  await browser.signIn(w.people.contributor.id);
  const path = `/projects/${w.alpha.id}/work`;
  assert.match((await browser.get(path)).body, /No active work/);
  const fields = { title: input.title, repositoryId: "1001", branch: "main", codeCommit: input.codeCommit,
    path: input.artifacts[0]!.path, requirementId: "RETRY-001", specText: "# Retry requirements\n", decisions: `${memory.id}@1` };
  assert.equal((await browser.post(path, { ...fields, _csrf: "wrong" })).status, 403);
  assert.equal((await browser.post(path, fields)).status, 303);
  const page = await browser.get(path);
  assert.match(page.body, /Context current/);
  const id = (await listWork(env.ctx, w.people.contributor.id, w.alpha.id))[0]!.work.id;
  const json = await browser.get(`/work/${id}/context.json`);
  assert.equal(json.status, 200);
  assert.equal(JSON.parse(json.body).decisions[0].content, memory.content);
  const markdown = await browser.get(`/work/${id}/context.md`);
  assert.equal(markdown.status, 200);
  assert.match(markdown.body, /MemoryNet approved decision context/);
  assert.match(markdown.headers["Content-Disposition"]!, /attachment/);
  await revokeMemory(env.ctx, w.people.reviewer.id, { memoryId: memory.id, expectedRevision: 1, reason: "Synthetic withdrawal" });
  assert.match((await browser.get(path)).body, /Review needed/);
  assert.equal((await browser.get(`/work/${id}/context.md`)).status, 409);
});

test("replacement flags the original task while a release-branch exception stays current", async () => {
  const { w, memory, input } = await setup();
  await createWork(env.ctx, w.people.contributor.id, input);
  const exception = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, type: "decision",
    title: "Release retry exception", content: "Keep three retries on release.", evidenceSourceIds: [w.sources.alpha.id],
    applicability: { repositoryId: "1001", branch: "release/1", validFrom: START, validUntil: null } });
  const approved = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: exception.id, expectedRevision: 1 });
  const releaseId = await createWork(env.ctx, w.people.contributor.id, { ...input, branch: "release/1", decisions: [{ memoryId: approved.id, revision: 1 }] });
  const replacement = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: memory.id, expectedRevision: 1,
    kind: "replace", type: "decision", title: "Replace main retries", content: "Retry once on main.", evidenceSourceIds: [w.sources.alpha.id] });
  await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: replacement.id, expectedRevision: 1 });
  const tasks = await listWork(env.ctx, w.people.reader.id, w.alpha.id);
  assert.equal(tasks.find((t) => t.work.branch === "main")?.contextStatus, "review_needed");
  assert.equal(tasks.find((t) => t.work.id === releaseId)?.contextStatus, "current");
  assert.equal((await exportWork(env.ctx, w.people.reader.id, releaseId)).decisions[0]?.memoryId, approved.id);
});

test("losing pinned historical evidence access hides task metadata even when current evidence is readable", async () => {
  const { w, memory, input } = await setup();
  await connectRepository(env.ctx, w.people.ownerA.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1009", fullName: "synthetic-org-a/old-evidence" });
  for (const person of [w.people.contributor, w.people.reviewer, w.people.reader]) await recordRepositoryAccess(env.ctx,
    { principalId: person.id, provider: "github", externalRepositoryId: "1009", canRead: true });
  const oldSource = await recordSource(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1009",
    reference: "pull/1", url: "https://github.com/synthetic-org-a/old-evidence/pull/1", revision: "a".repeat(40), excerpt: "Synthetic historical evidence." });
  for (const [expectedRevision, sourceId] of [[1, oldSource.id], [2, w.sources.alpha.id]] as const) {
    const p = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: memory.id, expectedRevision,
      kind: "revise", type: "decision", title: `Policy revision ${expectedRevision + 1}`, content: `Synthetic policy revision ${expectedRevision + 1}.`, evidenceSourceIds: [sourceId] });
    await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: p.id, expectedRevision: 1 });
    if (expectedRevision === 1) await createWork(env.ctx, w.people.contributor.id, { ...input, title: "Historical sensitive task title", decisions: [{ memoryId: memory.id, revision: 2 }] });
  }
  const before = await listWork(env.ctx, w.people.reader.id, w.alpha.id);
  assert.equal(before.length, 1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reader.id, provider: "github", externalRepositoryId: "1009", canRead: false });
  assert.deepEqual(await listWork(env.ctx, w.people.reader.id, w.alpha.id), []);
  await assert.rejects(exportWork(env.ctx, w.people.reader.id, before[0]!.work.id), NotFoundError);
});
