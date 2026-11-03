import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConflictError,
  connectRepository,
  disconnectRepository,
  ForbiddenError,
  getMemory,
  handleRepositoryRemoved,
  listRepositoryConnections,
  NotFoundError,
  recordRepositoryAccess,
  ValidationError,
} from "../src/index.ts";
import { buildWorld, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();

test("administrators connect selected repositories to a project", async () => {
  const w = await buildWorld(env.ctx);
  env.advance(1000);
  const added = await connectRepository(env.ctx, w.people.buAdmin.id, {
    projectId: w.alpha.id,
    provider: "github",
    externalRepositoryId: "1004",
    fullName: "synthetic-org-a/alpha-docs",
  });
  assert.equal(added.projectId, w.alpha.id);

  const connections = await listRepositoryConnections(
    env.ctx,
    w.people.adminA.id,
    w.alpha.id,
  );
  assert.deepEqual(
    connections.map((item) => [item.fullName, item.disconnectedAt]),
    [
      ["synthetic-org-a/alpha-service", null],
      ["synthetic-org-a/alpha-docs", null],
    ],
  );
});

test("only administrators of the project can connect or view repositories", async () => {
  const w = await buildWorld(env.ctx);
  const input = {
    projectId: w.alpha.id,
    provider: "github" as const,
    externalRepositoryId: "1099",
    fullName: "synthetic-org-a/extra",
  };
  await assert.rejects(
    connectRepository(env.ctx, w.people.reviewer.id, input),
    ForbiddenError,
  );
  await assert.rejects(
    connectRepository(env.ctx, w.people.agent.id, input),
    ForbiddenError,
  );
  await assert.rejects(
    connectRepository(env.ctx, w.people.ownerB.id, input),
    NotFoundError,
  );
  await assert.rejects(
    listRepositoryConnections(env.ctx, w.people.reader.id, w.alpha.id),
    ForbiddenError,
  );
});

test("a repository is connected to at most one project at a time", async () => {
  const w = await buildWorld(env.ctx);
  const alphaRepository = {
    provider: "github" as const,
    externalRepositoryId: "1001",
    fullName: "synthetic-org-a/alpha-service",
  };
  await assert.rejects(
    connectRepository(env.ctx, w.people.adminA.id, {
      ...alphaRepository,
      projectId: w.beta.id,
    }),
    ConflictError,
  );
  await assert.rejects(
    connectRepository(env.ctx, w.people.ownerB.id, {
      ...alphaRepository,
      projectId: w.delta.id,
    }),
    ConflictError,
  );

  await disconnectRepository(env.ctx, w.people.adminA.id, {
    connectionId: w.repos.alpha.id,
    reason: "Moving the service to beta",
  });
  const moved = await connectRepository(env.ctx, w.people.adminA.id, {
    ...alphaRepository,
    projectId: w.beta.id,
  });
  assert.equal(moved.projectId, w.beta.id);
});

test("disconnecting keeps history and cannot happen twice", async () => {
  const w = await buildWorld(env.ctx);
  env.advance(1000);
  const disconnected = await disconnectRepository(env.ctx, w.people.adminA.id, {
    connectionId: w.repos.alpha.id,
    reason: "Repository archived",
  });
  assert.equal(disconnected.disconnectedBy, w.people.adminA.id);
  assert.equal(disconnected.disconnectReason, "Repository archived");
  assert.deepEqual(disconnected.disconnectedAt, env.ctx.now());
  await assert.rejects(
    disconnectRepository(env.ctx, w.people.adminA.id, {
      connectionId: w.repos.alpha.id,
      reason: "Again",
    }),
    ConflictError,
  );
  await assert.rejects(
    disconnectRepository(env.ctx, w.people.contributor.id, {
      connectionId: w.repos.beta.id,
      reason: "Not my project",
    }),
    NotFoundError,
  );
  const history = await listRepositoryConnections(
    env.ctx,
    w.people.adminA.id,
    w.alpha.id,
  );
  assert.equal(history.length, 1);
});

test("repository input is validated", async () => {
  const w = await buildWorld(env.ctx);
  const valid = {
    projectId: w.alpha.id,
    provider: "github" as const,
    externalRepositoryId: "1099",
    fullName: "synthetic-org-a/extra",
  };
  const attempts: Array<Record<string, unknown>> = [
    { provider: "gitlab" },
    { externalRepositoryId: "abc" },
    { externalRepositoryId: "0" },
    { fullName: "no-slash" },
    { fullName: "owner/.." },
    { fullName: "-owner/repo" },
    { projectId: "alpha" },
  ];
  for (const change of attempts) {
    await assert.rejects(
      connectRepository(env.ctx, w.people.adminA.id, {
        ...valid,
        ...change,
      } as typeof valid),
      ValidationError,
      JSON.stringify(change),
    );
  }
});

test("the provider can report a repository removed, which disconnects it", async () => {
  const w = await buildWorld(env.ctx);
  const removal = {
    provider: "github" as const,
    externalRepositoryId: "1001",
    reason: "Removed from the app installation",
  };
  assert.deepEqual(await handleRepositoryRemoved(env.ctx, removal), {
    disconnected: true,
  });
  assert.deepEqual(await handleRepositoryRemoved(env.ctx, removal), {
    disconnected: false,
  });

  const [connection] = await listRepositoryConnections(
    env.ctx,
    w.people.adminA.id,
    w.alpha.id,
  );
  assert.equal(connection?.disconnectedBy, null);
  assert.equal(
    connection?.disconnectReason,
    "Removed from the app installation",
  );

  const audit = await env.db.query(
    `SELECT actor_id, project_id FROM audit_events
     WHERE action = 'repository.disconnected' AND target_id = 'github:1001'`,
  );
  assert.deepEqual(audit.rows, [{ actor_id: null, project_id: w.alpha.id }]);
});

test("newer access reports win and older ones are ignored", async () => {
  const w = await buildWorld(env.ctx);
  const beforeChange = env.ctx.now();
  env.advance(60_000);
  const report = {
    principalId: w.people.reader.id,
    provider: "github" as const,
    externalRepositoryId: "1001",
  };

  assert.deepEqual(
    await recordRepositoryAccess(env.ctx, { ...report, canRead: false }),
    {
      applied: true,
    },
  );
  assert.deepEqual(
    await recordRepositoryAccess(env.ctx, {
      ...report,
      canRead: true,
      observedAt: beforeChange,
    }),
    { applied: false },
    "a late, older report must not restore access",
  );
  await assert.rejects(
    getMemory(env.ctx, w.people.reader.id, w.memories.alphaApproved.id),
    NotFoundError,
  );

  await assert.rejects(
    recordRepositoryAccess(env.ctx, {
      ...report,
      canRead: true,
      observedAt: new Date(env.ctx.now().getTime() + 1000),
    }),
    ValidationError,
  );
  await assert.rejects(
    recordRepositoryAccess(env.ctx, {
      ...report,
      principalId: "00000000-0000-4000-8000-000000000000",
      canRead: true,
    }),
    NotFoundError,
  );
});
