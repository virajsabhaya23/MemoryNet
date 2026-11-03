import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveProposal,
  ConflictError,
  connectRepository,
  dismissReport,
  editProposal,
  ForbiddenError,
  getMemory,
  getMemoryHistory,
  listMemories,
  NotFoundError,
  proposeChange,
  proposeMemory,
  proposeRestore,
  recordRepositoryAccess,
  recordSource,
  reinstateMemory,
  reportOutdated,
  suspendMemory,
  ValidationError,
  type Memory,
  type Proposal,
} from "../src/index.ts";
import {
  buildWorld,
  project,
  titlesOf,
  useTestDatabase,
  type World,
} from "./helpers.ts";

const env = useTestDatabase();

function change(
  w: World,
  memory: Memory,
  kind: "revise" | "replace",
  content: string,
  expectedRevision = memory.revision,
) {
  return {
    memoryId: memory.id,
    expectedRevision,
    kind,
    type: memory.type,
    title: kind === "replace" ? `${memory.title}, replaced` : memory.title,
    content,
    evidenceSourceIds: [w.sources.alpha.id],
  };
}

function approve(w: World, proposal: Proposal, by = w.people.reviewer) {
  return approveProposal(env.ctx, by.id, {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
  });
}

test("a reviewed revision keeps the memory ID and every earlier version", async () => {
  const w = await buildWorld(env.ctx);
  const original = w.memories.alphaApproved;
  const proposal = await proposeChange(
    env.ctx,
    w.people.contributor.id,
    change(
      w,
      original,
      "revise",
      "Synthetic: retries now stop after 5 attempts.",
    ),
  );
  assert.equal(proposal.changeKind, "revise");
  assert.equal(proposal.targetMemoryId, original.id);
  assert.equal(proposal.baseRevision, 1);
  assert.equal(
    (await getMemory(env.ctx, w.people.reader.id, original.id)).content,
    original.content,
    "a pending change is not knowledge yet",
  );

  const revised = await approve(w, proposal);
  assert.equal(revised.id, original.id);
  assert.equal(revised.revision, 2);
  assert.match(revised.content, /5 attempts/);
  const history = await getMemoryHistory(
    env.ctx,
    w.people.reader.id,
    original.id,
  );
  assert.deepEqual(
    history.versions.map((version) => [version.revision, version.changeKind]),
    [
      [1, "new"],
      [2, "revise"],
    ],
  );
  assert.equal(history.versions[0]?.content, original.content);
});

test("a replacement retires the old memory together, keeping both histories", async () => {
  const w = await buildWorld(env.ctx);
  const old = w.memories.alphaApproved;
  const replacement = await approve(
    w,
    await proposeChange(
      env.ctx,
      w.people.contributor.id,
      change(
        w,
        old,
        "replace",
        "Synthetic: use the retry budget service instead.",
      ),
    ),
  );
  assert.notEqual(replacement.id, old.id);
  const retired = await getMemory(env.ctx, w.people.reader.id, old.id);
  assert.equal(retired.status, "superseded");
  assert.equal(retired.supersededBy, replacement.id);

  const current = titlesOf(
    await listMemories(env.ctx, w.people.reader.id, {
      scope: project(w.alpha.id),
    }),
  );
  assert.ok(current.includes(replacement.title));
  assert.ok(!current.includes(old.title), "replaced guidance is not current");
  assert.deepEqual(
    titlesOf(
      await listMemories(env.ctx, w.people.reader.id, { status: "superseded" }),
    ),
    [old.title],
  );
  const newHistory = await getMemoryHistory(
    env.ctx,
    w.people.reader.id,
    replacement.id,
  );
  assert.deepEqual(newHistory.replaces, [{ id: old.id, title: old.title }]);
  const oldHistory = await getMemoryHistory(
    env.ctx,
    w.people.reader.id,
    old.id,
  );
  assert.deepEqual(oldHistory.replacedBy, {
    id: replacement.id,
    title: replacement.title,
  });
  assert.deepEqual(
    oldHistory.statusChanges.map((item) => [item.from, item.to]),
    [["approved", "superseded"]],
  );

  await assert.rejects(
    proposeChange(
      env.ctx,
      w.people.contributor.id,
      change(w, retired, "revise", "Synthetic late edit."),
    ),
    { name: "ConflictError", message: /was replaced/ },
  );
});

test("conflicting changes are refused instead of silently overwriting each other", async () => {
  const w = await buildWorld(env.ctx);
  const memory = w.memories.alphaApproved;
  const first = await proposeChange(
    env.ctx,
    w.people.contributor.id,
    change(w, memory, "revise", "Synthetic: 4 attempts."),
  );
  const second = await proposeChange(
    env.ctx,
    w.people.ownerA.id,
    change(w, memory, "revise", "Synthetic: 6 attempts."),
  );
  const replacement = await proposeChange(
    env.ctx,
    w.people.adminA.id,
    change(w, memory, "replace", "Synthetic: no retries."),
  );
  await approve(w, first);

  await assert.rejects(approve(w, second), {
    name: "ConflictError",
    message: /now at version 2, and the proposal builds on version 1/,
  });
  await assert.rejects(approve(w, replacement), ConflictError);
  await assert.rejects(
    proposeChange(
      env.ctx,
      w.people.contributor.id,
      change(w, memory, "revise", "Synthetic: 7 attempts.", 1),
    ),
    { name: "ConflictError", message: /changed since you opened it/ },
  );

  const rebased = await editProposal(env.ctx, w.people.ownerA.id, {
    proposalId: second.id,
    expectedRevision: second.revision,
    type: second.type,
    title: second.title,
    content: second.content,
    evidenceSourceIds: second.evidence.map((item) => item.sourceId),
    ownerId: second.ownerId,
    baseRevision: 2,
  });
  assert.equal(rebased.baseRevision, 2);
  const third = await approve(w, rebased);
  assert.equal(third.revision, 3);
  assert.match(third.content, /6 attempts/);
});

test("suspended memories stop being current until a reviewer resolves them", async () => {
  const w = await buildWorld(env.ctx);
  const memory = w.memories.alphaApproved;
  const suspend = {
    memoryId: memory.id,
    expectedRevision: 1,
    reason: "Synthetic: the load test disputes it",
  };
  await assert.rejects(suspendMemory(env.ctx, w.people.agent.id, suspend), {
    name: "ForbiddenError",
    message: /Agents cannot/,
  });
  await assert.rejects(
    suspendMemory(env.ctx, w.people.reader.id, suspend),
    ForbiddenError,
  );

  const suspended = await suspendMemory(
    env.ctx,
    w.people.contributor.id,
    suspend,
  );
  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.statusReason, suspend.reason);
  assert.ok(
    !titlesOf(await listMemories(env.ctx, w.people.reader.id)).includes(
      memory.title,
    ),
    "suspended guidance is not current",
  );
  assert.equal(
    (await getMemory(env.ctx, w.people.reader.id, memory.id)).status,
    "suspended",
  );
  await assert.rejects(
    suspendMemory(env.ctx, w.people.contributor.id, suspend),
    {
      name: "ConflictError",
      message: /already suspended/,
    },
  );
  await assert.rejects(
    reinstateMemory(env.ctx, w.people.contributor.id, {
      ...suspend,
      reason: "Synthetic",
    }),
    ForbiddenError,
  );

  const reinstated = await reinstateMemory(env.ctx, w.people.reviewer.id, {
    ...suspend,
    reason: "Synthetic: rechecked, still right",
  });
  assert.equal(reinstated.status, "approved");

  await suspendMemory(env.ctx, w.people.contributor.id, suspend);
  const fixed = await approve(
    w,
    await proposeChange(
      env.ctx,
      w.people.contributor.id,
      change(w, memory, "revise", "Synthetic: corrected text."),
    ),
  );
  assert.equal(
    fixed.status,
    "approved",
    "an approved change resolves the suspension",
  );
  const history = await getMemoryHistory(
    env.ctx,
    w.people.reader.id,
    memory.id,
  );
  assert.deepEqual(
    history.statusChanges.map((item) => [item.from, item.to]),
    [
      ["approved", "suspended"],
      ["suspended", "approved"],
      ["approved", "suspended"],
      ["suspended", "approved"],
    ],
  );
  assert.match(
    history.statusChanges.at(-1)?.reason ?? "",
    /Resolved by approving version 2/,
  );
});

test("agents and readers may report outdated guidance, which changes nothing until a person acts", async () => {
  const w = await buildWorld(env.ctx);
  const memory = w.memories.alphaApproved;
  const agentReport = await reportOutdated(env.ctx, w.people.agent.id, {
    memoryId: memory.id,
    reason: "Synthetic: the retry library changed defaults",
  });
  await reportOutdated(env.ctx, w.people.reader.id, {
    memoryId: memory.id,
    reason: "Synthetic: I saw 5 retries in the code",
  });
  assert.equal(
    (await getMemory(env.ctx, w.people.reader.id, memory.id)).status,
    "approved",
  );
  await assert.rejects(
    reportOutdated(env.ctx, w.people.outsider.id, {
      memoryId: memory.id,
      reason: "Synthetic",
    }),
    NotFoundError,
  );

  await assert.rejects(
    dismissReport(env.ctx, w.people.contributor.id, {
      reportId: agentReport.id,
      reason: "Synthetic",
    }),
    ForbiddenError,
  );
  const dismissed = await dismissReport(env.ctx, w.people.reviewer.id, {
    reportId: agentReport.id,
    reason: "Synthetic: defaults are pinned",
  });
  assert.equal(dismissed.resolution, "dismissed");
  assert.equal(dismissed.resolutionNote, "Synthetic: defaults are pinned");

  await approve(
    w,
    await proposeChange(
      env.ctx,
      w.people.contributor.id,
      change(w, memory, "revise", "Synthetic: 5 retries."),
    ),
  );
  const history = await getMemoryHistory(
    env.ctx,
    w.people.reader.id,
    memory.id,
  );
  assert.deepEqual(history.reports.map((report) => report.resolution).sort(), [
    "dismissed",
    "revised",
  ]);
});

test("an earlier version comes back only through a new reviewed version", async () => {
  const w = await buildWorld(env.ctx);
  const original = w.memories.alphaApproved;
  await approve(
    w,
    await proposeChange(
      env.ctx,
      w.people.contributor.id,
      change(w, original, "revise", "Synthetic: a wrong change."),
    ),
  );
  await assert.rejects(
    proposeRestore(env.ctx, w.people.contributor.id, {
      memoryId: original.id,
      expectedRevision: 2,
      fromRevision: 2,
    }),
    ValidationError,
  );
  const restore = await proposeRestore(env.ctx, w.people.contributor.id, {
    memoryId: original.id,
    expectedRevision: 2,
    fromRevision: 1,
  });
  assert.equal(restore.changeKind, "restore");
  assert.equal(restore.content, original.content);
  assert.equal(
    (await getMemory(env.ctx, w.people.reader.id, original.id)).revision,
    2,
    "nothing changes before review",
  );

  const restored = await approve(w, restore);
  assert.equal(restored.revision, 3);
  assert.equal(restored.content, original.content);
  const history = await getMemoryHistory(
    env.ctx,
    w.people.reader.id,
    original.id,
  );
  assert.equal(history.versions.at(-1)?.changeKind, "restore");
  assert.equal(history.versions.at(-1)?.restoredFromRevision, 1);
});

test("history leaves out the text of a version whose evidence the caller cannot read", async () => {
  const w = await buildWorld(env.ctx);
  await connectRepository(env.ctx, w.people.adminA.id, {
    projectId: w.alpha.id,
    provider: "github",
    externalRepositoryId: "1005",
    fullName: "synthetic-org-a/alpha-docs",
  });
  for (const principal of [w.people.contributor, w.people.ownerA]) {
    await recordRepositoryAccess(env.ctx, {
      principalId: principal.id,
      provider: "github",
      externalRepositoryId: "1005",
      canRead: true,
    });
  }
  const hidden = await recordSource(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    provider: "github",
    externalRepositoryId: "1005",
    reference: "pull/5",
    url: "https://github.com/synthetic-org-a/alpha-docs/pull/5",
    excerpt: "Synthetic private excerpt.",
  });
  const first = await approve(
    w,
    await proposeMemory(env.ctx, w.people.contributor.id, {
      projectId: w.alpha.id,
      type: "lesson",
      title: "Synthetic private lesson",
      content: "Synthetic text drawn from private docs.",
      evidenceSourceIds: [hidden.id],
    }),
    w.people.ownerA,
  );
  await assert.rejects(
    getMemoryHistory(env.ctx, w.people.reviewer.id, first.id),
    NotFoundError,
  );
  await approve(
    w,
    await proposeChange(env.ctx, w.people.contributor.id, {
      ...change(
        w,
        first,
        "revise",
        "Synthetic text backed by the public pull request.",
      ),
      title: "Synthetic public lesson",
    }),
    w.people.ownerA,
  );
  const history = await getMemoryHistory(
    env.ctx,
    w.people.reviewer.id,
    first.id,
  );
  assert.equal(history.versions[0]?.readable, false);
  assert.equal(history.versions[0]?.content, null);
  assert.equal(history.versions[1]?.title, "Synthetic public lesson");
});
