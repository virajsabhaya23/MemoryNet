// Shared test setup. All names, IDs, and text are synthetic.
import { after, before, beforeEach } from "node:test";
import {
  approveProposal,
  assignRole,
  connectRepository,
  createBusinessUnit,
  createContext,
  createOrganization,
  createPrincipal,
  createProject,
  migrate,
  openDatabase,
  proposeMemory,
  recordRepositoryAccess,
  recordSource,
  type Database,
  type MemoryNetContext,
  type Principal,
  type Proposal,
  type Role,
  type ScopeRef,
} from "../src/index.ts";

export const START = new Date("2026-09-24T09:00:00.000Z");
export const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;

const TRUNCATE_ALL = `TRUNCATE brain_briefs, ledger_entries, ledger_heads, proposal_approvals, project_policy_revisions, decision_work_pins, decision_work, decision_guard_publications, decision_guard_run_sources,
  decision_guard_runs, audit_events, retrieval_definitions, retrieval_items, retrievals, definition_links,
  definition_revisions, definition_proposal_links, definition_proposals, definitions, memory_reports,
  memory_status_changes, memory_evidence, memory_revisions, memories, proposal_revision_evidence,
  proposal_revisions, proposal_evidence, memory_proposals, sources, repository_access,
  repository_connections, role_assignments, projects, business_units, organizations, principals
  RESTART IDENTITY`;

/** One embedded database per test file, emptied before each test, with a controllable clock. */
export function useTestDatabase() {
  const state: { db: Database | null; now: Date } = { db: null, now: START };
  before(async () => {
    state.db = await openDatabase();
    await migrate(state.db);
  });
  after(async () => {
    await state.db?.close();
  });
  beforeEach(async () => {
    state.now = START;
    await requireDb().exec(TRUNCATE_ALL);
  });
  function requireDb(): Database {
    if (!state.db) throw new Error("Test database is not open");
    return state.db;
  }
  return {
    get db(): Database {
      return requireDb();
    },
    get ctx(): MemoryNetContext {
      return createContext(requireDb(), {
        now: () => state.now,
        repositoryAccessMaxAgeMs: ACCESS_MAX_AGE_MS,
      });
    },
    advance(ms: number): void {
      state.now = new Date(state.now.getTime() + ms);
    },
  };
}

export function human(
  ctx: MemoryNetContext,
  displayName: string,
  githubUserId: string,
): Promise<Principal> {
  return createPrincipal(ctx, { kind: "human", displayName, githubUserId });
}

export function project(id: string): ScopeRef {
  return { level: "project", id };
}

export async function grantRepositoryRead(
  ctx: MemoryNetContext,
  externalRepositoryId: string,
  principals: Principal[],
): Promise<void> {
  for (const principal of principals) {
    await recordRepositoryAccess(ctx, {
      principalId: principal.id,
      provider: "github",
      externalRepositoryId,
      canRead: true,
    });
  }
}

export function titlesOf(items: Array<{ title: string }>): string[] {
  return items.map((item) => item.title).sort();
}

async function give(
  ctx: MemoryNetContext,
  grantor: Principal,
  principal: Principal,
  scope: ScopeRef,
  role: Role,
): Promise<void> {
  await assignRole(ctx, grantor.id, { principalId: principal.id, scope, role });
}

/**
 * Two synthetic organizations:
 *   Org A: business units platform (projects alpha, beta) and clinical-tools (project gamma)
 *   Org B: business unit core (project delta)
 * Repositories: alpha 1001, beta 1002, gamma 1003, delta 2001.
 */
export async function buildWorld(ctx: MemoryNetContext) {
  const people = {
    ownerA: await human(ctx, "Synthetic Owner A", "900001"),
    adminA: await human(ctx, "Synthetic Org Admin", "900002"),
    reader: await human(ctx, "Synthetic Alpha Reader", "900003"),
    contributor: await human(ctx, "Synthetic Alpha Contributor", "900004"),
    reviewer: await human(ctx, "Synthetic Alpha Reviewer", "900005"),
    orgReader: await human(ctx, "Synthetic Org Reader", "900006"),
    buAdmin: await human(ctx, "Synthetic Platform Admin", "900007"),
    agent: await createPrincipal(ctx, {
      kind: "agent",
      displayName: "Synthetic Coding Agent",
    }),
    ownerB: await human(ctx, "Synthetic Owner B", "900010"),
    reviewerB: await human(ctx, "Synthetic Delta Reviewer", "900011"),
    outsider: await human(ctx, "Synthetic Outsider", "900020"),
  };

  const orgA = await createOrganization(ctx, people.ownerA.id, {
    slug: "synthetic-org-a",
    name: "Synthetic Org A",
  });
  const platform = await createBusinessUnit(ctx, people.ownerA.id, {
    organizationId: orgA.id,
    slug: "platform",
    name: "Platform",
  });
  const clinical = await createBusinessUnit(ctx, people.ownerA.id, {
    organizationId: orgA.id,
    slug: "clinical-tools",
    name: "Clinical Tools",
  });
  const alpha = await createProject(ctx, people.ownerA.id, {
    businessUnitId: platform.id,
    slug: "alpha",
    name: "Alpha",
  });
  const beta = await createProject(ctx, people.ownerA.id, {
    businessUnitId: platform.id,
    slug: "beta",
    name: "Beta",
  });
  const gamma = await createProject(ctx, people.ownerA.id, {
    businessUnitId: clinical.id,
    slug: "gamma",
    name: "Gamma",
  });

  const organizationA: ScopeRef = { level: "organization", id: orgA.id };
  await give(ctx, people.ownerA, people.adminA, organizationA, "administrator");
  await give(ctx, people.ownerA, people.orgReader, organizationA, "reader");
  await give(
    ctx,
    people.ownerA,
    people.buAdmin,
    { level: "business_unit", id: platform.id },
    "administrator",
  );
  await give(ctx, people.adminA, people.reader, project(alpha.id), "reader");
  await give(
    ctx,
    people.adminA,
    people.contributor,
    project(alpha.id),
    "contributor",
  );
  await give(
    ctx,
    people.adminA,
    people.reviewer,
    project(alpha.id),
    "reviewer",
  );
  await give(
    ctx,
    people.adminA,
    people.agent,
    project(alpha.id),
    "contributor",
  );

  const orgB = await createOrganization(ctx, people.ownerB.id, {
    slug: "synthetic-org-b",
    name: "Synthetic Org B",
  });
  const core = await createBusinessUnit(ctx, people.ownerB.id, {
    organizationId: orgB.id,
    slug: "core",
    name: "Core",
  });
  const delta = await createProject(ctx, people.ownerB.id, {
    businessUnitId: core.id,
    slug: "delta",
    name: "Delta",
  });
  await give(
    ctx,
    people.ownerB,
    people.reviewerB,
    project(delta.id),
    "reviewer",
  );

  const connect = (
    projectId: string,
    externalRepositoryId: string,
    fullName: string,
    by: Principal,
  ) =>
    connectRepository(ctx, by.id, {
      projectId,
      provider: "github",
      externalRepositoryId,
      fullName,
    });
  const repos = {
    alpha: await connect(
      alpha.id,
      "1001",
      "synthetic-org-a/alpha-service",
      people.adminA,
    ),
    beta: await connect(
      beta.id,
      "1002",
      "synthetic-org-a/beta-service",
      people.adminA,
    ),
    gamma: await connect(
      gamma.id,
      "1003",
      "synthetic-org-a/gamma-service",
      people.adminA,
    ),
    delta: await connect(
      delta.id,
      "2001",
      "synthetic-org-b/delta-service",
      people.ownerB,
    ),
  };

  const {
    ownerA,
    adminA,
    reader,
    contributor,
    reviewer,
    orgReader,
    buAdmin,
    agent,
    ownerB,
    reviewerB,
    outsider,
  } = people;
  await grantRepositoryRead(ctx, "1001", [
    ownerA,
    adminA,
    reader,
    contributor,
    reviewer,
    orgReader,
    buAdmin,
    agent,
    outsider,
  ]);
  await grantRepositoryRead(ctx, "1002", [ownerA, adminA, orgReader, buAdmin]);
  await grantRepositoryRead(ctx, "1003", [ownerA, adminA, orgReader]);
  await grantRepositoryRead(ctx, "2001", [ownerB, reviewerB]);

  const source = (
    projectId: string,
    externalRepositoryId: string,
    fullName: string,
    pr: number,
    by: Principal,
  ) =>
    recordSource(ctx, by.id, {
      projectId,
      provider: "github",
      externalRepositoryId,
      reference: `pull/${pr}`,
      url: `https://github.com/${fullName}/pull/${pr}`,
      revision: "0123456789abcdef0123456789abcdef01234567",
      excerpt: `Synthetic discussion excerpt for ${fullName} PR ${pr}.`,
    });
  const sources = {
    alpha: await source(
      alpha.id,
      "1001",
      "synthetic-org-a/alpha-service",
      11,
      contributor,
    ),
    beta: await source(
      beta.id,
      "1002",
      "synthetic-org-a/beta-service",
      21,
      ownerA,
    ),
    delta: await source(
      delta.id,
      "2001",
      "synthetic-org-b/delta-service",
      31,
      ownerB,
    ),
  };

  const propose = (
    projectId: string,
    title: string,
    sourceId: string,
    by: Principal,
  ) =>
    proposeMemory(ctx, by.id, {
      projectId,
      type: "decision",
      title,
      content: `Synthetic memory body for "${title}".`,
      evidenceSourceIds: [sourceId],
    });
  const approve = (proposal: Proposal, by: Principal) =>
    approveProposal(ctx, by.id, {
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
    });

  const memories = {
    alphaApproved: await approve(
      await propose(
        alpha.id,
        "Alpha uses queue retries",
        sources.alpha.id,
        contributor,
      ),
      reviewer,
    ),
    betaApproved: await approve(
      await propose(
        beta.id,
        "Beta pins the SDK version",
        sources.beta.id,
        ownerA,
      ),
      adminA,
    ),
    deltaApproved: await approve(
      await propose(
        delta.id,
        "Delta keeps nightly exports",
        sources.delta.id,
        ownerB,
      ),
      reviewerB,
    ),
  };
  const proposals = {
    alphaPending: await propose(
      alpha.id,
      "Alpha may drop the cache",
      sources.alpha.id,
      contributor,
    ),
  };

  return {
    people,
    orgA,
    orgB,
    platform,
    clinical,
    core,
    alpha,
    beta,
    gamma,
    delta,
    repos,
    sources,
    memories,
    proposals,
  };
}

export type World = Awaited<ReturnType<typeof buildWorld>>;
