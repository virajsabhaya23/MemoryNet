import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveProposal,
  createContext,
  getContext,
  listRetrievals,
  NotFoundError,
  proposeChange,
  proposeMemory,
  recordRepositoryAccess,
  recordSource,
  suspendMemory,
  UnavailableError,
  ValidationError,
  type Database,
  type Memory,
  type MemoryType,
  type Principal,
} from "../src/index.ts";
import {
  ACCESS_MAX_AGE_MS,
  buildWorld,
  START,
  useTestDatabase,
  type World,
} from "./helpers.ts";

const env = useTestDatabase();

async function remember(
  w: World,
  title: string,
  content: string,
  type: MemoryType = "decision",
  evidenceSourceIds = [w.sources.alpha.id],
): Promise<Memory> {
  const proposal = await proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    type,
    title,
    content,
    evidenceSourceIds,
  });
  return approveProposal(env.ctx, w.people.reviewer.id, {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
  });
}

function search(w: World, who: Principal, query: string, limit?: number) {
  return getContext(env.ctx, who.id, {
    projectId: w.alpha.id,
    query,
    ...(limit === undefined ? {} : { limit }),
  });
}

async function retrievalCount(): Promise<number> {
  const { rows } = await env.db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM retrievals",
  );
  return rows[0]?.count ?? 0;
}

test("search returns matching current knowledge, best match first, with its ID, version, and evidence", async () => {
  const w = await buildWorld(env.ctx);
  const cache = await remember(
    w,
    "Checkout keeps the session cache",
    "Removing the session cache doubled checkout latency in staging.",
  );
  await remember(
    w,
    "Load tests run before every release",
    "A load test found the payment queue filling up.",
    "lesson",
  );

  const response = await search(
    w,
    w.people.reader,
    "Why do we keep the session cache?",
  );
  assert.equal(response.outcome, "results");
  assert.deepEqual(
    response.current.map((item) => item.title),
    ["Checkout keeps the session cache"],
    "only memories sharing a word with the search are returned",
  );
  const [found] = response.current;
  assert.equal(found?.memoryId, cache.id);
  assert.equal(found?.revision, 1);
  assert.equal(found?.type, "decision");
  assert.equal(found?.content, cache.content);
  assert.equal(found?.shortened, false);
  assert.equal(found?.ownerId, w.people.contributor.id);
  assert.equal(found?.approvedBy, w.people.reviewer.id);
  assert.deepEqual(
    found?.citations.map((item) => [item.reference, item.url, item.revision]),
    [
      [
        "pull/11",
        "https://github.com/synthetic-org-a/alpha-service/pull/11",
        "0123456789abcdef0123456789abcdef01234567",
      ],
    ],
  );
  assert.equal(response.notCurrent.length, 0);
  assert.equal(response.moreMatches, false);

  const stemmed = await search(w, w.people.reader, "retrying queues");
  assert.equal(
    stemmed.current[0]?.title,
    "Alpha uses queue retries",
    "different forms of a word match, and more matching words rank higher",
  );
  assert.ok(
    (await search(w, w.people.reader, "PR #11")).current.length >= 3,
    "a cited pull request number finds the memories that cite it",
  );
});

test("pending proposals, other projects, and other organizations stay out of search", async () => {
  const w = await buildWorld(env.ctx);
  const pending = await search(w, w.people.contributor, "drop the cache");
  assert.equal(pending.outcome, "no_results");
  assert.deepEqual(pending.current, [], "a proposal is not knowledge");

  const elsewhere = await search(w, w.people.orgReader, "SDK nightly exports");
  assert.equal(
    elsewhere.outcome,
    "no_results",
    "beta's and delta's knowledge is not in alpha",
  );
  const beta = await getContext(env.ctx, w.people.orgReader.id, {
    projectId: w.beta.id,
    query: "SDK version",
  });
  assert.deepEqual(
    beta.current.map((item) => item.title),
    ["Beta pins the SDK version"],
  );

  for (const [who, projectId] of [
    [w.people.reader, w.beta.id],
    [w.people.outsider, w.alpha.id],
    [w.people.reviewerB, w.alpha.id],
    [w.people.ownerA, w.delta.id],
  ] as const) {
    await assert.rejects(
      getContext(env.ctx, who.id, { projectId, query: "anything at all" }),
      NotFoundError,
      "a project without a role looks the same as no project",
    );
  }
  assert.equal(await retrievalCount(), 3, "refused searches leave no record");
});

test("suspended and replaced knowledge is listed as not current, without its text, pointing to its replacement", async () => {
  const w = await buildWorld(env.ctx);
  const library = await remember(
    w,
    "Queue calls use the retry library",
    "Every queue call goes through the shared retry library.",
  );
  const old = w.memories.alphaApproved;
  const change = await proposeChange(env.ctx, w.people.contributor.id, {
    memoryId: old.id,
    expectedRevision: old.revision,
    kind: "replace",
    type: "decision",
    title: "Alpha uses the retry budget service",
    content: "Queue retries now come from the retry budget service.",
    evidenceSourceIds: [w.sources.alpha.id],
  });
  const replacement = await approveProposal(env.ctx, w.people.reviewer.id, {
    proposalId: change.id,
    expectedRevision: change.revision,
  });
  await suspendMemory(env.ctx, w.people.contributor.id, {
    memoryId: library.id,
    expectedRevision: 1,
    reason: "The retry library is being reviewed",
  });

  const response = await search(w, w.people.reader, "queue retries");
  assert.deepEqual(
    response.current.map((item) => item.memoryId),
    [replacement.id],
    "only current guidance is supplied",
  );
  const byId = new Map(
    response.notCurrent.map((item) => [item.memoryId, item]),
  );
  assert.equal(byId.size, 2);
  const replaced = byId.get(old.id);
  assert.equal(replaced?.status, "superseded");
  assert.deepEqual(replaced?.replacedBy, {
    memoryId: replacement.id,
    revision: 1,
    title: "Alpha uses the retry budget service",
    status: "approved",
  });
  const suspended = byId.get(library.id);
  assert.equal(suspended?.status, "suspended");
  assert.equal(suspended?.reason, "The retry library is being reviewed");
  assert.equal(suspended?.replacedBy, null);
  for (const item of response.notCurrent) {
    assert.ok(!("content" in item), "retired text is never supplied");
  }

  const [record] = await listRetrievals(env.ctx, w.people.reader.id, {
    projectId: w.alpha.id,
  });
  assert.deepEqual(
    record?.items.map((item) => [item.memoryId, item.revision, item.status]),
    [
      [replacement.id, 1, "approved"],
      ...response.notCurrent.map((item) => [
        item.memoryId,
        item.revision,
        item.status,
      ]),
    ],
  );
});

test("losing access to the evidence hides a memory from search and from earlier records", async () => {
  const w = await buildWorld(env.ctx);
  const before = await search(w, w.people.reader, "queue retries");
  assert.equal(before.current[0]?.memoryId, w.memories.alphaApproved.id);

  env.advance(1000);
  await recordRepositoryAccess(env.ctx, {
    principalId: w.people.reader.id,
    provider: "github",
    externalRepositoryId: "1001",
    canRead: false,
  });
  const after = await search(w, w.people.reader, "queue retries");
  assert.equal(after.outcome, "no_results");

  const own = await listRetrievals(env.ctx, w.people.reader.id, {
    projectId: w.alpha.id,
  });
  assert.equal(own.length, 2);
  assert.deepEqual(
    own.map((record) => record.items.length),
    [0, 0],
    "what was returned earlier is hidden once its evidence is not readable",
  );
  const admin = await listRetrievals(env.ctx, w.people.adminA.id, {
    projectId: w.alpha.id,
  });
  assert.deepEqual(
    admin.map((record) => record.items.map((item) => item.title)),
    [[], ["Alpha uses queue retries"]],
    "an administrator who can read it still sees it",
  );
});

test("no results and failures are told apart, and both are recorded", async () => {
  const w = await buildWorld(env.ctx);
  const none = await search(w, w.people.reader, "zebra crossing");
  assert.equal(none.outcome, "no_results");
  assert.deepEqual([none.current, none.notCurrent], [[], []]);

  const db = env.db;
  const broken: Database = {
    query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params),
    exec: (sql: string) => db.exec(sql),
    transaction: async () => {
      throw new Error("Synthetic database outage");
    },
    close: async () => undefined,
  };
  const outage = createContext(broken, {
    now: () => env.ctx.now(),
    repositoryAccessMaxAgeMs: ACCESS_MAX_AGE_MS,
  });
  env.advance(1000);
  await assert.rejects(
    getContext(outage, w.people.reader.id, {
      projectId: w.alpha.id,
      query: "queue retries",
    }),
    (error: unknown) =>
      error instanceof UnavailableError &&
      error.code === "unavailable" &&
      /not the same as finding nothing/.test(error.message),
  );

  const records = await listRetrievals(env.ctx, w.people.reader.id, {
    projectId: w.alpha.id,
  });
  assert.deepEqual(
    records.map((record) => [record.failed, record.terms, record.items]),
    [
      [true, null, []],
      [false, "'zebra' | 'cross'", []],
    ],
  );
});

test("each retrieval records who, when, the searched words, and every version returned; administrators see everyone's", async () => {
  const w = await buildWorld(env.ctx);
  await search(w, w.people.reader, "queue retries");
  env.advance(1000);
  await search(w, w.people.agent, "queue");
  env.advance(1000);
  await search(w, w.people.contributor, "session cache");

  const own = await listRetrievals(env.ctx, w.people.reader.id, {
    projectId: w.alpha.id,
  });
  assert.equal(own.length, 1);
  assert.equal(own[0]?.callerId, w.people.reader.id);
  assert.equal(own[0]?.terms, "'queue' | 'retri'");
  assert.equal(own[0]?.failed, false);
  assert.deepEqual(own[0]?.retrievedAt, START);
  assert.deepEqual(own[0]?.items, [
    {
      memoryId: w.memories.alphaApproved.id,
      revision: 1,
      status: "approved",
      title: "Alpha uses queue retries",
    },
  ]);
  assert.deepEqual(
    (
      await listRetrievals(env.ctx, w.people.agent.id, {
        projectId: w.alpha.id,
      })
    ).map((record) => record.callerId),
    [w.people.agent.id],
    "agents see their own records",
  );
  assert.deepEqual(
    await listRetrievals(env.ctx, w.people.reviewer.id, {
      projectId: w.alpha.id,
    }),
    [],
    "reviewers see only their own",
  );
  for (const admin of [w.people.adminA, w.people.buAdmin, w.people.ownerA]) {
    assert.deepEqual(
      (await listRetrievals(env.ctx, admin.id, { projectId: w.alpha.id })).map(
        (record) => record.callerId,
      ),
      [w.people.contributor.id, w.people.agent.id, w.people.reader.id],
      "administrators and owners see everyone's, newest first",
    );
  }
  for (const who of [w.people.outsider, w.people.ownerB]) {
    await assert.rejects(
      listRetrievals(env.ctx, who.id, { projectId: w.alpha.id }),
      NotFoundError,
    );
  }
});

test("responses stay small: results, text, and evidence are bounded", async () => {
  const w = await buildWorld(env.ctx);
  const extra = [];
  for (const pull of [12, 13, 14, 15]) {
    extra.push(
      await recordSource(env.ctx, w.people.contributor.id, {
        projectId: w.alpha.id,
        provider: "github",
        externalRepositoryId: "1001",
        reference: `pull/${pull}`,
        url: `https://github.com/synthetic-org-a/alpha-service/pull/${pull}`,
        excerpt: `Synthetic budget discussion ${pull}. ${"More detail. ".repeat(60)}`,
      }),
    );
  }
  const wide = await remember(
    w,
    "Budget service owns every retry",
    `The budget service decides retries. ${"Background detail. ".repeat(150)}`,
    "decision",
    [w.sources.alpha.id, ...extra.map((source) => source.id)],
  );
  for (let index = 1; index <= 9; index += 1) {
    await remember(
      w,
      `Budget rule ${index}`,
      `Synthetic budget rule number ${index}.`,
    );
  }

  const response = await search(w, w.people.reader, "budget");
  assert.equal(response.current.length, 8, "eight results by default");
  assert.equal(response.moreMatches, true);
  const first = response.current.find((item) => item.memoryId === wide.id);
  assert.ok(first, "the memory with the word in its title is among them");
  assert.equal(first.shortened, true);
  assert.ok(first.content.length <= 1500);
  assert.equal(first.citations.length, 3);
  assert.equal(first.moreCitations, 2);
  const long = first.citations.find((item) => item.reference !== "pull/11");
  assert.equal(long?.shortened, true);
  assert.ok((long?.excerpt.length ?? 0) <= 400);

  assert.equal(
    (await search(w, w.people.reader, "budget", 3)).current.length,
    3,
  );
  await assert.rejects(
    search(w, w.people.reader, "budget", 21),
    ValidationError,
  );
});

test("searches are checked before anything is searched or recorded", async () => {
  const w = await buildWorld(env.ctx);
  for (const query of [
    "",
    "the of and why",
    "password=hunter2secret",
    "x".repeat(201),
  ]) {
    await assert.rejects(search(w, w.people.reader, query), ValidationError);
  }
  assert.equal(await retrievalCount(), 0);

  const personal = await search(
    w,
    w.people.reader,
    "queue retries jane.doe@example.com",
  );
  assert.equal(personal.outcome, "results");
  const [record] = await listRetrievals(env.ctx, w.people.reader.id, {
    projectId: w.alpha.id,
  });
  assert.equal(
    record?.terms,
    null,
    "words that may hold personal data are not recorded",
  );
  assert.equal(record?.items.length, 1, "what was returned still is");
});

test("retrieval records cannot be changed afterwards", async () => {
  const w = await buildWorld(env.ctx);
  const response = await search(w, w.people.reader, "queue retries");
  await assert.rejects(
    env.db.query("UPDATE retrievals SET outcome = 'failed' WHERE id = $1", [
      response.retrievalId,
    ]),
    /append-only/,
  );
  await assert.rejects(
    env.db.query("DELETE FROM retrieval_items WHERE retrieval_id = $1", [
      response.retrievalId,
    ]),
    /append-only/,
  );
});
