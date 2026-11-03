import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignRole,
  ConflictError,
  ForbiddenError,
  getMemory,
  getOrganizationTree,
  listMemories,
  listRoleAssignments,
  NotFoundError,
  removeFromOrganization,
  revokeRole,
  ValidationError,
  type ScopeRef,
} from "../src/index.ts";
import {
  buildWorld,
  human,
  project,
  titlesOf,
  useTestDatabase,
} from "./helpers.ts";

const env = useTestDatabase();

function organization(id: string): ScopeRef {
  return { level: "organization", id };
}

test("roles granted higher up apply to everything inside, and never sideways", async () => {
  const w = await buildWorld(env.ctx);

  assert.deepEqual(
    titlesOf(await listMemories(env.ctx, w.people.orgReader.id)),
    [w.memories.alphaApproved.title, w.memories.betaApproved.title],
  );
  assert.deepEqual(titlesOf(await listMemories(env.ctx, w.people.reader.id)), [
    w.memories.alphaApproved.title,
  ]);
  await assert.rejects(
    getMemory(env.ctx, w.people.reader.id, w.memories.betaApproved.id),
    NotFoundError,
  );
});

test("administrators manage readers, contributors, and reviewers", async () => {
  const w = await buildWorld(env.ctx);
  const newcomer = await human(env.ctx, "Synthetic Newcomer", "900030");

  const assignment = await assignRole(env.ctx, w.people.adminA.id, {
    principalId: newcomer.id,
    scope: project(w.beta.id),
    role: "reviewer",
    reason: "Covers beta reviews",
  });
  assert.equal(assignment.role, "reviewer");
  assert.deepEqual(assignment.scope, project(w.beta.id));

  await assignRole(env.ctx, w.people.buAdmin.id, {
    principalId: newcomer.id,
    scope: project(w.alpha.id),
    role: "reader",
  });
  await assert.rejects(
    assignRole(env.ctx, w.people.buAdmin.id, {
      principalId: newcomer.id,
      scope: project(w.gamma.id),
      role: "reader",
    }),
    NotFoundError,
  );
  await assert.rejects(
    assignRole(env.ctx, w.people.contributor.id, {
      principalId: newcomer.id,
      scope: project(w.alpha.id),
      role: "contributor",
    }),
    ForbiddenError,
  );
});

test("only owners manage administrators and owners", async () => {
  const w = await buildWorld(env.ctx);
  const newcomer = await human(env.ctx, "Synthetic Newcomer", "900030");

  await assert.rejects(
    assignRole(env.ctx, w.people.adminA.id, {
      principalId: newcomer.id,
      scope: project(w.beta.id),
      role: "administrator",
    }),
    { name: "ForbiddenError", message: /Only an owner/ },
  );
  await assert.rejects(
    revokeRole(env.ctx, w.people.adminA.id, {
      principalId: w.people.buAdmin.id,
      scope: { level: "business_unit", id: w.platform.id },
      reason: "Synthetic test",
    }),
    ForbiddenError,
  );
  await assert.rejects(
    assignRole(env.ctx, w.people.adminA.id, {
      principalId: w.people.buAdmin.id,
      scope: { level: "business_unit", id: w.platform.id },
      role: "reader",
    }),
    ForbiddenError,
    "an administrator cannot demote another administrator",
  );

  const promoted = await assignRole(env.ctx, w.people.ownerA.id, {
    principalId: newcomer.id,
    scope: project(w.beta.id),
    role: "administrator",
  });
  assert.equal(promoted.role, "administrator");
});

test("nobody can change their own role, but anyone can give theirs up", async () => {
  const w = await buildWorld(env.ctx);

  await assert.rejects(
    assignRole(env.ctx, w.people.adminA.id, {
      principalId: w.people.adminA.id,
      scope: organization(w.orgA.id),
      role: "owner",
    }),
    { name: "ForbiddenError", message: /own role/ },
  );

  await revokeRole(env.ctx, w.people.reader.id, {
    principalId: w.people.reader.id,
    scope: project(w.alpha.id),
    reason: "Leaving the project",
  });
  await assert.rejects(
    getMemory(env.ctx, w.people.reader.id, w.memories.alphaApproved.id),
    NotFoundError,
  );
});

test("agents can hold only reader or contributor and cannot manage access", async () => {
  const w = await buildWorld(env.ctx);
  const newcomer = await human(env.ctx, "Synthetic Newcomer", "900030");

  for (const role of ["reviewer", "administrator", "owner"] as const) {
    await assert.rejects(
      assignRole(env.ctx, w.people.ownerA.id, {
        principalId: w.people.agent.id,
        scope: project(w.beta.id),
        role,
      }),
      ValidationError,
    );
  }
  await assert.rejects(
    assignRole(env.ctx, w.people.agent.id, {
      principalId: newcomer.id,
      scope: project(w.alpha.id),
      role: "reader",
    }),
    ForbiddenError,
  );

  // A higher grant written straight into the database is ignored, not honored.
  await env.db.query(
    `INSERT INTO role_assignments (principal_id, organization_id, project_id, role, granted_by, granted_at)
     VALUES ($1, $2, $3, 'reviewer', $4, $5)`,
    [
      w.people.agent.id,
      w.orgA.id,
      w.beta.id,
      w.people.ownerA.id,
      env.ctx.now(),
    ],
  );
  const tree = await getOrganizationTree(env.ctx, w.people.agent.id, w.orgA.id);
  assert.deepEqual(
    tree.businessUnits.flatMap((unit) =>
      unit.projects.map((item) => `${item.slug}:${item.role}`),
    ),
    ["alpha:contributor"],
  );
});

test("an organization always keeps at least one owner", async () => {
  const w = await buildWorld(env.ctx);
  const ownerScope = organization(w.orgA.id);

  await assert.rejects(
    revokeRole(env.ctx, w.people.ownerA.id, {
      principalId: w.people.ownerA.id,
      scope: ownerScope,
      reason: "Leaving",
    }),
    ConflictError,
  );
  await assert.rejects(
    removeFromOrganization(env.ctx, w.people.ownerA.id, {
      principalId: w.people.ownerA.id,
      organizationId: w.orgA.id,
      reason: "Leaving",
    }),
    ConflictError,
  );

  await assignRole(env.ctx, w.people.ownerA.id, {
    principalId: w.people.adminA.id,
    scope: ownerScope,
    role: "owner",
  });
  await revokeRole(env.ctx, w.people.ownerA.id, {
    principalId: w.people.ownerA.id,
    scope: ownerScope,
    reason: "Handing over ownership",
  });
  assert.equal(
    (await getOrganizationTree(env.ctx, w.people.adminA.id, w.orgA.id)).role,
    "owner",
  );
  await assert.rejects(
    getOrganizationTree(env.ctx, w.people.ownerA.id, w.orgA.id),
    NotFoundError,
  );
});

test("changing a role replaces the old grant and keeps attributable history", async () => {
  const w = await buildWorld(env.ctx);
  env.advance(1000);

  await assignRole(env.ctx, w.people.adminA.id, {
    principalId: w.people.reader.id,
    scope: project(w.alpha.id),
    role: "contributor",
    reason: "Joined the capture pilot",
  });

  const current = await listRoleAssignments(
    env.ctx,
    w.people.adminA.id,
    project(w.alpha.id),
  );
  assert.deepEqual(
    current
      .filter((item) => item.principalId === w.people.reader.id)
      .map((item) => item.role),
    ["contributor"],
  );

  const history = await env.db.query(
    `SELECT role, granted_by, revoked_by, revoke_reason FROM role_assignments
     WHERE principal_id = $1 ORDER BY granted_at`,
    [w.people.reader.id],
  );
  assert.deepEqual(history.rows, [
    {
      role: "reader",
      granted_by: w.people.adminA.id,
      revoked_by: w.people.adminA.id,
      revoke_reason: "Joined the capture pilot",
    },
    {
      role: "contributor",
      granted_by: w.people.adminA.id,
      revoked_by: null,
      revoke_reason: null,
    },
  ]);

  const audit = await env.db.query(
    `SELECT actor_id, details->>'role' AS role, details->>'previousRole' AS previous_role
     FROM audit_events WHERE action = 'role.assigned' AND target_id = $1 ORDER BY id DESC LIMIT 1`,
    [w.people.reader.id],
  );
  assert.deepEqual(audit.rows[0], {
    actor_id: w.people.adminA.id,
    role: "contributor",
    previous_role: "reader",
  });
});

test("viewing role assignments needs an administrator", async () => {
  const w = await buildWorld(env.ctx);
  await assert.rejects(
    listRoleAssignments(env.ctx, w.people.reviewer.id, project(w.alpha.id)),
    ForbiddenError,
  );
  const roles = await listRoleAssignments(
    env.ctx,
    w.people.buAdmin.id,
    project(w.alpha.id),
  );
  assert.deepEqual(
    roles.map((item) => `${item.principalName}:${item.role}`).sort(),
    [
      "Synthetic Alpha Contributor:contributor",
      "Synthetic Alpha Reader:reader",
      "Synthetic Alpha Reviewer:reviewer",
      "Synthetic Copilot Agent:contributor",
    ],
  );
});
