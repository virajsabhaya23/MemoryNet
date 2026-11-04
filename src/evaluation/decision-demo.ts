import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readAgentBindingFile, writeAgentBindingFile } from "../agent-context/binding.ts";
import { AgentContextSchema } from "../agent-context/contract.ts";
import type { DecisionGuardProvider, GuardInput } from "../decision-guard/model.ts";
import { createGuardRun, publishGuardCandidate } from "../decision-guard/workflow.ts";
import { approveProposal, assignRole, ConflictError, createWork, exportWork, ForbiddenError, listRetrievals, listWork, recordSource } from "../index.ts";
import { createApp, type App } from "../web/app.ts";
import { createSyntheticEvaluationFixture } from "./fixture.ts";

/** A repeatable product walkthrough, not an agent-effectiveness benchmark or a live Meta run. */
export async function runDecisionDemo() {
  const f = await createSyntheticEvaluationFixture();
  let folder: string | undefined;
  let app: App;
  const clients: Client[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 8192) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) headers[key] = Array.isArray(value) ? value.join(", ") : value;
      const result = await app({ method: request.method ?? "GET", path: url.pathname, query: url.searchParams,
        headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(result.status, result.headers).end(result.body);
    } catch { response.writeHead(503).end(); }
  });
  try {
    folder = await mkdtemp(join(tmpdir(), "memorynet-decision-demo-"));
    const bindingFile = join(folder, "binding.json");
    await assignRole(f.ctx, f.owner.id, { principalId: f.agent.id, scope: { level: "project", id: f.project.id }, role: "contributor" });
    await writeAgentBindingFile(bindingFile, { principalId: f.agent.id, projectId: f.project.id, repositoryId: f.repositoryId, branch: "main" }, f.ctx.now());
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    app = createApp(f.ctx, { port, agentBinding: () => readAgentBindingFile(bindingFile) });
    async function freshClient() {
      const client = new Client({ name: "memorynet-decision-demo", version: "1.0.0" });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL("../scripts/mcp.ts", import.meta.url))],
        env: { MEMORYNET_AGENT_BINDING_FILE: bindingFile, MEMORYNET_APP_URL: `http://127.0.0.1:${port}` },
        stderr: "pipe", maxBufferSize: 512_000,
      }));
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["get_context", "get_task_context"]);
      return client;
    }
    async function retrieve(client: Client) {
      const response = await client.callTool({ name: "get_context", arguments: { query: "retry policy", limit: 5 } });
      assert.notEqual(response.isError, true);
      return AgentContextSchema.parse(response.structuredContent);
    }
    // A deterministic stand-in exercises the same quote validation, staging and review rules.
    // No key is loaded and no request is made to an external model or GitHub.
    const provider: DecisionGuardProvider = { async complete(messages) {
      const input = JSON.parse(messages[1]!.content) as GuardInput;
      const source = input.sources[0]!;
      const quote = source.text.split("\nDecision: ")[1]!;
      return { provider: "scripted-demo", model: "fixture-response-v1", usage: null,
        text: JSON.stringify({ candidates: [{ title: "Retry policy", decision: quote,
          evidence: [{ sourceId: source.sourceId, quote }],
          possibleConflicts: input.approvedDecisions.map(decision => ({ memoryId: decision.memoryId,
            revision: decision.revision, reason: "The replacement removes HTTP 429 retries and reduces the retry limit." })),
        }] }),
      };
    } };
    async function extract(policy: string, number: number, previousId?: string) {
      const source = await recordSource(f.ctx, f.owner.id, { projectId: f.project.id, provider: "github",
        externalRepositoryId: f.repositoryId, reference: `pull/${100 + number}`,
        url: `https://github.com/synthetic-fixture/transport/pull/${100 + number}`, revision: String(number).repeat(40),
        excerpt: `Synthetic demonstration evidence; this is not a real pull request.\nDecision: ${policy}` });
      const run = await createGuardRun(f.ctx, f.owner.id, f.agent.id, provider, { projectId: f.project.id,
        sourceIds: [source.id], decisionIds: previousId ? [previousId] : [], applicability: f.applicability });
      const candidate = run.extraction.candidates[0]!;
      const citation = candidate.evidence[0]!;
      assert.equal(source.excerpt!.slice(citation.start, citation.end), citation.quote);
      const proposal = await publishGuardCandidate(f.ctx, f.owner.id, { runId: run.id, candidateIndex: 0,
        kind: previousId ? "replace" : "new", ...(previousId ? { targetMemoryId: previousId } : {}) });
      assert.equal(proposal.status, "pending");
      return { source, run, candidate, proposal };
    }
    const original = await extract("Retry HTTP 429 and 503 while retriesSoFar is less than 3.", 1);
    const client = await freshClient();
    const pending = await retrieve(client);
    assert.equal(pending.outcome, "no_results");
    await assert.rejects(approveProposal(f.ctx, f.agent.id, { proposalId: original.proposal.id, expectedRevision: 1 }), ForbiddenError);
    const first = await approveProposal(f.ctx, f.reviewer.id, { proposalId: original.proposal.id, expectedRevision: 1 });
    const before = await retrieve(client);
    assert.equal(before.current.length, 1);
    assert.equal(before.current[0]!.memoryId, first.id);
    const workId = await createWork(f.ctx, f.owner.id, { projectId: f.project.id, title: "Update transport retries",
      repositoryId: f.repositoryId, branch: "main", codeCommit: "a".repeat(40),
      artifacts: [{ kind: "spec", path: "specs/retry-policy.md", requirementId: "RETRY-001",
        sha256: createHash("sha256").update(first.content).digest("hex") }],
      decisions: [{ memoryId: first.id, revision: first.revision }] });
    const initial = await exportWork(f.ctx, f.agent.id, workId);
    assert.equal(initial.contextStatus, "current");
    const replacement = await extract("Retry HTTP 503 only while retriesSoFar is less than 2. Never retry HTTP 429.", 2, first.id);
    const whilePending = await retrieve(client);
    assert.equal(whilePending.current[0]?.memoryId, first.id, "a suggestion cannot replace approved authority");
    assert.equal(replacement.candidate.possibleConflicts[0]?.memoryId, first.id);
    const second = await approveProposal(f.ctx, f.reviewer.id, { proposalId: replacement.proposal.id, expectedRevision: 1 });
    const affected = (await listWork(f.ctx, f.agent.id, f.project.id)).find(item => item.work.id === workId)!;
    assert.equal(affected.contextStatus, "review_needed");
    assert.ok(affected.issues.some(issue => issue.reason === "not_approved"));
    await assert.rejects(exportWork(f.ctx, f.agent.id, workId), ConflictError);
    const after = await retrieve(await freshClient());
    assert.equal(after.current.length, 1);
    assert.equal(after.current[0]!.memoryId, second.id);
    assert.ok(after.current[0]!.citations.some(citation => citation.sourceId === replacement.source.id));
    const receipts = await listRetrievals(f.ctx, f.owner.id, { projectId: f.project.id });
    const responses = [pending, before, whilePending, after];
    assert.ok(responses.every(result => receipts.some(receipt => receipt.id === result.retrievalId)));
    return {
      schemaVersion: 1 as const, evidenceKind: "synthetic_decision_lifecycle" as const, recordedAt: new Date().toISOString(),
      nodeVersion: process.version, metaCalls: 0, extraction: "scripted fixture; not live Meta inference",
      approvals: "automated fixture actions using distinct principals; not independent human review",
      codeBehaviorVerified: false, benchmark: false, passed: true,
      scope: before.scope, quote: { text: original.source.excerpt, ...original.candidate.evidence[0]! },
      proposalId: original.proposal.id, pending, before, whilePending, after,
      conflict: replacement.candidate.possibleConflicts[0]!,
      work: { id: workId, title: affected.work.title, before: initial.contextStatus, after: affected.contextStatus,
        issues: affected.issues, staleExportBlocked: true },
      agentApprovalBlocked: true, freshProtocolClients: clients.length,
      receipts: receipts.map(receipt => ({ id: receipt.id, retrievedAt: receipt.retrievedAt, items: receipt.items })),
    };
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}

export type DecisionDemoReport = Awaited<ReturnType<typeof runDecisionDemo>>;
