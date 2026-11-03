// Independent QE regressions. Synthetic in-memory data; no live app, binding file or Meta calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAgentContext } from "../src/agent-context/service.ts";
import type { AgentBinding } from "../src/agent-context/binding.ts";
import { approveProposal, getContext, listRetrievals, NotFoundError, proposeMemory, recordRepositoryAccess, revokeMemory } from "../src/index.ts";
import { buildWorld, START, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();
type World = Awaited<ReturnType<typeof buildWorld>>;
function binding(w: World): AgentBinding {
  return { schemaVersion: 1, token: "a".repeat(64), principalId: w.people.agent.id,
    projectId: w.alpha.id, repositoryId: "1001", branch: "main",
    expiresAt: new Date(START.getTime() + 86_400_000).toISOString() };
}
async function approved(w: World, title: string) {
  const proposal = await proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id, type: "decision", title, content: `Controlled queue retries guidance: ${title}.`,
    evidenceSourceIds: [w.sources.alpha.id],
    applicability: { repositoryId: "1001", branch: "main", validFrom: START, validUntil: null },
  });
  return approveProposal(env.ctx, w.people.reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
}

test("agent no-results receipt does not claim a revoked match was delivered", async () => {
  const w = await buildWorld(env.ctx);
  const retired = await approved(w, "Controlled retired queue retries");
  await revokeMemory(env.ctx, w.people.reviewer.id, { memoryId: retired.id, expectedRevision: 1, reason: "Controlled revoked authority" });
  const response = await getAgentContext(env.ctx, binding(w), { query: "queue retries" });
  assert.equal(response.outcome, "no_results");
  assert.deepEqual(response.current, []);
  assert.equal(JSON.stringify(response).includes(retired.id), false);
  const items = await env.db.query("SELECT memory_id,status FROM retrieval_items WHERE retrieval_id=$1", [response.retrievalId]);
  assert.deepEqual(items.rows, [], "receipt records actual agent delivery, not considered retired metadata");
});

test("agent results receipt contains only actual current delivery while ordinary UI context retains retired warnings", async () => {
  const w = await buildWorld(env.ctx);
  const retired = await approved(w, "Controlled retired queue retries");
  const current = await approved(w, "Controlled current queue retries");
  await revokeMemory(env.ctx, w.people.reviewer.id, { memoryId: retired.id, expectedRevision: 1, reason: "Controlled revoked authority" });
  const response = await getAgentContext(env.ctx, binding(w), { query: "queue retries", limit: 1 });
  assert.deepEqual(response.current.map((memory) => memory.memoryId), [current.id]);
  const items = await env.db.query<{ memory_id: string; status: string }>("SELECT memory_id,status FROM retrieval_items WHERE retrieval_id=$1 ORDER BY position", [response.retrievalId]);
  assert.deepEqual(items.rows, [{ memory_id: current.id, status: "approved" }]);
  const humanView = await getContext(env.ctx, w.people.reviewer.id, {
    projectId: w.alpha.id, query: "queue retries", applicability: { repositoryId: "1001", branch: "main" },
  });
  assert.equal(humanView.notCurrent.some((memory) => memory.memoryId === retired.id), true,
    "current-only agent mode must not erase explicit historical warnings from ordinary UI retrieval");
});

test("losing source access denies another agent call and removes prior receipt item details", async () => {
  const w = await buildWorld(env.ctx);
  const memory = await approved(w, "Controlled private queue retries");
  const response = await getAgentContext(env.ctx, binding(w), { query: "queue retries" });
  assert.deepEqual(response.current.map((item) => item.memoryId), [memory.id]);
  env.advance(1);
  await recordRepositoryAccess(env.ctx, { principalId: w.people.agent.id, provider: "github", externalRepositoryId: "1001", canRead: false });
  await assert.rejects(getAgentContext(env.ctx, binding(w), { query: "queue retries" }), NotFoundError);
  const records = await listRetrievals(env.ctx, w.people.agent.id, { projectId: w.alpha.id });
  const prior = records.find((item) => item.id === response.retrievalId);
  // Withdrawing scope access may hide the entire receipt; if retained, its
  // historical item details must still be removed under current permissions.
  if (prior) assert.deepEqual(prior.items, []);
  assert.equal(JSON.stringify(records).includes(memory.title), false);
  const count = await env.db.query<{ count: number }>("SELECT count(*)::int AS count FROM retrievals WHERE caller_id=$1", [w.people.agent.id]);
  assert.equal(count.rows[0]?.count, 1, "denied scope calls must not claim a successful new retrieval");
});
