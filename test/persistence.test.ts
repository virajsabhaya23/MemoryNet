import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AGENT_ROLES,
  createContext,
  createOrganization,
  createPrincipal,
  getMemory,
  getOrganizationTree,
  getProposal,
  migrate,
  openDatabase,
  ROLE_RANK,
} from "../src/index.ts";
import { buildWorld } from "./helpers.ts";

const MIGRATIONS = [
  "001_organization_setup.sql",
  "002_memory_records.sql",
  "003_knowledge_capture.sql",
  "004_review_workflow.sql",
  "005_history_freshness.sql",
  "006_agents_and_skills.sql",
  "007_retrieval_log.sql",
  "008_decision_guard.sql",
  "009_decision_applicability.sql",
  "010_guard_scope.sql",
  "011_decision_work.sql",
  "012_ledger.sql",
  "013_review_policy.sql",
  "014_memory_relations.sql",
  "015_instruction_flag.sql",
  "016_search_vectors.sql",
  "017_brain.sql",
];

test("records survive a restart and each migration runs once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "memorynet-test-"));
  try {
    const first = await openDatabase(dataDir);
    assert.deepEqual(await migrate(first), MIGRATIONS);
    const ctx = createContext(first);
    const founder = await createPrincipal(ctx, {
      kind: "human",
      displayName: "Synthetic Founder",
    });
    const org = await createOrganization(ctx, founder.id, {
      slug: "restart-check",
      name: "Restart Check",
    });
    await first.close();

    const second = await openDatabase(dataDir);
    try {
      assert.deepEqual(await migrate(second), []);
      const tree = await getOrganizationTree(
        createContext(second),
        founder.id,
        org.id,
      );
      assert.equal(tree.organization.slug, "restart-check");
      assert.equal(tree.role, "owner");
    } finally {
      await second.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("memories and proposals keep their IDs, owners, and evidence after a restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "memorynet-test-"));
  try {
    const first = await openDatabase(dataDir);
    await migrate(first);
    const w = await buildWorld(createContext(first));
    await first.close();

    const second = await openDatabase(dataDir);
    try {
      const ctx = createContext(second);
      assert.deepEqual(
        await getMemory(ctx, w.people.reader.id, w.memories.alphaApproved.id),
        w.memories.alphaApproved,
      );
      const proposal = await getProposal(
        ctx,
        w.people.contributor.id,
        w.proposals.alphaPending.id,
      );
      assert.equal(proposal.status, "pending");
      assert.equal(proposal.ownerId, w.people.contributor.id);
    } finally {
      await second.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("later migrations carry earlier memories and sources over and keep approved IDs", async () => {
  const id = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const db = await openDatabase();
  try {
    await db.exec(
      "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await db.exec(
      await readFile(
        new URL(`../migrations/${MIGRATIONS[0]}`, import.meta.url),
        "utf8",
      ),
    );
    await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
      MIGRATIONS[0],
    ]);
    // Synthetic rows in the migration 001 shape: approved, pending (by an agent), and rejected.
    await db.exec(`
      INSERT INTO principals (id, kind, display_name, created_at) VALUES
        ('${id(1)}', 'human', 'Synthetic Proposer', now()),
        ('${id(2)}', 'human', 'Synthetic Reviewer', now()),
        ('${id(3)}', 'agent', 'Synthetic Agent', now());
      INSERT INTO organizations (id, slug, name, created_by, created_at)
        VALUES ('${id(101)}', 'carry-over', 'Carry Over', '${id(1)}', now());
      INSERT INTO business_units (id, organization_id, slug, name, created_by, created_at)
        VALUES ('${id(201)}', '${id(101)}', 'unit', 'Unit', '${id(1)}', now());
      INSERT INTO projects (id, organization_id, business_unit_id, slug, name, created_by, created_at)
        VALUES ('${id(301)}', '${id(101)}', '${id(201)}', 'project', 'Project', '${id(2)}', now());
      INSERT INTO sources (id, project_id, provider, external_repository_id, reference, url,
                           excerpt, captured_by, captured_at)
        VALUES ('${id(401)}', '${id(301)}', 'github', '1001', 'pull/1',
                'https://github.com/synthetic-org/carry-over/pull/1', 'Synthetic excerpt.',
                '${id(1)}', now());
      INSERT INTO memories (id, project_id, type, title, content, status, revision, proposed_by,
                            proposed_at, reviewed_by, reviewed_at, review_reason) VALUES
        ('${id(501)}', '${id(301)}', 'decision', 'Approved before 002', 'Synthetic.', 'approved', 1,
         '${id(1)}', now(), '${id(2)}', now(), NULL),
        ('${id(502)}', '${id(301)}', 'lesson', 'Pending agent idea', 'Synthetic.', 'pending', 1,
         '${id(3)}', now(), NULL, NULL, NULL),
        ('${id(503)}', '${id(301)}', 'incident', 'Rejected before 002', 'Synthetic.', 'rejected', 1,
         '${id(1)}', now(), '${id(2)}', now(), 'Not supported');
      INSERT INTO memory_evidence (project_id, memory_id, source_id) VALUES
        ('${id(301)}', '${id(501)}', '${id(401)}'),
        ('${id(301)}', '${id(502)}', '${id(401)}'),
        ('${id(301)}', '${id(503)}', '${id(401)}');`);

    assert.deepEqual(await migrate(db), MIGRATIONS.slice(1));

    const proposals = await db.query(
      "SELECT id, owner_id, status, memory_id FROM memory_proposals ORDER BY id",
    );
    assert.deepEqual(proposals.rows, [
      { id: id(501), owner_id: id(1), status: "approved", memory_id: id(501) },
      { id: id(502), owner_id: id(2), status: "pending", memory_id: null },
      { id: id(503), owner_id: id(1), status: "rejected", memory_id: null },
    ]);
    const memories = await db.query(
      `SELECT m.id, m.owner_id, r.revision, r.title, r.proposal_id, r.approved_by
       FROM memories m JOIN memory_revisions r ON r.memory_id = m.id`,
    );
    assert.deepEqual(memories.rows, [
      {
        id: id(501),
        owner_id: id(1),
        revision: 1,
        title: "Approved before 002",
        proposal_id: id(501),
        approved_by: id(2),
      },
    ]);
    const evidence = await db.query(
      "SELECT memory_id, revision, source_id FROM memory_evidence",
    );
    assert.deepEqual(evidence.rows, [
      { memory_id: id(501), revision: 1, source_id: id(401) },
    ]);
    const carried = await db.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM proposal_evidence",
    );
    assert.equal(carried.rows[0]?.count, 3);
    const sources = await db.query(
      "SELECT id, capture_method, captured_by, content_flags FROM sources",
    );
    assert.deepEqual(
      sources.rows,
      [
        {
          id: id(401),
          capture_method: "manual",
          captured_by: id(1),
          content_flags: [],
        },
      ],
      "earlier sources become manual sources with no flags",
    );
  } finally {
    await db.close();
  }
});

test("the audit trail cannot be edited or deleted", async () => {
  const db = await openDatabase();
  try {
    await migrate(db);
    await createPrincipal(createContext(db), {
      kind: "agent",
      displayName: "Synthetic Agent",
    });
    await assert.rejects(
      db.query("UPDATE audit_events SET action = 'tampered'"),
      /append-only/,
    );
    await assert.rejects(db.query("DELETE FROM audit_events"), /append-only/);
  } finally {
    await db.close();
  }
});

test("role rules in code match the database", async () => {
  const db = await openDatabase();
  try {
    await migrate(db);
    const { rows } = await db.query<{
      name: string;
      rank: number;
      agent_allowed: boolean;
    }>("SELECT name, rank, agent_allowed FROM roles ORDER BY rank");
    assert.deepEqual(
      rows,
      Object.entries(ROLE_RANK).map(([name, rank]) => ({
        name,
        rank,
        agent_allowed: (AGENT_ROLES as readonly string[]).includes(name),
      })),
    );
  } finally {
    await db.close();
  }
});
