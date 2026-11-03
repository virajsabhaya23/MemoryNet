import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveProposal,
  assignRole,
  ConflictError,
  connectRepository,
  disconnectRepository,
  ForbiddenError,
  getMemory,
  getProposal,
  getSource,
  handleRepositoryRemoved,
  listMemories,
  listOrganizations,
  listProposals,
  listSources,
  NotFoundError,
  proposeMemory,
  recordRepositoryAccess,
  recordSource,
  rejectProposal,
  removeFromOrganization,
  revokeRole,
  ValidationError,
} from "../src/index.ts";
import {
  ACCESS_MAX_AGE_MS,
  buildWorld,
  grantRepositoryRead,
  human,
  project,
  titlesOf,
  useTestDatabase,
} from "./helpers.ts";

const env = useTestDatabase();

async function visibleTitles(principalId: string): Promise<string[]> {
  return titlesOf(await listMemories(env.ctx, principalId));
}

async function visibleSourceIds(principalId: string): Promise<string[]> {
  return (await listSources(env.ctx, principalId))
    .map((source) => source.id)
    .sort();
}

async function assertHiddenFrom(principalId: string, memoryIds: string[]) {
  for (const id of memoryIds) {
    await assert.rejects(getMemory(env.ctx, principalId, id), NotFoundError);
  }
}

test("readers see approved memories and sources of their own project only", async () => {
  const w = await buildWorld(env.ctx);
  const reader = w.people.reader.id;

  assert.deepEqual(await visibleTitles(reader), [
    w.memories.alphaApproved.title,
  ]);
  assert.deepEqual(await visibleSourceIds(reader), [w.sources.alpha.id]);
  const memory = await getMemory(env.ctx, reader, w.memories.alphaApproved.id);
  assert.deepEqual(
    memory.evidence.map((e) => e.sourceId),
    [w.sources.alpha.id],
  );
  assert.equal(
    (await getSource(env.ctx, reader, w.sources.alpha.id)).reference,
    "pull/11",
  );

  await assertHiddenFrom(reader, [
    w.proposals.alphaPending.id,
    w.memories.betaApproved.id,
    w.memories.deltaApproved.id,
  ]);
  for (const id of [w.sources.beta.id, w.sources.delta.id]) {
    await assert.rejects(getSource(env.ctx, reader, id), NotFoundError);
  }
});

test("organizations are isolated from each other", async () => {
  const w = await buildWorld(env.ctx);
  assert.deepEqual(await visibleTitles(w.people.ownerB.id), [
    w.memories.deltaApproved.title,
  ]);
  assert.deepEqual(
    await visibleTitles(w.people.ownerA.id),
    [w.memories.alphaApproved.title, w.memories.betaApproved.title].sort(),
  );
  assert.deepEqual(
    await listMemories(env.ctx, w.people.ownerB.id, {
      scope: { level: "organization", id: w.orgA.id },
    }),
    [],
  );
  assert.deepEqual(
    titlesOf(
      await listProposals(env.ctx, w.people.ownerA.id, { status: "pending" }),
    ),
    [w.proposals.alphaPending.title],
  );
  assert.deepEqual(
    await listProposals(env.ctx, w.people.ownerB.id, {
      scope: { level: "organization", id: w.orgA.id },
    }),
    [],
  );
  await assert.rejects(
    getProposal(env.ctx, w.people.ownerB.id, w.proposals.alphaPending.id),
    NotFoundError,
  );
  await assert.rejects(
    getSource(env.ctx, w.people.ownerB.id, w.sources.alpha.id),
    NotFoundError,
  );
});

test("results can be organized by organization, business unit, and project", async () => {
  const w = await buildWorld(env.ctx);
  const orgReader = w.people.orgReader.id;
  const titlesIn = async (scope: {
    level: "organization" | "business_unit" | "project";
    id: string;
  }) => titlesOf(await listMemories(env.ctx, orgReader, { scope }));

  const both = [w.memories.alphaApproved.title, w.memories.betaApproved.title];
  assert.deepEqual(
    await titlesIn({ level: "organization", id: w.orgA.id }),
    both,
  );
  assert.deepEqual(
    await titlesIn({ level: "business_unit", id: w.platform.id }),
    both,
  );
  assert.deepEqual(
    await titlesIn({ level: "business_unit", id: w.clinical.id }),
    [],
  );
  assert.deepEqual(await titlesIn({ level: "project", id: w.beta.id }), [
    w.memories.betaApproved.title,
  ]);
  assert.deepEqual(
    (await listSources(env.ctx, orgReader, { scope: project(w.beta.id) })).map(
      (s) => s.id,
    ),
    [w.sources.beta.id],
  );
});

test("proposals reach human contributors and above, never readers or agents", async () => {
  const w = await buildWorld(env.ctx);
  const pending = [w.proposals.alphaPending.title];
  const pendingTitles = async (principalId: string) =>
    titlesOf(await listProposals(env.ctx, principalId, { status: "pending" }));

  assert.deepEqual(await pendingTitles(w.people.contributor.id), pending);
  assert.deepEqual(await pendingTitles(w.people.reviewer.id), pending);
  for (const person of [w.people.reader, w.people.agent]) {
    assert.deepEqual(await listProposals(env.ctx, person.id), []);
    await assert.rejects(
      getProposal(env.ctx, person.id, w.proposals.alphaPending.id),
      NotFoundError,
    );
  }
  assert.deepEqual(
    await visibleTitles(w.people.contributor.id),
    [w.memories.alphaApproved.title],
    "proposals never appear among approved memories",
  );
});

test("a project role alone is not enough: current repository access is required too", async () => {
  const w = await buildWorld(env.ctx);
  const newcomer = await human(env.ctx, "Synthetic Newcomer", "900030");
  await assignRole(env.ctx, w.people.adminA.id, {
    principalId: newcomer.id,
    scope: project(w.alpha.id),
    role: "reader",
  });
  assert.deepEqual(await visibleTitles(newcomer.id), []);
  assert.deepEqual(await visibleSourceIds(newcomer.id), []);

  // Repository access without a MemoryNet role is not enough either.
  assert.deepEqual(await visibleTitles(w.people.outsider.id), []);

  await grantRepositoryRead(env.ctx, "1001", [newcomer]);
  assert.deepEqual(await visibleTitles(newcomer.id), [
    w.memories.alphaApproved.title,
  ]);
});

test("repository access expires unless it is refreshed", async () => {
  const w = await buildWorld(env.ctx);
  env.advance(ACCESS_MAX_AGE_MS + 1);
  assert.deepEqual(await visibleTitles(w.people.reader.id), []);
  assert.deepEqual(await visibleSourceIds(w.people.reader.id), []);

  await grantRepositoryRead(env.ctx, "1001", [w.people.reader]);
  assert.deepEqual(await visibleTitles(w.people.reader.id), [
    w.memories.alphaApproved.title,
  ]);
});

test("a memory is hidden unless the caller can read every evidence source", async () => {
  const w = await buildWorld(env.ctx);
  await connectRepository(env.ctx, w.people.adminA.id, {
    projectId: w.alpha.id,
    provider: "github",
    externalRepositoryId: "1004",
    fullName: "synthetic-org-a/alpha-docs",
  });
  await grantRepositoryRead(env.ctx, "1004", [
    w.people.contributor,
    w.people.reviewer,
  ]);
  const docsSource = await recordSource(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    provider: "github",
    externalRepositoryId: "1004",
    reference: "pull/41",
    url: "https://github.com/synthetic-org-a/alpha-docs/pull/41",
    excerpt: "Synthetic docs discussion.",
  });
  const proposal = await proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    type: "constraint",
    title: "Alpha docs and service agree on limits",
    content: "Synthetic combined memory.",
    evidenceSourceIds: [w.sources.alpha.id, docsSource.id],
  });
  const combined = await approveProposal(env.ctx, w.people.reviewer.id, {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
  });

  assert.equal(
    (await getMemory(env.ctx, w.people.reviewer.id, combined.id)).status,
    "approved",
  );
  await assert.rejects(
    getMemory(env.ctx, w.people.reader.id, combined.id),
    NotFoundError,
  );
  await grantRepositoryRead(env.ctx, "1004", [w.people.reader]);
  assert.equal(
    (await getMemory(env.ctx, w.people.reader.id, combined.id)).id,
    combined.id,
  );
});

test("revoking a role removes access immediately", async () => {
  const w = await buildWorld(env.ctx);
  await revokeRole(env.ctx, w.people.adminA.id, {
    principalId: w.people.reader.id,
    scope: project(w.alpha.id),
    reason: "Moved to another team",
  });
  assert.deepEqual(await visibleTitles(w.people.reader.id), []);
  assert.deepEqual(await visibleSourceIds(w.people.reader.id), []);
  await assert.rejects(
    getSource(env.ctx, w.people.reader.id, w.sources.alpha.id),
    NotFoundError,
  );
});

test("removing a member from the organization revokes every role they hold there", async () => {
  const w = await buildWorld(env.ctx);
  await assignRole(env.ctx, w.people.adminA.id, {
    principalId: w.people.reader.id,
    scope: { level: "business_unit", id: w.platform.id },
    role: "reader",
  });
  const result = await removeFromOrganization(env.ctx, w.people.adminA.id, {
    principalId: w.people.reader.id,
    organizationId: w.orgA.id,
    reason: "Left the organization",
  });
  assert.deepEqual(result, { revokedCount: 2 });
  assert.deepEqual(await visibleTitles(w.people.reader.id), []);
  assert.deepEqual(await listOrganizations(env.ctx, w.people.reader.id), []);

  await assert.rejects(
    removeFromOrganization(env.ctx, w.people.buAdmin.id, {
      principalId: w.people.contributor.id,
      organizationId: w.orgA.id,
      reason: "Only organization administrators may do this",
    }),
    NotFoundError,
  );
  await assert.rejects(
    removeFromOrganization(env.ctx, w.people.adminA.id, {
      principalId: w.people.buAdmin.id,
      organizationId: w.orgA.id,
      reason: "Administrators need an owner to remove them",
    }),
    ForbiddenError,
  );
});

test("losing repository permission removes access to that repository's knowledge", async () => {
  const w = await buildWorld(env.ctx);
  env.advance(1000);
  await recordRepositoryAccess(env.ctx, {
    principalId: w.people.orgReader.id,
    provider: "github",
    externalRepositoryId: "1001",
    canRead: false,
  });
  assert.deepEqual(await visibleTitles(w.people.orgReader.id), [
    w.memories.betaApproved.title,
  ]);
  assert.deepEqual(await visibleSourceIds(w.people.orgReader.id), [
    w.sources.beta.id,
  ]);
});

test("disconnecting a repository hides its knowledge until it is reconnected", async () => {
  const w = await buildWorld(env.ctx);
  await disconnectRepository(env.ctx, w.people.adminA.id, {
    connectionId: w.repos.alpha.id,
    reason: "Paused while access is reviewed",
  });
  for (const person of [
    w.people.ownerA,
    w.people.reviewer,
    w.people.reader,
    w.people.agent,
  ]) {
    await assertHiddenFrom(person.id, [w.memories.alphaApproved.id]);
    assert.ok(
      !(await visibleSourceIds(person.id)).includes(w.sources.alpha.id),
    );
  }
  assert.deepEqual(await visibleTitles(w.people.orgReader.id), [
    w.memories.betaApproved.title,
  ]);

  await connectRepository(env.ctx, w.people.adminA.id, {
    projectId: w.alpha.id,
    provider: "github",
    externalRepositoryId: "1001",
    fullName: "synthetic-org-a/alpha-service",
  });
  assert.deepEqual(await visibleTitles(w.people.reader.id), [
    w.memories.alphaApproved.title,
  ]);
});

test("repository removal reported by the provider stops access", async () => {
  const w = await buildWorld(env.ctx);
  await handleRepositoryRemoved(env.ctx, {
    provider: "github",
    externalRepositoryId: "1001",
    reason: "App uninstalled",
  });
  assert.deepEqual(await visibleTitles(w.people.reader.id), []);
  await assert.rejects(
    getSource(env.ctx, w.people.contributor.id, w.sources.alpha.id),
    NotFoundError,
  );
});

test("moving a repository to another project does not move old knowledge with it", async () => {
  const w = await buildWorld(env.ctx);
  await disconnectRepository(env.ctx, w.people.adminA.id, {
    connectionId: w.repos.alpha.id,
    reason: "Service moved to beta",
  });
  await connectRepository(env.ctx, w.people.adminA.id, {
    projectId: w.beta.id,
    provider: "github",
    externalRepositoryId: "1001",
    fullName: "synthetic-org-a/alpha-service",
  });
  assert.deepEqual(await visibleTitles(w.people.orgReader.id), [
    w.memories.betaApproved.title,
  ]);
  assert.deepEqual(await visibleSourceIds(w.people.orgReader.id), [
    w.sources.beta.id,
  ]);
});

test("sources come only from connected repositories the caller can read", async () => {
  const w = await buildWorld(env.ctx);
  const input = {
    projectId: w.alpha.id,
    provider: "github" as const,
    externalRepositoryId: "1001",
    reference: "pull/12",
    url: "https://github.com/synthetic-org-a/alpha-service/pull/12",
    excerpt: "Synthetic excerpt.",
  };

  await assert.rejects(
    recordSource(env.ctx, w.people.contributor.id, {
      ...input,
      externalRepositoryId: "1002",
    }),
    ValidationError,
    "repository belongs to another project",
  );
  await assert.rejects(
    recordSource(env.ctx, w.people.reader.id, input),
    ForbiddenError,
  );
  await assert.rejects(
    recordSource(env.ctx, w.people.contributor.id, {
      ...input,
      url: "http://github.com/x",
    }),
    ValidationError,
  );
  await assert.rejects(
    recordSource(env.ctx, w.people.contributor.id, {
      ...input,
      url: "https://user:token@github.com/synthetic-org-a/alpha-service/pull/12",
    }),
    ValidationError,
  );
  await assert.rejects(
    recordSource(env.ctx, w.people.contributor.id, {
      ...input,
      revision: "not-a-sha",
    }),
    ValidationError,
  );

  env.advance(ACCESS_MAX_AGE_MS + 1);
  await assert.rejects(
    recordSource(env.ctx, w.people.contributor.id, input),
    ForbiddenError,
  );
});

test("proposals need readable evidence from the same project", async () => {
  const w = await buildWorld(env.ctx);
  const input = {
    projectId: w.alpha.id,
    type: "lesson" as const,
    title: "Synthetic lesson",
    content: "Synthetic lesson body.",
    evidenceSourceIds: [w.sources.alpha.id],
  };

  await assert.rejects(
    proposeMemory(env.ctx, w.people.contributor.id, {
      ...input,
      evidenceSourceIds: [w.sources.beta.id],
    }),
    ValidationError,
  );
  await assert.rejects(
    proposeMemory(env.ctx, w.people.ownerA.id, {
      ...input,
      evidenceSourceIds: [w.sources.alpha.id, w.sources.beta.id],
    }),
    ValidationError,
    "evidence from another project is refused even when readable",
  );
  await assert.rejects(
    proposeMemory(env.ctx, w.people.contributor.id, {
      ...input,
      evidenceSourceIds: [],
    }),
    ValidationError,
  );
  await assert.rejects(
    proposeMemory(env.ctx, w.people.contributor.id, {
      ...input,
      type: "rumor" as unknown as "lesson",
    }),
    ValidationError,
  );
  await assert.rejects(
    proposeMemory(env.ctx, w.people.reader.id, input),
    ForbiddenError,
  );

  await assert.rejects(
    proposeMemory(env.ctx, w.people.agent.id, input),
    { name: "ValidationError", message: /name a person/ },
    "agents must name a person as owner",
  );
  const agentProposal = await proposeMemory(env.ctx, w.people.agent.id, {
    ...input,
    ownerId: w.people.contributor.id,
  });
  assert.equal(agentProposal.status, "pending");
  assert.equal(agentProposal.ownerId, w.people.contributor.id);
  assert.deepEqual(await listProposals(env.ctx, w.people.agent.id), []);
  assert.ok(
    titlesOf(await listProposals(env.ctx, w.people.contributor.id)).includes(
      input.title,
    ),
  );
});

test("reviews need a different human reviewer and the exact revision", async () => {
  const w = await buildWorld(env.ctx);
  const pending = w.proposals.alphaPending;
  const approve = (callerId: string, overrides: Record<string, unknown> = {}) =>
    approveProposal(env.ctx, callerId, {
      proposalId: pending.id,
      expectedRevision: pending.revision,
      ...overrides,
    });

  await assert.rejects(approve(w.people.agent.id), ForbiddenError);
  await assert.rejects(approve(w.people.reader.id), NotFoundError);
  await assert.rejects(approve(w.people.contributor.id), ForbiddenError);
  await assert.rejects(
    approve(w.people.reviewer.id, { expectedRevision: 2 }),
    ConflictError,
  );
  await assert.rejects(
    rejectProposal(env.ctx, w.people.reviewer.id, {
      proposalId: pending.id,
      expectedRevision: pending.revision,
      reason: "   ",
    }),
    ValidationError,
    "a rejection needs a reason",
  );

  const approved = await approve(w.people.reviewer.id);
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, w.people.reviewer.id);
  assert.equal(approved.proposalId, pending.id);
  assert.ok((await visibleTitles(w.people.reader.id)).includes(pending.title));
  await assert.rejects(approve(w.people.ownerA.id), ConflictError);
  await assert.rejects(
    rejectProposal(env.ctx, w.people.ownerA.id, {
      proposalId: pending.id,
      expectedRevision: pending.revision,
      reason: "Already approved",
    }),
    ConflictError,
  );

  const ownProposal = await proposeMemory(env.ctx, w.people.reviewer.id, {
    projectId: w.alpha.id,
    type: "decision",
    title: "Reviewer's own idea",
    content: "Synthetic body.",
    evidenceSourceIds: [w.sources.alpha.id],
  });
  await assert.rejects(
    approveProposal(env.ctx, w.people.reviewer.id, {
      proposalId: ownProposal.id,
      expectedRevision: ownProposal.revision,
    }),
    { name: "ForbiddenError", message: /different person/ },
  );
});

test("a reviewer who lost repository access cannot review that evidence", async () => {
  const w = await buildWorld(env.ctx);
  env.advance(1000);
  await recordRepositoryAccess(env.ctx, {
    principalId: w.people.reviewer.id,
    provider: "github",
    externalRepositoryId: "1001",
    canRead: false,
  });
  await assert.rejects(
    approveProposal(env.ctx, w.people.reviewer.id, {
      proposalId: w.proposals.alphaPending.id,
      expectedRevision: 1,
    }),
    NotFoundError,
  );
});

test("the audit trail records who changed access without storing content", async () => {
  const w = await buildWorld(env.ctx);
  const { rows: actions } = await env.db.query<{ action: string }>(
    "SELECT DISTINCT action FROM audit_events ORDER BY action",
  );
  assert.deepEqual(
    actions.map((row) => row.action),
    [
      "business_unit.created",
      "memory.approved",
      "memory.proposed",
      "organization.created",
      "principal.created",
      "project.created",
      "repository.connected",
      "repository_access.granted",
      "role.assigned",
      "source.recorded",
    ],
  );
  for (const text of [
    w.sources.alpha.excerpt,
    w.memories.alphaApproved.content,
  ]) {
    const { rows } = await env.db.query<{ leaks: number }>(
      `SELECT COUNT(*)::int AS leaks FROM audit_events
       WHERE strpos(details::text, $1) > 0 OR strpos(COALESCE(reason, ''), $1) > 0`,
      [text],
    );
    assert.equal(rows[0]?.leaks, 0);
  }
});
