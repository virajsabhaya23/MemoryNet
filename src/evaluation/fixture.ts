import {
  assignRole, connectRepository, createBusinessUnit, createContext, createOrganization,
  createPrincipal, createProject, migrate, openDatabase, proposeMemory, recordRepositoryAccess,
  recordSource, type DecisionApplicabilityInput,
} from "../index.ts";

/** Engineering fixture only. No real users, real GitHub data, Meta requests or scientific outcomes. */
export async function createSyntheticEvaluationFixture() {
  const db = await openDatabase();
  try {
    await migrate(db);
    let clock = new Date("2026-10-30T16:00:00.000Z");
    const ctx = createContext(db, { now: () => new Date(clock) });
    const owner = await createPrincipal(ctx, { kind: "human", displayName: "Synthetic fixture author" });
    const reviewer = await createPrincipal(ctx, { kind: "human", displayName: "Synthetic fixture reviewer" });
    const agent = await createPrincipal(ctx, { kind: "agent", displayName: "Synthetic fixture reader" });
    const org = await createOrganization(ctx, owner.id, { slug: "synthetic-evaluation", name: "Synthetic engineering evaluation" });
    const unit = await createBusinessUnit(ctx, owner.id, { organizationId: org.id, slug: "fixture", name: "Fixture" });
    const project = await createProject(ctx, owner.id, { businessUnitId: unit.id, slug: "transport", name: "Synthetic transport" });
    await assignRole(ctx, owner.id, { principalId: reviewer.id, scope: { level: "project", id: project.id }, role: "reviewer" });
    await assignRole(ctx, owner.id, { principalId: agent.id, scope: { level: "project", id: project.id }, role: "reader" });
    const repositoryId = "1001";
    await connectRepository(ctx, owner.id, { projectId: project.id, provider: "github", externalRepositoryId: repositoryId, fullName: "synthetic-fixture/transport" });
    for (const person of [owner, reviewer, agent]) await recordRepositoryAccess(ctx, {
      principalId: person.id, provider: "github", externalRepositoryId: repositoryId, canRead: true,
    });
    const source = await recordSource(ctx, owner.id, { projectId: project.id, provider: "github", externalRepositoryId: repositoryId,
      reference: "pull/1", url: "https://github.com/synthetic-fixture/transport/pull/1", revision: "a".repeat(40),
      excerpt: "Synthetic fixture transport decision evidence. This is engineering test data, not a real pull request." });
    const applicability: DecisionApplicabilityInput = { repositoryId, branch: "main", validFrom: new Date(clock.getTime() - 1000), validUntil: null };
    return { db, ctx, owner, reviewer, agent, project, repositoryId, source, applicability,
      advance(ms: number) { clock = new Date(clock.getTime() + ms); },
      propose(title: string, content: string, scope: DecisionApplicabilityInput | null = applicability) {
        return proposeMemory(ctx, owner.id, { projectId: project.id, type: "decision", title, content,
          evidenceSourceIds: [source.id], applicability: scope });
      },
      close: () => db.close(),
    };
  } catch (error) { await db.close(); throw error; }
}
