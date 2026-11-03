import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { approveProposal, createContext, getMemory, getProposal, migrate, openDatabase, ConflictError } from "../src/index.ts";
import { getGuardRun } from "../src/decision-guard/workflow.ts";

const migrations = new URL("../migrations/", import.meta.url);

test("008 populated immutable model drafts upgrade without changing evidence; old targeted drafts fail closed", async () => {
  const db = await openDatabase();
  const at = new Date("2026-09-24T09:00:00.000Z");
  const human = randomUUID(), agent = randomUUID(), org = randomUUID(), unit = randomUUID(), project = randomUUID(), source = randomUUID();
  const oldProposal = randomUUID(), oldMemory = randomUUID();
  const pendingNew = randomUUID(), pendingReplace = randomUUID(), newRun = randomUUID(), replaceRun = randomUUID();
  try {
    await db.exec("CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const oldFiles = (await readdir(migrations)).filter((name) => /^00[1-8]_.*\.sql$/.test(name)).sort();
    for (const name of oldFiles) await db.transaction(async (tx) => {
      await tx.exec(await readFile(new URL(name, migrations), "utf8"));
      await tx.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    });
    await db.query("INSERT INTO principals(id,kind,display_name,created_at) VALUES($1,'human','Controlled owner',$3),($2,'agent','Controlled agent',$3)", [human, agent, at]);
    await db.query("INSERT INTO organizations(id,slug,name,created_by,created_at) VALUES($1,'upgrade','Controlled upgrade',$2,$3)", [org, human, at]);
    await db.query("INSERT INTO business_units(id,organization_id,slug,name,created_by,created_at) VALUES($1,$2,'unit','Controlled unit',$3,$4)", [unit, org, human, at]);
    await db.query("INSERT INTO projects(id,organization_id,business_unit_id,slug,name,created_by,created_at) VALUES($1,$2,$3,'project','Controlled project',$4,$5)", [project, org, unit, human, at]);
    await db.query("INSERT INTO role_assignments(principal_id,organization_id,project_id,role,granted_by,granted_at) VALUES($1,$3,$4,'owner',$1,$5),($2,$3,$4,'contributor',$1,$5)", [human, agent, org, project, at]);
    await db.query("INSERT INTO repository_connections(project_id,provider,external_repository_id,full_name,connected_by,connected_at) VALUES($1,'github','1001','controlled/upgrade',$2,$3)", [project, human, at]);
    await db.query("INSERT INTO repository_access(principal_id,provider,external_repository_id,can_read,observed_at) VALUES($1,'github','1001',true,$3),($2,'github','1001',true,$3)", [human, agent, at]);
    await db.query("INSERT INTO sources(id,project_id,provider,external_repository_id,reference,url,revision,excerpt,captured_by,captured_at) VALUES($1,$2,'github','1001','pull/1','https://github.com/controlled/upgrade/pull/1',$3,'Controlled exact evidence',$4,$5)", [source, project, "a".repeat(40), human, at]);
    const insertProposal = async (id: string, title: string, replacement = false) => {
      await db.query(`INSERT INTO memory_proposals(id,project_id,type,title,content,owner_id,status,revision,proposed_by,proposed_at,change_kind,target_memory_id,base_revision)
        VALUES($1,$2,'decision',$3,'Controlled model content',$4,'pending',1,$5,$6,$7,$8,$9)`,
      [id, project, title, human, agent, at, replacement ? "replace" : "new", replacement ? oldMemory : null, replacement ? 1 : null]);
      await db.query("INSERT INTO proposal_revisions(project_id,proposal_id,revision,type,title,content,owner_id,authored_by,authored_at) VALUES($1,$2,1,'decision',$3,'Controlled model content',$4,$5,$6)", [project, id, title, human, agent, at]);
      await db.query("INSERT INTO proposal_evidence(project_id,proposal_id,source_id) VALUES($1,$2,$3)", [project, id, source]);
      await db.query("INSERT INTO proposal_revision_evidence(project_id,proposal_id,revision,source_id) VALUES($1,$2,1,$3)", [project, id, source]);
    };
    await insertProposal(oldProposal, "Controlled prior decision");
    await db.query("INSERT INTO memories(id,project_id,owner_id,status,current_revision,created_at) VALUES($1,$2,$3,'approved',1,$4)", [oldMemory, project, human, at]);
    await db.query("UPDATE memory_proposals SET status='approved',reviewed_by=$2,reviewed_at=$3,memory_id=$4 WHERE id=$1", [oldProposal, human, at, oldMemory]);
    await db.query("INSERT INTO memory_revisions(project_id,memory_id,revision,type,title,content,proposal_id,proposal_revision,approved_by,approved_at) VALUES($1,$2,1,'decision','Controlled prior decision','Controlled model content',$3,1,$4,$5)", [project, oldMemory, oldProposal, human, at]);
    await db.query("INSERT INTO memory_evidence(project_id,memory_id,revision,source_id) VALUES($1,$2,1,$3)", [project, oldMemory, source]);
    await insertProposal(pendingNew, "Controlled new draft");
    await insertProposal(pendingReplace, "Controlled replacement draft", true);
    for (const [runId, proposalId, kind] of [[newRun, pendingNew, "new"], [replaceRun, pendingReplace, "replace"]] as const) {
      const extraction = { reviewState: "unreviewed", projectId: project, candidates: [{ title: "Controlled draft", decision: "Controlled model content", evidence: [{ sourceId: source, start: 0, end: 25, quote: "Controlled exact evidence" }], possibleConflicts: [] }], sourceSnapshots: [{ sourceId: source, revision: "a".repeat(40), url: "https://github.com/controlled/upgrade/pull/1", text: "Controlled exact evidence" }], provenance: { provider: "controlled-upgrade-fixture", model: "controlled", usage: null } };
      await db.query("INSERT INTO decision_guard_runs(id,project_id,requester_id,agent_id,created_at,extraction,source_records,decision_records) VALUES($1,$2,$3,$4,$5,$6::jsonb,'[]','[]')", [runId, project, human, agent, at, JSON.stringify(extraction)]);
      await db.query("INSERT INTO decision_guard_run_sources(project_id,run_id,source_id) VALUES($1,$2,$3)", [project, runId, source]);
      await db.query("INSERT INTO decision_guard_publications(project_id,run_id,candidate_index,kind,target_memory_id,proposal_id,proposal_revision,requested_by,created_at) VALUES($1,$2,0,$3,$4,$5,1,$6,$7)", [project, runId, kind, kind === "replace" ? oldMemory : null, proposalId, human, at]);
    }
    const stableSql = "SELECT id,title,content,owner_id,status,revision,proposed_by,proposed_at FROM memory_proposals ORDER BY id";
    const before = (await db.query(stableSql)).rows;
    const applied = await migrate(db);
    assert.ok(applied.includes("009_decision_applicability.sql"));
    assert.ok(applied.includes("010_guard_scope.sql"));
    assert.deepEqual((await db.query(stableSql)).rows, before);
    const ctx = createContext(db, { now: () => at });
    assert.equal((await getGuardRun(ctx, human, newRun)).publications[0]?.proposalId, pendingNew);
    assert.equal((await getProposal(ctx, human, pendingNew)).applicability, null);
    const reviewedNew = await approveProposal(ctx, human, { proposalId: pendingNew, expectedRevision: 1 });
    assert.equal(reviewedNew.status, "approved", "an unchanged existing model NEW draft remains reviewable after upgrade");
    assert.equal(reviewedNew.proposalRevision, 1);
    assert.equal(reviewedNew.applicability, null, "upgrade does not invent reviewed scope for legacy content");
    assert.equal((await getProposal(ctx, human, pendingReplace)).baseStatusGeneration, 0);
    assert.equal((await getMemory(ctx, human, oldMemory)).statusGeneration, 1);
    await assert.rejects(approveProposal(ctx, human, { proposalId: pendingReplace, expectedRevision: 1 }), ConflictError);
    for (const proposalId of [pendingNew, pendingReplace]) {
      await assert.rejects(db.query("UPDATE memory_proposals SET title='Tamper' WHERE id=$1", [proposalId]), /immutable/);
      await assert.rejects(db.query("UPDATE proposal_revisions SET content='Tamper' WHERE proposal_id=$1", [proposalId]), /immutable/);
      await assert.rejects(db.query(`UPDATE memory_proposals SET applicability=$2::jsonb,
        applicability_connection_id=(SELECT id FROM repository_connections WHERE project_id=$3 AND external_repository_id='1001'),revision=2 WHERE id=$1`,
      [proposalId, JSON.stringify({ repositoryId: "1001", branch: "main", validFrom: at.toISOString(), validUntil: null }), project]), /immutable/);
    }
    const triggers = await db.query<{ tgenabled: string }>("SELECT tgenabled FROM pg_trigger WHERE tgname IN ('decision_guard_proposal_frozen','decision_guard_versions_frozen')");
    assert.deepEqual(triggers.rows.map((row) => row.tgenabled), ["O", "O"]);
  } finally { await db.close(); }
});
