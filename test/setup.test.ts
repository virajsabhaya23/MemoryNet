import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readAgentBindingFile } from "../src/agent-context/binding.ts";
import { getAgentTaskContext, proposeAgentMemory } from "../src/agent-context/service.ts";
import { mcpServerEntry, renderClientConfig, writeClientConfig } from "../src/client-config.ts";
import { approveProposal, createContext, getOrganizationTree, listRoleAssignments, openDatabase, recordRepositoryAccess, ValidationError, verifyLedger } from "../src/index.ts";
import { LOCAL_ACCESS_MAX_AGE_MS, parseGithubRemote, renewLocalAccess, setupWorkspace } from "../src/setup.ts";
import { readWorkspaceProfile } from "../src/workspace.ts";

async function workspace() {
  const folder = await mkdtemp(join(tmpdir(), "memorynet-setup-"));
  const options = {
    dataDir: join(folder, "data"), bindingFile: join(folder, "local", "binding.json"), profilePath: join(folder, "local", "workspace.json"),
    repository: { fullName: "synthetic-org/payments-api", id: "424242", branch: "main" },
    operatorName: "Synthetic Operator", reviewerNames: ["Synthetic Reviewer"], now: new Date("2026-11-03T12:00:00.000Z"),
  };
  return { folder, options };
}

test("GitHub remotes are recognized in https and ssh forms only", () => {
  for (const url of ["https://github.com/acme/api.git", "https://github.com/acme/api", "git@github.com:acme/api.git", "ssh://git@github.com/acme/api.git\n"]) {
    assert.equal(parseGithubRemote(url), "acme/api", url);
  }
  for (const url of ["https://gitlab.com/acme/api.git", "https://github.com/acme", "file:///tmp/repo", "https://github.com/acme/api/../x"]) {
    assert.equal(parseGithubRemote(url), null, url);
  }
});

test("setup creates a working, reviewable workspace and refuses to overwrite anything", async () => {
  const { folder, options } = await workspace();
  try {
    const { profile } = await setupWorkspace(options);
    assert.deepEqual(await readWorkspaceProfile(options.profilePath), profile);
    if (process.platform !== "win32") assert.equal((await stat(options.profilePath)).mode & 0o777, 0o600);
    const binding = await readAgentBindingFile(options.bindingFile);
    assert.equal(binding.schemaVersion, 2);
    assert.deepEqual(binding.schemaVersion === 2 && binding.capabilities, ["context", "propose", "report"]);
    assert.equal(binding.schemaVersion === 2 && binding.ownerId, profile.operatorId);
    await assert.rejects(setupWorkspace(options), /already set up/);
    await assert.rejects(setupWorkspace({ ...options, profilePath: join(folder, "other.json") }), /already holds data/);
    await assert.rejects(setupWorkspace({ ...options, profilePath: join(folder, "x.json"), dataDir: join(folder, "fresh"), reviewerNames: ["Synthetic Operator"] }), ValidationError);

    const db = await openDatabase(options.dataDir);
    try {
      const ctx = createContext(db, { now: () => new Date("2026-11-03T12:05:00.000Z"), repositoryAccessMaxAgeMs: LOCAL_ACCESS_MAX_AGE_MS });
      const tree = await getOrganizationTree(ctx, profile.operatorId, profile.organizationId);
      assert.equal(tree.role, "owner");
      const roles = await listRoleAssignments(ctx, profile.operatorId, { level: "project", id: profile.projectId });
      assert.deepEqual(roles.map((r) => r.role).sort(), ["contributor", "reviewer"]);
      // The whole loop on a fresh workspace: the agent proposes, the second person approves, the agent receives it.
      const receipt = await proposeAgentMemory(ctx, binding, { type: "decision", title: "Payments retry with idempotency keys",
        content: "Synthetic: every payment retry reuses the original idempotency key.", paths: ["src/payments/**"],
        evidence: { pullRequests: [{ number: 12, excerpt: "Synthetic PR: added idempotency keys to retries." }] } });
      await approveProposal(ctx, profile.reviewerIds[0]!, { proposalId: receipt.proposalId, expectedRevision: 1 });
      const context = await getAgentTaskContext(ctx, binding, { task: "change payment retries", paths: ["src/payments/charge.ts"] });
      assert.equal(context.outcome, "results");
      assert.equal(context.items[0]?.title, "Payments retry with idempotency keys");
      assert.equal((await verifyLedger(db)).ok, true);
    } finally {
      await db.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("renewing local access keeps granted declarations alive and never re-grants removed access", async () => {
  const { folder, options } = await workspace();
  try {
    const { profile } = await setupWorkspace(options);
    const db = await openDatabase(options.dataDir);
    try {
      let now = new Date("2026-11-04T12:00:00.000Z");
      const ctx = createContext(db, { now: () => now, repositoryAccessMaxAgeMs: LOCAL_ACCESS_MAX_AGE_MS });
      await recordRepositoryAccess(ctx, { principalId: profile.agentId, provider: "github", externalRepositoryId: profile.repository.id, canRead: false });
      now = new Date("2026-11-05T12:00:00.000Z");
      assert.equal(await renewLocalAccess(ctx, profile), 2, "operator and reviewer renewed");
      const agent = await db.query<{ can_read: boolean }>("SELECT can_read FROM repository_access WHERE principal_id = $1", [profile.agentId]);
      assert.equal(agent.rows[0]?.can_read, false);
    } finally {
      await db.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("client configuration adds only the memorynet entry and refuses files it cannot safely rewrite", async () => {
  const folder = await mkdtemp(join(tmpdir(), "memorynet-client-"));
  try {
    const entry = mcpServerEntry({ bindingFile: "/tmp/binding.json", appUrl: "http://127.0.0.1:3050", node: "/usr/local/bin/node" });
    assert.match(entry.args[0]!, /src[\\/]scripts[\\/]mcp\.ts$/);
    await mkdir(join(folder, ".vscode"));
    await writeFile(join(folder, ".vscode", "mcp.json"), JSON.stringify({ servers: { other: { type: "stdio", command: "x" } }, inputs: [] }));
    await writeClientConfig("vscode", folder, entry);
    const vscode = JSON.parse(await readFile(join(folder, ".vscode", "mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(vscode.servers), ["other", "memorynet"]);
    assert.equal(vscode.servers.memorynet.type, "stdio");
    assert.deepEqual(vscode.inputs, []);
    await writeClientConfig("claude", folder, entry);
    assert.deepEqual(JSON.parse(await readFile(join(folder, ".mcp.json"), "utf8")).mcpServers.memorynet, entry);
    await writeClientConfig("cursor", folder, entry);
    assert.ok(JSON.parse(await readFile(join(folder, ".cursor", "mcp.json"), "utf8")).mcpServers.memorynet);
    assert.throws(() => renderClientConfig("vscode", entry, '{ // comment\n "servers": {} }'), /not plain JSON/);
    assert.throws(() => renderClientConfig("claude", entry, '{"mcpServers": []}'), /unexpected/);
    const toml = renderClientConfig("codex", entry, "model = \"x\"\n");
    assert.match(toml, /^model = "x"\n\n\[mcp_servers\.memorynet\]\ncommand = "\/usr\/local\/bin\/node"/);
    assert.match(toml, /\[mcp_servers\.memorynet\.env\]\nMEMORYNET_AGENT_BINDING_FILE = "\/tmp\/binding\.json"/);
    assert.throws(() => renderClientConfig("codex", entry, toml), /already configures/);
    for (const text of [await readFile(join(folder, ".mcp.json"), "utf8"), toml]) assert.equal(/[a-f0-9]{64}/.test(text), false, "no credential is written");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
