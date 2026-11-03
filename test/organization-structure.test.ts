import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConflictError,
  createBusinessUnit,
  createOrganization,
  createProject,
  ForbiddenError,
  getOrganizationTree,
  listOrganizations,
  NotFoundError,
  ValidationError,
} from "../src/index.ts";
import { buildWorld, human, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();

function outline(tree: Awaited<ReturnType<typeof getOrganizationTree>>) {
  return tree.businessUnits.map((unit) => ({
    unit: unit.slug,
    role: unit.role,
    projects: unit.projects.map((item) => `${item.slug}:${item.role}`),
  }));
}

test("creating an organization makes the creator its owner", async () => {
  const founder = await human(env.ctx, "Synthetic Founder", "910001");
  const org = await createOrganization(env.ctx, founder.id, {
    slug: "synthetic-health",
    name: "Synthetic Health",
  });
  const tree = await getOrganizationTree(env.ctx, founder.id, org.id);
  assert.equal(tree.organization.slug, "synthetic-health");
  assert.equal(tree.role, "owner");
  assert.deepEqual(tree.businessUnits, []);
});

test("business units and projects nest inside one organization", async () => {
  const w = await buildWorld(env.ctx);
  assert.equal(w.alpha.organizationId, w.orgA.id);
  assert.equal(w.alpha.businessUnitId, w.platform.id);
  const tree = await getOrganizationTree(
    env.ctx,
    w.people.ownerA.id,
    w.orgA.id,
  );
  assert.equal(tree.role, "owner");
  assert.deepEqual(outline(tree), [
    { unit: "clinical-tools", role: "owner", projects: ["gamma:owner"] },
    {
      unit: "platform",
      role: "owner",
      projects: ["alpha:owner", "beta:owner"],
    },
  ]);
});

test("people see only the parts of an organization their roles cover", async () => {
  const w = await buildWorld(env.ctx);

  const readerTree = await getOrganizationTree(
    env.ctx,
    w.people.reader.id,
    w.orgA.id,
  );
  assert.equal(readerTree.role, null);
  assert.deepEqual(outline(readerTree), [
    { unit: "platform", role: null, projects: ["alpha:reader"] },
  ]);

  const unitAdminTree = await getOrganizationTree(
    env.ctx,
    w.people.buAdmin.id,
    w.orgA.id,
  );
  assert.deepEqual(outline(unitAdminTree), [
    {
      unit: "platform",
      role: "administrator",
      projects: ["alpha:administrator", "beta:administrator"],
    },
  ]);

  const orgReaderTree = await getOrganizationTree(
    env.ctx,
    w.people.orgReader.id,
    w.orgA.id,
  );
  assert.equal(orgReaderTree.role, "reader");
  assert.equal(orgReaderTree.businessUnits.length, 2);

  const readerOrgs = await listOrganizations(env.ctx, w.people.reader.id);
  assert.deepEqual(
    readerOrgs.map((org) => org.slug),
    ["synthetic-org-a"],
  );
  assert.deepEqual(await listOrganizations(env.ctx, w.people.outsider.id), []);
  await assert.rejects(
    getOrganizationTree(env.ctx, w.people.reader.id, w.orgB.id),
    NotFoundError,
  );
  await assert.rejects(
    getOrganizationTree(env.ctx, w.people.outsider.id, w.orgA.id),
    NotFoundError,
  );
});

test("only administrators and owners create business units and projects", async () => {
  const w = await buildWorld(env.ctx);

  await assert.rejects(
    createBusinessUnit(env.ctx, w.people.orgReader.id, {
      organizationId: w.orgA.id,
      slug: "research",
      name: "Research",
    }),
    ForbiddenError,
  );
  await assert.rejects(
    createBusinessUnit(env.ctx, w.people.reviewer.id, {
      organizationId: w.orgA.id,
      slug: "research",
      name: "Research",
    }),
    NotFoundError,
  );
  await assert.rejects(
    createProject(env.ctx, w.people.ownerB.id, {
      businessUnitId: w.platform.id,
      slug: "intruder",
      name: "Intruder",
    }),
    NotFoundError,
  );

  const research = await createBusinessUnit(env.ctx, w.people.adminA.id, {
    organizationId: w.orgA.id,
    slug: "research",
    name: "Research",
  });
  const lab = await createProject(env.ctx, w.people.adminA.id, {
    businessUnitId: research.id,
    slug: "lab",
    name: "Lab",
  });
  assert.equal(lab.organizationId, w.orgA.id);

  const tooling = await createProject(env.ctx, w.people.buAdmin.id, {
    businessUnitId: w.platform.id,
    slug: "tooling",
    name: "Tooling",
  });
  assert.equal(tooling.businessUnitId, w.platform.id);
  await assert.rejects(
    createProject(env.ctx, w.people.buAdmin.id, {
      businessUnitId: w.clinical.id,
      slug: "outside-my-unit",
      name: "Outside My Unit",
    }),
    NotFoundError,
  );
});

test("agents cannot create organizations", async () => {
  const w = await buildWorld(env.ctx);
  await assert.rejects(
    createOrganization(env.ctx, w.people.agent.id, {
      slug: "agent-org",
      name: "Agent Org",
    }),
    ForbiddenError,
  );
});

test("names and slugs are validated and slugs are unique", async () => {
  const founder = await human(env.ctx, "Synthetic Founder", "910001");
  const create = (slug: string, name: string) =>
    createOrganization(env.ctx, founder.id, { slug, name });

  await assert.rejects(create("Bad Slug", "Bad"), ValidationError);
  await assert.rejects(create("-leading", "Bad"), ValidationError);
  await assert.rejects(create("ok", "   "), ValidationError);
  await assert.rejects(create("ok", "Line\nbreak"), ValidationError);
  await assert.rejects(create("ok", "x".repeat(121)), ValidationError);

  const org = await create("taken", "Taken");
  await assert.rejects(create("taken", "Again"), ConflictError);
  await createBusinessUnit(env.ctx, founder.id, {
    organizationId: org.id,
    slug: "unit",
    name: "Unit",
  });
  await assert.rejects(
    createBusinessUnit(env.ctx, founder.id, {
      organizationId: org.id,
      slug: "unit",
      name: "Unit",
    }),
    ConflictError,
  );

  const { rows } = await env.db.query<{
    organizations: number;
    grants: number;
  }>(
    `SELECT (SELECT COUNT(*)::int FROM organizations) AS organizations,
            (SELECT COUNT(*)::int FROM role_assignments) AS grants`,
  );
  assert.deepEqual(
    rows[0],
    { organizations: 1, grants: 1 },
    "failed creates leave nothing behind",
  );
});

test("unknown or malformed callers are refused", async () => {
  await assert.rejects(
    createOrganization(env.ctx, "not-a-uuid", { slug: "x", name: "X" }),
    ValidationError,
  );
  await assert.rejects(
    createOrganization(env.ctx, "00000000-0000-4000-8000-000000000000", {
      slug: "x",
      name: "X",
    }),
    ForbiddenError,
  );
});
