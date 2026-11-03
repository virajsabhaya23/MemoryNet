import assert from "node:assert/strict";
import { test } from "node:test";
import { extractForReview } from "../src/decision-guard/review.ts";
import type { DecisionGuardProvider } from "../src/decision-guard/model.ts";
import { ConflictError, NotFoundError, ValidationError, approveProposal, proposeChange, recordRepositoryAccess, revokeRole, suspendMemory } from "../src/index.ts";
import { buildWorld, project, useTestDatabase } from "./helpers.ts";
import type { Database, Queryable } from "../src/db.ts";

const env = useTestDatabase();

function provider(beforeReturn?: () => Promise<void>) {
  const state = { calls: 0 };
  const model: DecisionGuardProvider = { async complete(messages) {
    state.calls += 1;
    const snapshot = JSON.parse(messages[1]!.content);
    const source = snapshot.sources[0];
    await beforeReturn?.();
    return { provider: "controlled-test-double", model: "controlled", usage: null,
      text: JSON.stringify({ candidates: [{ title: "Controlled candidate", decision: "Review this controlled engineering evidence.",
        evidence: [{ sourceId: source.sourceId, start: 0, end: source.text.length, quote: source.text }], possibleConflicts: [],
      }] }),
    };
  } };
  return { state, model };
}

async function rowCounts() {
  return (await env.db.query<{ sources: string; proposals: string; memories: string; audits: string; retrievals: string }>(
    `SELECT (SELECT count(*) FROM sources)::text sources,
            (SELECT count(*) FROM memory_proposals)::text proposals,
            (SELECT count(*) FROM memories)::text memories,
            (SELECT count(*) FROM audit_events)::text audits,
            (SELECT count(*) FROM retrievals)::text retrievals`,
  )).rows[0];
}

test("authorized extraction returns exact stored evidence and unreviewed candidates without database writes", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider();
  const before = await rowCounts();
  const result = await extractForReview(env.ctx, w.people.agent.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id], decisionIds: [w.memories.alphaApproved.id],
  });
  assert.equal(result.reviewState, "unreviewed");
  assert.equal(result.projectId, w.alpha.id);
  assert.equal(result.sourceSnapshots[0]?.text, w.sources.alpha.excerpt);
  assert.equal(result.sourceSnapshots[0]?.revision, w.sources.alpha.revision);
  assert.equal(result.candidates[0]?.evidence[0]?.quote, w.sources.alpha.excerpt);
  assert.equal(p.state.calls, 1);
  assert.deepEqual(await rowCounts(), before);
});

test("reader, outsider and unknown caller never invoke the provider", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider();
  for (const caller of [w.people.reader.id, w.people.outsider.id, "00000000-0000-0000-0000-000000000001"]) {
    await assert.rejects(extractForReview(env.ctx, caller, p.model, { projectId: w.alpha.id, sourceIds: [w.sources.alpha.id] }));
  }
  assert.equal(p.state.calls, 0);
});

test("foreign-project or inaccessible sources and decisions are refused before disclosure", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider();
  for (const source of [w.sources.beta.id, w.sources.delta.id]) {
    await assert.rejects(extractForReview(env.ctx, w.people.ownerA.id, p.model, { projectId: w.alpha.id, sourceIds: [source] }), NotFoundError);
  }
  await assert.rejects(extractForReview(env.ctx, w.people.ownerA.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id], decisionIds: [w.memories.betaApproved.id],
  }), NotFoundError);
  assert.equal(p.state.calls, 0);
});

test("unpinned evidence, duplicates and pending decision IDs never reach provider", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider();
  await assert.rejects(extractForReview(env.ctx, w.people.contributor.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id, w.sources.alpha.id],
  }), ValidationError);
  await assert.rejects(extractForReview(env.ctx, w.people.contributor.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id], decisionIds: [w.proposals.alphaPending.id],
  }), NotFoundError);
  await env.db.query("UPDATE sources SET revision = NULL WHERE id = $1", [w.sources.alpha.id]);
  await assert.rejects(extractForReview(env.ctx, w.people.contributor.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id],
  }), /revision-pinned/);
  assert.equal(p.state.calls, 0);
});

test("stored likely secrets are rejected before provider disclosure", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider();
  await env.db.query("UPDATE sources SET excerpt = $1 WHERE id = $2", ["Controlled fixture api_key=testing123456value", w.sources.alpha.id]);
  await assert.rejects(extractForReview(env.ctx, w.people.contributor.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id],
  }), ValidationError);
  assert.equal(p.state.calls, 0);
});

test("repository permission revocation during inference withholds the entire result", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider(async () => {
    env.advance(1);
    await recordRepositoryAccess(env.ctx, { principalId: w.people.contributor.id, provider: "github", externalRepositoryId: "1001", canRead: false });
  });
  await assert.rejects(extractForReview(env.ctx, w.people.contributor.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id],
  }), NotFoundError);
  assert.equal(p.state.calls, 1);
});

test("role removal during inference withholds the entire result", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider(async () => revokeRole(env.ctx, w.people.adminA.id, {
    principalId: w.people.contributor.id, scope: project(w.alpha.id), reason: "Controlled revocation during inference",
  }));
  await assert.rejects(extractForReview(env.ctx, w.people.contributor.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id],
  }), NotFoundError);
});

test("decision status changes during inference invalidate comparison", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider(async () => { await suspendMemory(env.ctx, w.people.contributor.id, {
    memoryId: w.memories.alphaApproved.id, expectedRevision: 1, reason: "Controlled conflicting evidence",
  }); });
  await assert.rejects(extractForReview(env.ctx, w.people.contributor.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id], decisionIds: [w.memories.alphaApproved.id],
  }), ConflictError);
});

test("source changes during inference invalidate exact evidence snapshot", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider(async () => { await env.db.query("UPDATE sources SET excerpt = $1 WHERE id = $2", ["Controlled changed evidence", w.sources.alpha.id]); });
  await assert.rejects(extractForReview(env.ctx, w.people.contributor.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id],
  }), ConflictError);
});

test("repository access expiring during inference withholds source and generated text", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider(async () => { env.advance(15 * 60 * 1000 + 1); });
  await assert.rejects(extractForReview(env.ctx, w.people.contributor.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id],
  }), NotFoundError);
});

test("a newly approved decision revision during inference invalidates conflict references", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider(async () => {
    const change = await proposeChange(env.ctx, w.people.contributor.id, {
      memoryId: w.memories.alphaApproved.id, expectedRevision: 1, kind: "revise", type: "decision",
      title: "Controlled revised decision", content: "Controlled new guidance for the engineering decision.", evidenceSourceIds: [w.sources.alpha.id],
    });
    await approveProposal(env.ctx, w.people.reviewer.id, { proposalId: change.id, expectedRevision: change.revision });
  });
  await assert.rejects(extractForReview(env.ctx, w.people.contributor.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id], decisionIds: [w.memories.alphaApproved.id],
  }), ConflictError);
});

test("repository access lost before final admission prevents provider disclosure", async () => {
  const w = await buildWorld(env.ctx);
  const p = provider();
  const original = env.ctx;
  let revoked = false;
  let inTransaction = false;
  const db: Database = {
    query: (sql, params) => original.db.query(sql, params),
    exec: (sql) => original.db.exec(sql),
    close: () => original.db.close(),
    transaction: (fn) => original.db.transaction(async (tx) => {
      assert.equal(inTransaction, false, "admission must not open nested transactions");
      inTransaction = true;
      const queryable: Queryable = {
        exec: (sql) => tx.exec(sql),
        async query<T>(sql: string, params?: unknown[]) {
          if (!revoked && sql.includes("SELECT rank FROM effective_project_roles")) {
            revoked = true;
            // Controlled race probe: revoke after initial reads but before the
            // admission snapshot checks evidence access. No network or nested DB.
            await tx.query("UPDATE repository_access SET can_read = false WHERE principal_id = $1 AND external_repository_id = '1001'", [w.people.contributor.id]);
          }
          return tx.query<T>(sql, params);
        },
      };
      try { return await fn(queryable); }
      finally { inTransaction = false; }
    }),
  };
  await assert.rejects(extractForReview({ ...original, db }, w.people.contributor.id, p.model, {
    projectId: w.alpha.id, sourceIds: [w.sources.alpha.id], decisionIds: [w.memories.alphaApproved.id],
  }), NotFoundError);
  assert.equal(revoked, true);
  assert.equal(p.state.calls, 0, "revoked source content must never reach the provider");
});

test("admission transaction closes before provider dispatch", async () => {
  const w = await buildWorld(env.ctx);
  const original = env.ctx;
  let inTransaction = false;
  let transactions = 0;
  const db: Database = {
    query: (sql, params) => original.db.query(sql, params), exec: (sql) => original.db.exec(sql), close: () => original.db.close(),
    transaction: (fn) => original.db.transaction(async (tx) => {
      transactions += 1;
      inTransaction = true;
      try { return await fn(tx); } finally { inTransaction = false; }
    }),
  };
  const p = provider(async () => { assert.equal(inTransaction, false, "no DB transaction may be held over provider latency"); });
  await extractForReview({ ...original, db }, w.people.contributor.id, p.model, { projectId: w.alpha.id, sourceIds: [w.sources.alpha.id] });
  assert.equal(transactions, 2, "admission and response snapshots are independent transactions");
});
