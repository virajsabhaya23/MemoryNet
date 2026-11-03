import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignRole,
  createBusinessUnit,
  createOrganization,
  createProject,
  NotFoundError,
} from "../src/index.ts";
import {
  OPEN_BUDGET,
  PLACE_BUDGET,
  UNIT_BUDGET,
} from "../src/web/assets/my-network-view.js";
import { getMyOverview, getMyPlace } from "../src/web/my-network.ts";
import { human, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();

async function bigOrganization(projects: number) {
  const ctx = env.ctx;
  const owner = await human(ctx, "Morgan Synthetic", "920001");
  const reader = await human(ctx, "Riley Synthetic", "920002");
  const outsider = await human(ctx, "Oakley Synthetic", "920003");
  const org = await createOrganization(ctx, owner.id, {
    slug: "big-synthetic",
    name: "Big (synthetic)",
  });
  const large = await createBusinessUnit(ctx, owner.id, {
    organizationId: org.id,
    slug: "large",
    name: "Large unit",
  });
  const small = await createBusinessUnit(ctx, owner.id, {
    organizationId: org.id,
    slug: "small",
    name: "Small unit",
  });
  const ids: string[] = [];
  for (let index = 0; index < projects; index += 1) {
    const project = await createProject(ctx, owner.id, {
      businessUnitId: large.id,
      slug: `p${index}`,
      name: `Project ${index}`,
    });
    ids.push(project.id);
  }
  const lone = await createProject(ctx, owner.id, {
    businessUnitId: small.id,
    slug: "lone",
    name: "Lone project",
  });
  await assignRole(ctx, owner.id, {
    principalId: reader.id,
    scope: { level: "organization", id: org.id },
    role: "reader",
  });
  const yours = ids[Math.max(0, projects - 3)] ?? "";
  await assignRole(ctx, owner.id, {
    principalId: reader.id,
    scope: { level: "project", id: yours },
    role: "reviewer",
  });
  return { org, large, small, lone, owner, reader, outsider, yours };
}

test("past the project budget, only your own projects are drawn until their business unit opens", async () => {
  const world = await bigOrganization(PLACE_BUDGET + 4);
  const view = await getMyOverview(env.ctx, world.reader.id, world.org.id);
  assert.equal(view.folded, true);
  assert.equal(
    view.places.length,
    1 + 2 + PLACE_BUDGET + 5,
    "every place is still listed",
  );
  const large = `business_unit:${world.large.id}`;
  const yours = `project:${world.yours}`;
  assert.deepEqual(
    view.kids[large],
    [yours],
    "your project is pinned under its unit",
  );
  assert.deepEqual(view.kids[`business_unit:${world.small.id}`], []);
  const drawn = view.places.filter((place) => place.drawn);
  assert.equal(
    drawn.length,
    1 + 2 + 1,
    "the organization, both units, and your project",
  );
  assert.equal(
    view.places.find((place) => place.id === yours)?.access,
    "direct",
  );

  const opened = await getMyPlace(
    env.ctx,
    world.reader.id,
    world.org.id,
    large,
  );
  assert.equal(
    opened.children.length,
    OPEN_BUDGET,
    "an opened unit draws at most the budget",
  );
  assert.equal(
    opened.children[0]?.id,
    yours,
    "projects you have a role in come first",
  );
  assert.equal(
    opened.more,
    PLACE_BUDGET + 4 - OPEN_BUDGET,
    "the rest are counted, not drawn",
  );

  const project = await getMyPlace(
    env.ctx,
    world.reader.id,
    world.org.id,
    yours,
  );
  assert.deepEqual(project.children, [], "a project holds no places");
});

test("small organizations draw every project at once", async () => {
  const world = await bigOrganization(6);
  const view = await getMyOverview(env.ctx, world.owner.id, world.org.id);
  assert.equal(view.folded, false);
  assert.equal(view.kids[`business_unit:${world.large.id}`]?.length, 6);
  assert.ok(view.places.every((place) => place.drawn));
  const unit = await getMyPlace(
    env.ctx,
    world.owner.id,
    world.org.id,
    `business_unit:${world.large.id}`,
  );
  assert.deepEqual(unit.children, [], "drawn projects are not sent again");
});

test("past the business unit budget, the rest are listed under one node, yours first", async () => {
  const ctx = env.ctx;
  const owner = await human(ctx, "Morgan Synthetic", "920001");
  const member = await human(ctx, "Riley Synthetic", "920002");
  const org = await createOrganization(ctx, owner.id, {
    slug: "units-synthetic",
    name: "Units (synthetic)",
  });
  const units: string[] = [];
  for (let index = 0; index < UNIT_BUDGET + 2; index += 1) {
    const unit = await createBusinessUnit(ctx, owner.id, {
      organizationId: org.id,
      slug: `u${index}`,
      name: `Unit ${index}`,
    });
    units.push(unit.id);
    if (index < UNIT_BUDGET + 1) {
      await createProject(ctx, owner.id, {
        businessUnitId: unit.id,
        slug: `p${index}`,
        name: `Project ${index}`,
      });
    }
  }
  const last = units.at(-1) ?? "";
  await assignRole(ctx, owner.id, {
    principalId: member.id,
    scope: { level: "organization", id: org.id },
    role: "reader",
  });
  await assignRole(ctx, owner.id, {
    principalId: member.id,
    scope: { level: "business_unit", id: last },
    role: "contributor",
  });
  const view = await getMyOverview(ctx, member.id, org.id);
  assert.equal(view.tops.length, UNIT_BUDGET);
  assert.equal(view.tops.at(-1), "more:units");
  assert.equal(view.listed.length, 3);
  assert.ok(
    view.tops.includes(`business_unit:${last}`),
    "the empty unit where you have a role is drawn",
  );
  assert.ok(
    view.places
      .filter((place) => view.tops.includes(place.id))
      .every((place) => place.drawn),
    "every unit drawn at first is marked drawn",
  );
});

test("hidden places read as missing", async () => {
  const world = await bigOrganization(2);
  await assert.rejects(
    getMyOverview(env.ctx, world.outsider.id, world.org.id),
    NotFoundError,
  );
  await assert.rejects(
    getMyPlace(
      env.ctx,
      world.reader.id,
      world.org.id,
      "project:00000000-0000-4000-8000-000000000000",
    ),
    NotFoundError,
  );
  await assert.rejects(
    getMyPlace(
      env.ctx,
      world.outsider.id,
      world.org.id,
      `project:${world.lone.id}`,
    ),
    NotFoundError,
  );
});
