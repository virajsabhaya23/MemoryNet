import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  ForbiddenError,
  formatCheckpoint,
  getContext,
  ledgerCheckpoints,
  migrate,
  openDatabase,
  parseCheckpoint,
  SYSTEM_CHAIN_ID,
  ValidationError,
  verifyLedger,
  verifyOrganizationLedger,
} from "../src/index.ts";
import { buildWorld, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();

async function chainOf(organizationId: string) {
  const report = await verifyLedger(env.db, { chainIds: [organizationId] });
  const chain = report.chains[0];
  assert.ok(chain, "organization chain exists");
  return { report, chain };
}

test("every audit event and retrieval receipt is chained per organization and verifies", async () => {
  const w = await buildWorld(env.ctx);
  const search = await getContext(env.ctx, w.people.reader.id, { projectId: w.alpha.id, query: "queue retries" });
  const report = await verifyLedger(env.db);
  assert.equal(report.ok, true, JSON.stringify(report));
  const audits = (await env.db.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_events")).rows[0]!.count;
  const chained = (await env.db.query<{ count: number }>("SELECT count(*)::int AS count FROM ledger_entries")).rows[0]!.count;
  assert.equal(chained, audits + 1, "one entry per audit event plus the receipt");
  const receipt = await env.db.query<{ chain_id: string }>("SELECT chain_id FROM ledger_entries WHERE entry_type='retrieval' AND entry_ref=$1", [search.retrievalId]);
  assert.equal(receipt.rows[0]?.chain_id, w.orgA.id);
  const chainIds = report.chains.map((chain) => chain.chainId);
  assert.ok(chainIds.includes(w.orgA.id) && chainIds.includes(w.orgB.id));
  assert.ok(chainIds.includes(SYSTEM_CHAIN_ID), "principal creation sits outside any organization");
  const heads = await ledgerCheckpoints(env.db, [w.orgA.id]);
  const text = formatCheckpoint(heads[0]!);
  assert.deepEqual(parseCheckpoint(text), heads[0]);
  assert.throws(() => parseCheckpoint("mnl1.not-a-chain.1.abc"), ValidationError);
});

test("edits, deletions and unchained inserts made around the triggers are detected", async () => {
  const w = await buildWorld(env.ctx);
  const search = await getContext(env.ctx, w.people.reader.id, { projectId: w.alpha.id, query: "queue retries" });
  assert.equal(search.outcome, "results");
  await env.db.exec("ALTER TABLE audit_events DISABLE TRIGGER USER; ALTER TABLE retrieval_items DISABLE TRIGGER USER");
  try {
    await env.db.query("UPDATE retrieval_items SET status_generation=status_generation+1 WHERE retrieval_id=$1", [search.retrievalId]);
    const { chain: changed } = await chainOf(w.orgA.id);
    assert.ok(changed.problems.some(p => p.includes(`retrieval ${search.retrievalId}`) && p.includes("was changed")));
    const target = (await env.db.query<{ id: string }>("SELECT id::text FROM audit_events WHERE organization_id=$1 ORDER BY id LIMIT 1", [w.orgA.id])).rows[0]!.id;
    await env.db.query("UPDATE audit_events SET reason='rewritten history' WHERE id=$1", [target]);
    await env.db.query("DELETE FROM retrieval_items WHERE retrieval_id=$1", [search.retrievalId]);
    await env.db.query(`INSERT INTO audit_events (occurred_at, actor_id, action, organization_id, target_type, target_id)
      VALUES (now(), $1, 'memory.approved', $2, 'memory', 'forged')`, [w.people.ownerA.id, w.orgA.id]);
    const { report, chain } = await chainOf(w.orgA.id);
    assert.equal(report.ok, false);
    assert.ok(chain.problems.some((p) => p.includes(`audit_event ${target}`) && p.includes("was changed")), chain.problems.join("\n"));
    assert.ok(chain.problems.some((p) => p.includes(`retrieval ${search.retrievalId}`) && p.includes("was changed")));
    assert.ok(report.problems.some((p) => p.includes("recorded without a ledger entry")));
    assert.equal((await chainOf(w.orgB.id)).chain.ok, true, "other organizations are unaffected");
  } finally {
    await env.db.exec("ALTER TABLE audit_events ENABLE TRIGGER USER; ALTER TABLE retrieval_items ENABLE TRIGGER USER");
  }
});

test("a fully rewritten chain verifies on its own but contradicts an earlier checkpoint", async () => {
  const w = await buildWorld(env.ctx);
  const [before] = await ledgerCheckpoints(env.db, [w.orgA.id]);
  assert.ok(before && before.seq > 2);
  const earlier = { chainId: w.orgA.id, seq: 2, hash: (await env.db.query<{ entry_hash: string }>(
    "SELECT entry_hash FROM ledger_entries WHERE chain_id=$1 AND seq=2", [w.orgA.id])).rows[0]!.entry_hash };
  // An attacker with database ownership removes one event and rebuilds every hash after it.
  await env.db.exec("ALTER TABLE audit_events DISABLE TRIGGER USER; ALTER TABLE ledger_entries DISABLE TRIGGER USER; ALTER TABLE ledger_heads DISABLE TRIGGER USER");
  try {
    const removed = (await env.db.query<{ entry_ref: string }>("SELECT entry_ref FROM ledger_entries WHERE chain_id=$1 AND seq=1", [w.orgA.id])).rows[0]!.entry_ref;
    await env.db.query("DELETE FROM audit_events WHERE id=$1::bigint", [removed]);
    const kept = (await env.db.query<{ entry_type: string; entry_ref: string; payload_hash: string }>(
      "SELECT entry_type, entry_ref, payload_hash FROM ledger_entries WHERE chain_id=$1 AND seq>1 ORDER BY seq", [w.orgA.id])).rows;
    await env.db.query("DELETE FROM ledger_entries WHERE chain_id=$1", [w.orgA.id]);
    await env.db.query("UPDATE ledger_heads SET seq=0, head_hash=$2 WHERE chain_id=$1", [w.orgA.id, "0".repeat(64)]);
    await env.db.exec("ALTER TABLE ledger_entries ENABLE TRIGGER USER; ALTER TABLE ledger_heads ENABLE TRIGGER USER");
    for (const entry of kept) {
      await env.db.query("SELECT ledger_append($1::uuid, $2::text, $3::text, payload) FROM (SELECT CASE WHEN $2::text='audit_event' THEN (SELECT ledger_audit_payload(e) FROM audit_events e WHERE e.id=$3::text::bigint) ELSE ledger_retrieval_payload($3::text::uuid) END AS payload) p",
        [w.orgA.id, entry.entry_type, entry.entry_ref]);
    }
    assert.equal((await chainOf(w.orgA.id)).chain.ok, true, "self-consistent after the rewrite");
    const report = await verifyLedger(env.db, { chainIds: [w.orgA.id], checkpoints: [earlier] });
    assert.equal(report.ok, false);
    assert.ok(report.chains[0]!.problems.some((p) => p.includes("differs from the recorded checkpoint")));
  } finally {
    await env.db.exec("ALTER TABLE audit_events ENABLE TRIGGER USER; ALTER TABLE ledger_entries ENABLE TRIGGER USER; ALTER TABLE ledger_heads ENABLE TRIGGER USER");
  }
});

test("ledger rows are append-only and receipts are sealed at commit", async () => {
  const w = await buildWorld(env.ctx);
  await assert.rejects(env.db.query("UPDATE ledger_entries SET entry_hash=$1", ["f".repeat(64)]), /append-only/);
  await assert.rejects(env.db.query("DELETE FROM ledger_entries"), /append-only/);
  await assert.rejects(env.db.query("UPDATE ledger_heads SET seq=seq+5"), /only advance/);
  await assert.rejects(env.db.query("INSERT INTO ledger_entries (chain_id, seq, entry_type, entry_ref, payload_hash, prev_hash, entry_hash) VALUES ($1, 999, 'audit_event', '0', $2, $2, $2)",
    [w.orgA.id, "a".repeat(64)]), /must extend their chain/);
  const search = await getContext(env.ctx, w.people.reader.id, { projectId: w.alpha.id, query: "queue retries" });
  await assert.rejects(env.db.query("INSERT INTO retrieval_items (retrieval_id, position, memory_id, revision, status) VALUES ($1, 9, $2, 1, 'approved')",
    [search.retrievalId, w.memories.alphaApproved.id]), /sealed/);
  assert.equal((await verifyLedger(env.db)).ok, true);
});

test("organization administrators verify only their own chain; readers and outsiders cannot", async () => {
  const w = await buildWorld(env.ctx);
  const report = await verifyOrganizationLedger(env.ctx, w.people.adminA.id, { organizationId: w.orgA.id });
  assert.equal(report.ok, true);
  assert.deepEqual(report.chains.map((c) => c.chainId), [w.orgA.id]);
  const [head] = await ledgerCheckpoints(env.db, [w.orgA.id]);
  const withCheckpoint = await verifyOrganizationLedger(env.ctx, w.people.ownerA.id, { organizationId: w.orgA.id, checkpoint: formatCheckpoint(head!) });
  assert.equal(withCheckpoint.ok, true);
  const [other] = await ledgerCheckpoints(env.db, [w.orgB.id]);
  await assert.rejects(verifyOrganizationLedger(env.ctx, w.people.ownerA.id, { organizationId: w.orgA.id, checkpoint: formatCheckpoint(other!) }), ValidationError);
  await assert.rejects(verifyOrganizationLedger(env.ctx, w.people.orgReader.id, { organizationId: w.orgA.id }), ForbiddenError);
  await assert.rejects(verifyOrganizationLedger(env.ctx, w.people.ownerB.id, { organizationId: w.orgA.id }));
});

test("012 chains records that existed before the upgrade, oldest first", async () => {
  const db = await openDatabase();
  const migrations = new URL("../migrations/", import.meta.url);
  try {
    await db.exec("CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of (await readdir(migrations)).filter((file) => /^0(0[1-9]|1[01])_.*\.sql$/.test(file)).sort()) {
      await db.transaction(async (tx) => {
        await tx.exec(await readFile(new URL(name, migrations), "utf8"));
        await tx.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      });
    }
    const person = randomUUID(), org = randomUUID(), unit = randomUUID(), projectId = randomUUID(), retrieval = randomUUID();
    const at = new Date("2026-10-01T12:00:00.000Z");
    await db.query("INSERT INTO principals(id,kind,display_name,created_at) VALUES($1,'human','Upgrade owner',$2)", [person, at]);
    await db.query("INSERT INTO organizations(id,slug,name,created_by,created_at) VALUES($1,'upgrade','Upgrade',$2,$3)", [org, person, at]);
    await db.query("INSERT INTO business_units(id,organization_id,slug,name,created_by,created_at) VALUES($1,$2,'unit','Unit',$3,$4)", [unit, org, person, at]);
    await db.query("INSERT INTO projects(id,organization_id,business_unit_id,slug,name,created_by,created_at) VALUES($1,$2,$3,'p','P',$4,$5)", [projectId, org, unit, person, at]);
    await db.query("INSERT INTO audit_events(occurred_at,actor_id,action,organization_id,target_type,target_id) VALUES($1,$2,'organization.created',$3,'organization',$4)", [at, person, org, org]);
    await db.query("INSERT INTO retrievals(id,project_id,caller_id,search_terms,outcome,retrieved_at) VALUES($1,$2,$3,'cach','no_results',$4)", [retrieval, projectId, person, new Date(at.getTime() + 1000)]);
    await db.query("INSERT INTO audit_events(occurred_at,actor_id,action,project_id,target_type,target_id) VALUES($1,$2,'work.created',$3,'work','w')", [new Date(at.getTime() + 2000), person, projectId]);
    assert.ok((await migrate(db)).includes("012_ledger.sql"));
    const entries = await db.query<{ seq: string; entry_type: string }>("SELECT seq::text, entry_type FROM ledger_entries WHERE chain_id=$1 ORDER BY seq", [org]);
    assert.deepEqual(entries.rows.map((row) => row.entry_type), ["audit_event", "retrieval", "audit_event"]);
    const report = await verifyLedger(db);
    assert.equal(report.ok, true, JSON.stringify(report));
  } finally {
    await db.close();
  }
});
