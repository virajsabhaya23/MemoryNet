import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveProposal,
  captureMergedPullRequest,
  ConflictError,
  exportKnowledge,
  getMemory,
  getProposal,
  getSource,
  handleRepositoryRemoved,
  NotFoundError,
  proposeMemory,
  recordSource,
  rejectProposal,
  SECRET_PLACEHOLDER,
  ValidationError,
  type MergedPullRequestEvent,
  type Source,
} from "../src/index.ts";
import { buildWorld, project, useTestDatabase } from "./helpers.ts";

const env = useTestDatabase();

const MERGE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const ALPHA_PULLS = "https://github.com/synthetic-org-a/alpha-service/pull";
const TITLE = "Synthetic: cap queue retries at five";
// Fake values. The key block is assembled at runtime so secret scanners do not flag this file.
const FAKE_PASSWORD = "Zq9-synthetic-Passw0rd-0000";
const FAKE_KEY_MATERIAL = "SYNTHETICFAKEKEYMATERIAL0000";
const FAKE_KEY_BLOCK = [
  ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
  FAKE_KEY_MATERIAL,
  ["-----END", "PRIVATE", "KEY-----"].join(" "),
].join("\n");

function mergedPullRequest(
  overrides: Partial<MergedPullRequestEvent> = {},
): MergedPullRequestEvent {
  return {
    provider: "github",
    externalRepositoryId: "1001",
    pullRequestNumber: 51,
    url: `${ALPHA_PULLS}/51`,
    mergeCommitSha: MERGE_SHA,
    title: TITLE,
    body: "Synthetic description: unbounded retries overloaded the queue.",
    ...overrides,
  };
}

async function capture(
  overrides: Partial<MergedPullRequestEvent> = {},
): Promise<Source> {
  const result = await captureMergedPullRequest(
    env.ctx,
    mergedPullRequest(overrides),
  );
  assert.ok(
    result.status === "captured",
    `expected a capture: ${result.status}`,
  );
  return result.source;
}

async function countSources(reference: string): Promise<number> {
  const { rows } = await env.db.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM sources WHERE reference = $1",
    [reference],
  );
  return rows[0]?.count ?? 0;
}

test("a merged pull request becomes one source, however often its event arrives", async () => {
  const w = await buildWorld(env.ctx);
  const source = await capture();
  assert.equal(source.projectId, w.alpha.id);
  assert.equal(source.reference, "pull/51");
  assert.equal(source.url, `${ALPHA_PULLS}/51`);
  assert.equal(source.revision, MERGE_SHA);
  assert.equal(source.captureMethod, "github_app");
  assert.equal(source.capturedBy, null);
  assert.deepEqual(source.flags, []);
  assert.equal(
    source.excerpt,
    `${TITLE}\n\nSynthetic description: unbounded retries overloaded the queue.`,
  );

  env.advance(60_000);
  for (const event of [
    mergedPullRequest(),
    mergedPullRequest({ title: "Synthetic: title edited after the merge" }),
  ]) {
    assert.deepEqual(await captureMergedPullRequest(env.ctx, event), {
      status: "duplicate",
      sourceId: source.id,
    });
  }
  assert.equal(await countSources("pull/51"), 1);
  assert.deepEqual(
    await getSource(env.ctx, w.people.reader.id, source.id),
    source,
    "later events never change captured evidence",
  );

  const simultaneous = await Promise.all(
    [1, 2].map(() =>
      captureMergedPullRequest(
        env.ctx,
        mergedPullRequest({ pullRequestNumber: 52, url: `${ALPHA_PULLS}/52` }),
      ),
    ),
  );
  assert.deepEqual(simultaneous.map((result) => result.status).sort(), [
    "captured",
    "duplicate",
  ]);
  assert.equal(await countSources("pull/52"), 1);

  const proposal = await proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    type: "decision",
    title: "Queue retries stop after five attempts",
    content: "Synthetic: the merged change caps retries at five.",
    evidenceSourceIds: [source.id],
  });
  const memory = await approveProposal(env.ctx, w.people.reviewer.id, {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
  });
  const retrieved = await getMemory(env.ctx, w.people.reader.id, memory.id);
  assert.deepEqual(
    retrieved.evidence.map((e) => [e.sourceId, e.revision]),
    [[source.id, MERGE_SHA]],
  );

  const audit = await env.db.query<{ actor_id: string | null }>(
    "SELECT actor_id FROM audit_events WHERE action = 'source.captured'",
  );
  assert.deepEqual(
    audit.rows,
    [{ actor_id: null }, { actor_id: null }],
    "each capture is audited once, as a system action",
  );
});

test("only merged pull requests from connected repositories are captured", async () => {
  const w = await buildWorld(env.ctx);
  assert.deepEqual(
    await captureMergedPullRequest(
      env.ctx,
      mergedPullRequest({
        externalRepositoryId: "1009",
        url: "https://github.com/synthetic-org-a/unselected/pull/51",
      }),
    ),
    { status: "ignored", reason: "repository_not_connected" },
  );
  for (const malformed of [
    { mergeCommitSha: "not-a-sha" },
    { mergeCommitSha: "" },
    { url: "http://github.com/synthetic-org-a/alpha-service/pull/51" },
    { url: `${ALPHA_PULLS}/52` },
    { url: "https://docs.example.test/synthetic-org-a/alpha-service/pull/51" },
    { pullRequestNumber: 0 },
    { title: "  \n " },
  ]) {
    await assert.rejects(
      captureMergedPullRequest(env.ctx, mergedPullRequest(malformed)),
      ValidationError,
    );
  }
  assert.equal(await countSources("pull/51"), 0);

  const source = await capture();
  await handleRepositoryRemoved(env.ctx, {
    provider: "github",
    externalRepositoryId: "1001",
    reason: "App uninstalled",
  });
  await assert.rejects(
    getSource(env.ctx, w.people.reader.id, source.id),
    NotFoundError,
  );
  assert.deepEqual(
    await captureMergedPullRequest(
      env.ctx,
      mergedPullRequest({ pullRequestNumber: 53, url: `${ALPHA_PULLS}/53` }),
    ),
    { status: "ignored", reason: "repository_not_connected" },
  );
});

test("capture binds source URLs to the connected repository before storing or accepting a replay", async () => {
  const w = await buildWorld(env.ctx);
  const wrongRepository = mergedPullRequest({
    url: "https://github.com/synthetic-org-a/beta-service/pull/51",
  });
  await assert.rejects(
    captureMergedPullRequest(env.ctx, wrongRepository),
    ValidationError,
  );
  assert.equal(await countSources("pull/51"), 0);

  const source = await capture();
  await assert.rejects(
    captureMergedPullRequest(env.ctx, wrongRepository),
    ValidationError,
    "an existing source must not bypass repository binding",
  );
  assert.equal(await countSources("pull/51"), 1);
  assert.deepEqual(await getSource(env.ctx, w.people.reader.id, source.id), source);
  assert.deepEqual(await captureMergedPullRequest(env.ctx, mergedPullRequest()), {
    status: "duplicate",
    sourceId: source.id,
  });

  await handleRepositoryRemoved(env.ctx, {
    provider: "github",
    externalRepositoryId: "1001",
    reason: "App uninstalled",
  });
  assert.deepEqual(await captureMergedPullRequest(env.ctx, mergedPullRequest()), {
    status: "ignored",
    reason: "repository_not_connected",
  });
});

test("secrets are never stored", async () => {
  const w = await buildWorld(env.ctx);
  const source = await capture({
    body: `Rotated the service login.\npassword = ${FAKE_PASSWORD}\n${FAKE_KEY_BLOCK}\nNo other changes.`,
  });
  assert.deepEqual(source.flags, ["secret_removed"]);
  assert.equal(
    source.excerpt,
    `${TITLE}\n\nRotated the service login.\npassword = ${SECRET_PLACEHOLDER}\n${SECRET_PLACEHOLDER}\nNo other changes.`,
  );

  await assert.rejects(
    recordSource(env.ctx, w.people.contributor.id, {
      projectId: w.alpha.id,
      provider: "github",
      externalRepositoryId: "1001",
      reference: "pull/61",
      url: `${ALPHA_PULLS}/61`,
      excerpt: `Synthetic comment: use token: ${FAKE_PASSWORD}`,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.match(error.message, /secret \(password or key\)/);
      assert.ok(!error.message.includes(FAKE_PASSWORD), "never repeats it");
      return true;
    },
  );
  await assert.rejects(
    proposeMemory(env.ctx, w.people.contributor.id, {
      projectId: w.alpha.id,
      type: "constraint",
      title: "Synthetic database login",
      content: `Connect with postgres://svc:${FAKE_PASSWORD}@db.example.test/app`,
      evidenceSourceIds: [source.id],
    }),
    { name: "ValidationError", message: /secret \(password in a link\)/ },
  );

  for (const secret of [FAKE_PASSWORD, FAKE_KEY_MATERIAL]) {
    const { rows } = await env.db.query<{ found: number }>(
      `SELECT ((SELECT COUNT(*) FROM sources WHERE strpos(excerpt, $1) > 0)
             + (SELECT COUNT(*) FROM memory_proposals WHERE strpos(content, $1) > 0)
             + (SELECT COUNT(*) FROM audit_events WHERE strpos(details::text, $1) > 0))::int
         AS found`,
      [secret],
    );
    assert.equal(rows[0]?.found, 0);
  }
  const audit = await env.db.query<{ details: Record<string, unknown> }>(
    "SELECT details FROM audit_events WHERE action = 'source.captured'",
  );
  assert.deepEqual(
    audit.rows.map((row) => row.details),
    [{ reference: "pull/51", contentFlags: "secret_removed" }],
  );
});

test("possible personal data is kept but flagged for reviewers", async () => {
  const w = await buildWorld(env.ctx);
  const comment = await recordSource(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    provider: "github",
    externalRepositoryId: "1001",
    reference: "pull/61",
    url: `${ALPHA_PULLS}/61#issuecomment-1`,
    excerpt: "Synthetic comment: page synthetic.oncall@example.test first.",
  });
  assert.deepEqual(comment.flags, ["personal_data"]);
  assert.match(comment.excerpt, /synthetic\.oncall@example\.test/);

  const proposal = await proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    type: "lesson",
    title: "Page the on-call person before retrying",
    content: "Synthetic: call (555) 555-0100 before retrying by hand.",
    evidenceSourceIds: [comment.id],
  });
  assert.deepEqual(proposal.flags, ["personal_data"]);
  const seen = await getProposal(env.ctx, w.people.reviewer.id, proposal.id);
  assert.deepEqual(seen.flags, ["personal_data"]);
  assert.deepEqual(
    seen.evidence.map((e) => e.flags),
    [["personal_data"]],
    "reviewers see the flags of each cited source too",
  );

  const labeled = await capture({
    body: "Synthetic: fixed the lookup for MRN: SYN0000001.",
  });
  assert.deepEqual(labeled.flags, ["personal_data"]);
  const plain = await capture({
    pullRequestNumber: 52,
    url: `${ALPHA_PULLS}/52`,
    body: "Synthetic: version 2.4.1 keeps 3 retries since 2026-09-24.",
  });
  assert.deepEqual(plain.flags, []);
  assert.deepEqual(w.sources.alpha.flags, []);
  assert.deepEqual(w.proposals.alphaPending.flags, []);
});

test("captured text beyond the excerpt limit is cut and flagged", async () => {
  await buildWorld(env.ctx);
  const long = await capture({
    body: "Synthetic line about retries.\n".repeat(200),
  });
  assert.deepEqual(long.flags, ["truncated"]);
  assert.ok(long.excerpt.length <= 4000 && long.excerpt.length > 3900);
  assert.ok(long.excerpt.startsWith(`${TITLE}\n\n`));

  const label = "\npassword = ";
  const filler = "x".repeat(4000 - `${TITLE}\n\n`.length - label.length - 3);
  const straddling = await capture({
    pullRequestNumber: 52,
    url: `${ALPHA_PULLS}/52`,
    body: `${filler}${label}${FAKE_PASSWORD}`,
  });
  assert.deepEqual(straddling.flags, ["secret_removed", "truncated"]);
  assert.ok(
    !straddling.excerpt.includes(FAKE_PASSWORD.slice(0, 3)),
    "no piece of a secret survives the cut",
  );
});

test("manual evidence must be a pull request in the connected repository", async () => {
  const w = await buildWorld(env.ctx);
  const input = {
    projectId: w.alpha.id,
    provider: "github" as const,
    externalRepositoryId: "1001",
    reference: "pull/61",
    url: `${ALPHA_PULLS}/61`,
    excerpt: "Synthetic review comment.",
  };
  for (const unsupported of [
    {
      reference: "issues/61",
      url: "https://github.com/synthetic-org-a/alpha-service/issues/61",
    },
    { reference: "commit/0123abc" },
    { reference: "Synthetic chat thread" },
    { url: "https://github.com/synthetic-org-a/beta-service/pull/61" },
    { url: `${ALPHA_PULLS}/62` },
    { url: "https://docs.example.test/synthetic-org-a/alpha-service/pull/61" },
  ]) {
    await assert.rejects(
      recordSource(env.ctx, w.people.contributor.id, {
        ...input,
        ...unsupported,
      }),
      ValidationError,
    );
  }
  const comment = await recordSource(env.ctx, w.people.contributor.id, {
    ...input,
    url: "https://github.com/Synthetic-Org-A/alpha-service/pull/61/files#r1",
  });
  assert.equal(comment.reference, "pull/61");
  assert.equal(comment.captureMethod, "manual");
  assert.equal(comment.capturedBy, w.people.contributor.id);
});

test("recording the same evidence again keeps one source", async () => {
  const w = await buildWorld(env.ctx);
  const first = w.sources.alpha;
  const input = {
    projectId: w.alpha.id,
    provider: "github" as const,
    externalRepositoryId: "1001",
    reference: first.reference,
    url: first.url,
    revision: first.revision ?? undefined,
    excerpt: first.excerpt,
  };
  assert.deepEqual(
    await recordSource(env.ctx, w.people.reviewer.id, input),
    first,
  );
  const other = await recordSource(env.ctx, w.people.reviewer.id, {
    ...input,
    excerpt: "Synthetic: a different comment on the same pull request.",
  });
  assert.notEqual(other.id, first.id);
  assert.equal(await countSources("pull/11"), 2);
  const withoutRevision = { ...input, revision: undefined };
  assert.equal(
    (await recordSource(env.ctx, w.people.reviewer.id, withoutRevision)).id,
    (await recordSource(env.ctx, w.people.contributor.id, withoutRevision)).id,
    "evidence without a revision is also stored once",
  );
  assert.equal(await countSources("pull/11"), 3);
  const { rows } = await env.db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM audit_events
     WHERE action = 'source.recorded' AND target_id = $1`,
    [first.id],
  );
  assert.equal(rows[0]?.count, 1);
});

test("a copy of pending or approved knowledge is refused", async () => {
  const w = await buildWorld(env.ctx);
  const pending = w.proposals.alphaPending;
  const copy = {
    projectId: w.alpha.id,
    type: "lesson" as const,
    title: `  ${pending.title.toLowerCase()}  `,
    content: pending.content.toUpperCase().replaceAll(" ", "\n "),
    evidenceSourceIds: [w.sources.alpha.id],
  };
  await assert.rejects(proposeMemory(env.ctx, w.people.reviewer.id, copy), {
    name: "ConflictError",
    message: new RegExp(`waiting for review \\(proposal ${pending.id}\\)`),
  });

  // Agents cannot see pending proposals, so the copy waits for reviewers instead of revealing one.
  const agentCopy = await proposeMemory(env.ctx, w.people.agent.id, {
    ...copy,
    ownerId: w.people.contributor.id,
  });
  assert.equal(agentCopy.status, "pending");
  await assert.rejects(
    proposeMemory(env.ctx, w.people.agent.id, {
      ...copy,
      ownerId: w.people.contributor.id,
    }),
    ConflictError,
    "an agent repeating its own proposal is refused",
  );

  const approved = w.memories.alphaApproved;
  await assert.rejects(
    proposeMemory(env.ctx, w.people.contributor.id, {
      ...copy,
      title: approved.title,
      content: approved.content,
    }),
    { name: "ConflictError", message: new RegExp(`memory ${approved.id}`) },
  );

  for (const proposal of [pending, agentCopy]) {
    await rejectProposal(env.ctx, w.people.reviewer.id, {
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
      reason: "Synthetic: not needed",
    });
  }
  const retried = await proposeMemory(env.ctx, w.people.contributor.id, copy);
  assert.equal(retried.status, "pending", "rejected proposals block nothing");
  const reworded = await proposeMemory(env.ctx, w.people.contributor.id, {
    ...copy,
    content: "Synthetic: different wording is not treated as a copy.",
  });
  assert.equal(reworded.status, "pending");
});

test("exports show how each source was captured and its flags", async () => {
  const w = await buildWorld(env.ctx);
  const captured = await capture({
    body: `Synthetic: rotated keys.\npassword = ${FAKE_PASSWORD}`,
  });
  const proposal = await proposeMemory(env.ctx, w.people.contributor.id, {
    projectId: w.alpha.id,
    type: "incident",
    title: "Synthetic key rotation",
    content: "Synthetic: keys were rotated after the merge.",
    evidenceSourceIds: [captured.id],
  });
  await approveProposal(env.ctx, w.people.reviewer.id, {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
  });
  const exported = await exportKnowledge(env.ctx, w.people.adminA.id, {
    scope: project(w.alpha.id),
  });
  assert.equal(exported.formatVersion, 3);
  assert.deepEqual(
    exported.sources.map(({ id, captureMethod, capturedBy, flags }) => ({
      id,
      captureMethod,
      capturedBy,
      flags,
    })),
    [
      {
        id: captured.id,
        captureMethod: "github_app",
        capturedBy: null,
        flags: ["secret_removed"],
      },
      {
        id: w.sources.alpha.id,
        captureMethod: "manual",
        capturedBy: w.people.contributor.id,
        flags: [],
      },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
  assert.ok(!JSON.stringify(exported).includes(FAKE_PASSWORD));
});

test("the database keeps one captured source per pull request and knows who recorded the rest", async () => {
  const w = await buildWorld(env.ctx);
  const source = await capture();
  const insert = (capturedBy: string | null, method: string) =>
    env.db.query(
      `INSERT INTO sources (project_id, provider, external_repository_id, reference, url,
                            excerpt, captured_by, captured_at, capture_method)
       VALUES ($1, 'github', '1001', 'pull/51', $2, 'Synthetic.', $3, now(), $4)`,
      [w.alpha.id, source.url, capturedBy, method],
    );
  await assert.rejects(insert(null, "github_app"), /unique constraint/);
  await assert.rejects(
    insert(w.people.contributor.id, "github_app"),
    /check constraint/,
  );
  await assert.rejects(insert(null, "manual"), /check constraint/);
});
