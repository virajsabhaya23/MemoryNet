import assert from "node:assert/strict";
import { test } from "node:test";
import { approveProposal, exportKnowledge, revokeMemory } from "../src/index.ts";
import { createSyntheticEvaluationFixture } from "../src/evaluation/fixture.ts";

test("portable export v3 retains exact reviewed scope and excludes revoked authority", async () => {
  const w = await createSyntheticEvaluationFixture();
  try {
    const proposal = await w.propose("Synthetic scoped export", "Synthetic transport export evidence.");
    const memory = await approveProposal(w.ctx, w.reviewer.id, { proposalId: proposal.id, expectedRevision: proposal.revision });
    const result = await exportKnowledge(w.ctx, w.owner.id, { scope: { level: "project", id: w.project.id } });
    assert.equal(result.formatVersion, 3);
    assert.deepEqual(result.memories[0]?.applicability, JSON.parse(JSON.stringify(memory.applicability)));
    assert.equal(result.memories[0]?.statusGeneration, memory.statusGeneration);
    await revokeMemory(w.ctx, w.reviewer.id, { memoryId: memory.id, expectedRevision: memory.revision, reason: "Synthetic export exclusion" });
    assert.deepEqual((await exportKnowledge(w.ctx, w.owner.id, { scope: { level: "project", id: w.project.id } })).memories, []);
  } finally { await w.close(); }
});
