import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveProposal,
  ConflictError,
  editProposal,
  getMemory,
  getProposal,
  getProposalHistory,
  listMemories,
  proposeChange,
  proposeMemory,
  proposeRestore,
  recordRepositoryAccess,
  recordSource,
  ValidationError,
} from "../src/index.ts";
import { normalizeRelations, pathMatches, pathSpecificity } from "../src/relations.ts";
import { buildWorld, useTestDatabase, type World } from "./helpers.ts";

const env = useTestDatabase();

async function approved(w: World, title: string, relations?: Parameters<typeof proposeMemory>[2]["relations"], sourceId = w.sources.alpha.id) {
  const proposal = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, type: "decision", title,
    content: `Synthetic body for ${title}.`, evidenceSourceIds: [sourceId], ...(relations === undefined ? {} : { relations }) });
  return approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
}

test("path globs match folders, files and names; plain paths cover what is below them", () => {
  assert.equal(pathMatches("src/api/**", "src/api/client.ts"), true);
  assert.equal(pathMatches("src/api/**", "src/api/v2/retry.ts"), true);
  assert.equal(pathMatches("src/api/**", "src/apiary/x.ts"), false);
  assert.equal(pathMatches("src/**/retry.ts", "src/retry.ts"), true);
  assert.equal(pathMatches("src/*.ts", "src/a/b.ts"), false);
  assert.equal(pathMatches("src/api", "src/api/client.ts"), true);
  assert.equal(pathMatches("src/api", "src/api"), true);
  assert.equal(pathMatches("src/api", "src/apiary"), false);
  assert.equal(pathMatches("docs/v?.md", "docs/v2.md"), true);
  assert.equal(pathMatches("a+b.c", "a+b.c"), true, "regex characters are literal");
  assert.equal(pathMatches("a+b.c", "aab-c"), false);
  assert.ok(pathSpecificity("src/api/client.ts") > pathSpecificity("src/**"));
  for (const bad of ["/etc/passwd", "../x", "src/../x", "src//x", "src\\x", "x;rm", "a".repeat(201)]) {
    assert.throws(() => normalizeRelations({ paths: [bad] }), ValidationError, bad);
  }
  assert.deepEqual(normalizeRelations({ paths: ["b/**", "a", "b/**"] }).paths, ["a", "b/**"]);
  assert.throws(() => normalizeRelations({ links: [{ relation: "owns", memoryId: "00000000-0000-0000-0000-000000000001" }] }), ValidationError);
});

test("pattern matching stays fast on adversarial globs, and patterns are limited to a few wildcards", () => {
  const evil = `src/${"**a".repeat(16)}/x.ts`;
  assert.throws(() => normalizeRelations({ paths: [evil] }), /at most 8 wildcard/);
  const started = performance.now();
  for (const path of [`src/${"a".repeat(60)}/y.ts`, `src/${"a".repeat(64)}`, `${"a/".repeat(90)}x.ts`]) {
    assert.equal(pathMatches(evil, path), false);
    assert.equal(pathMatches("**/**/**/**/x.ts", path), path.endsWith("/x.ts"));
    assert.equal(pathMatches("*a*a*a*a*b", "a".repeat(190)), false);
  }
  assert.ok(performance.now() - started < 250, "matching is not exponential");
  assert.equal(pathMatches("src/**a/x.ts", "src/bba/x.ts"), true, "stars inside one name stay within that name");
  assert.equal(pathMatches("src/**", "src"), true);
});

test("reviewed relations are proposed, approved with the exact version and published", async () => {
  const w = await buildWorld(env.ctx);
  const base = w.memories.alphaApproved;
  const proposal = await proposeMemory(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, type: "constraint",
    title: "Retry budget for the queue client", content: "Synthetic: cap retries at three.", evidenceSourceIds: [w.sources.alpha.id],
    relations: { paths: ["src/queue/**", "src/queue/client.ts"], links: [{ relation: "refines", memoryId: base.id }] } });
  assert.deepEqual(proposal.relations, { paths: ["src/queue/**", "src/queue/client.ts"], links: [{ relation: "refines", memoryId: base.id }] });
  const memory = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: 1 });
  assert.deepEqual(memory.relations, proposal.relations);
  assert.deepEqual((await getMemory(env.ctx, w.people.reader.id, memory.id)).relations, proposal.relations);
  const revised = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: memory.id, expectedRevision: 1, kind: "revise", type: "constraint",
    title: memory.title, content: "Synthetic: cap retries at two.", evidenceSourceIds: [w.sources.alpha.id] });
  assert.deepEqual(revised.relations, memory.relations, "a change keeps reviewed relations unless it says otherwise");
  const narrowed = await editProposal(env.ctx, w.people.contributor.id, { proposalId: revised.id, expectedRevision: 1, type: "constraint",
    title: memory.title, content: "Synthetic: cap retries at two.", evidenceSourceIds: [w.sources.alpha.id], ownerId: w.people.contributor.id,
    relations: { paths: ["src/queue/client.ts"], links: [] } });
  assert.equal(narrowed.revision, 2);
  const history = await getProposalHistory(env.ctx, w.people.contributor.id, revised.id);
  assert.deepEqual(history.map((v) => v.relations.paths), [["src/queue/**", "src/queue/client.ts"], ["src/queue/client.ts"]]);
  await assert.rejects(editProposal(env.ctx, w.people.contributor.id, { proposalId: revised.id, expectedRevision: 2, type: "constraint",
    title: memory.title, content: "Synthetic: cap retries at two.", evidenceSourceIds: [w.sources.alpha.id], ownerId: w.people.contributor.id,
    relations: { paths: ["src/queue/client.ts"] } }), /Nothing changed/);
  const second = await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: revised.id, expectedRevision: 2 });
  assert.deepEqual(second.relations, { paths: ["src/queue/client.ts"], links: [] });
  const restore = await proposeRestore(env.ctx, w.people.contributor.id, { memoryId: memory.id, expectedRevision: 2, fromRevision: 1 });
  assert.deepEqual(restore.relations, proposal.relations, "restoring brings back that version's relations");
});

test("links must name readable current memories in the same project, never itself", async () => {
  const w = await buildWorld(env.ctx);
  const propose = (links: Array<{ relation: string; memoryId: string }>, projectId = w.alpha.id, sourceId = w.sources.alpha.id) =>
    proposeMemory(env.ctx, w.people.contributor.id, { projectId, type: "decision", title: `Linked ${Math.random()}`, content: "Synthetic.",
      evidenceSourceIds: [sourceId], relations: { links } });
  await assert.rejects(propose([{ relation: "depends_on", memoryId: w.memories.betaApproved.id }]), /one you can read in this project/);
  await assert.rejects(propose([{ relation: "depends_on", memoryId: w.memories.deltaApproved.id }]), /one you can read in this project/);
  await assert.rejects(propose([{ relation: "depends_on", memoryId: "00000000-0000-4000-8000-000000000000" }]), /one you can read in this project/);
  const target = await approved(w, "Queue retries stay at most three");
  await assert.rejects(proposeChange(env.ctx, w.people.contributor.id, { memoryId: target.id, expectedRevision: 1, kind: "revise", type: "decision",
    title: target.title, content: "Synthetic loop.", evidenceSourceIds: [w.sources.alpha.id], relations: { links: [{ relation: "related", memoryId: target.id }] } }), /cannot link to itself/);
  const replacement = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: target.id, expectedRevision: 1, kind: "replace", type: "decision",
    title: "Queue retries stay at most two", content: "Synthetic replacement.", evidenceSourceIds: [w.sources.alpha.id] });
  await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: replacement.id, expectedRevision: 1 });
  await assert.rejects(propose([{ relation: "depends_on", memoryId: target.id }]), /New links must point to current memories/);
  await assert.rejects(env.db.query(`UPDATE memory_revisions SET relations = '{"paths":["src/x"],"links":[]}' WHERE memory_id = $1`, [target.id]), /immutable/);
});

test("links to memories a reader cannot see are hidden from them, kept on edit, and block reviewers who cannot see them", async () => {
  const w = await buildWorld(env.ctx);
  // A second repository in alpha that only some people can read.
  const { connectRepository } = await import("../src/index.ts");
  await connectRepository(env.ctx, w.people.adminA.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1009", fullName: "synthetic-org-a/alpha-private" });
  for (const who of [w.people.contributor, w.people.reviewer, w.people.adminA]) {
    await recordRepositoryAccess(env.ctx, { principalId: who.id, provider: "github", externalRepositoryId: "1009", canRead: true });
  }
  const privateSource = await recordSource(env.ctx, w.people.contributor.id, { projectId: w.alpha.id, provider: "github", externalRepositoryId: "1009",
    reference: "pull/7", url: "https://github.com/synthetic-org-a/alpha-private/pull/7", excerpt: "Synthetic private discussion." });
  const hidden = await approved(w, "Private signing constraint", undefined, privateSource.id);
  const linking = await approved(w, "Public client depends on signing", { paths: ["src/client/**"], links: [{ relation: "depends_on", memoryId: hidden.id }] });
  assert.equal((await getMemory(env.ctx, w.people.contributor.id, linking.id)).relations.links.length, 1);
  const readerView = await getMemory(env.ctx, w.people.reader.id, linking.id);
  assert.deepEqual(readerView.relations, { paths: ["src/client/**"], links: [] }, "the hidden memory's ID never reaches the reader");
  assert.equal((await listMemories(env.ctx, w.people.reader.id, { scope: { level: "project", id: w.alpha.id } })).every((m) => !JSON.stringify(m).includes(hidden.id)), true);

  // A reviewer who cannot read the linked memory cannot approve a proposal carrying that link.
  const change = await proposeChange(env.ctx, w.people.contributor.id, { memoryId: linking.id, expectedRevision: 1, kind: "revise", type: "decision",
    title: linking.title, content: "Synthetic revised.", evidenceSourceIds: [w.sources.alpha.id] });
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.reviewer.id, provider: "github", externalRepositoryId: "1009", canRead: false });
  await assert.rejects(approveProposal(env.ctx, w.people.reviewer.id, { proposalId: change.id, expectedRevision: 1 }), ConflictError);
  const asReviewer = await getProposal(env.ctx, w.people.reviewer.id, change.id);
  assert.deepEqual(asReviewer.relations.links, []);
  // Editing as that reviewer keeps the hidden link instead of silently dropping it.
  const edited = await editProposal(env.ctx, w.people.reviewer.id, { proposalId: change.id, expectedRevision: 1, type: "decision", title: linking.title,
    content: "Synthetic revised again.", evidenceSourceIds: [w.sources.alpha.id], ownerId: w.people.contributor.id, relations: { paths: ["src/client/**"], links: [] } });
  assert.equal(edited.revision, 2);
  assert.equal((await getProposal(env.ctx, w.people.adminA.id, change.id)).relations.links[0]?.memoryId, hidden.id);
  const published = await approveProposal(env.ctx, w.people.adminA.id, { proposalId: change.id, expectedRevision: 2 });
  assert.equal(published.relations.links[0]?.memoryId, hidden.id);
});
