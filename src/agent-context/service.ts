import { requireCaller, type Principal } from "../access.ts";
import type { MemoryNetContext } from "../context.ts";
import type { Database, Queryable } from "../db.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { reportOutdated } from "../history.ts";
import { getMemory, proposeChange, proposeMemory, recordSource } from "../knowledge.ts";
import { requireAgentProposalAllowed } from "../policy.ts";
import { getContext } from "../retrieval.ts";
import { getTaskContext } from "../task-context.ts";
import { bindingCapabilities, bindingOwner, parseAgentBinding, type AgentBinding, type AgentCapability } from "./binding.ts";
import {
  AgentContextSchema,
  AgentProposalReceiptSchema,
  AgentProposeSchema,
  AgentQuerySchema,
  AgentReportReceiptSchema,
  AgentReportSchema,
  AgentTaskContextSchema,
  AgentTaskQuerySchema,
  type AgentContextResponse,
  type AgentProposalReceipt,
  type AgentReportReceipt,
  type AgentTaskContextResponse,
} from "./contract.ts";

function inTransaction(ctx: MemoryNetContext, tx: Queryable): MemoryNetContext {
  const now = ctx.now();
  const db: Database = { query: (sql, params) => tx.query(sql, params), exec: (sql) => tx.exec(sql),
    transaction: (fn) => fn(tx), async close() { throw new Error("Transaction cannot close database"); } };
  return { ...ctx, db, now: () => new Date(now) };
}

/** Every agent request: a valid, unexpired binding that grants this capability. Never reveals the token. */
function authorize(ctx: MemoryNetContext, rawBinding: AgentBinding, capability: AgentCapability, input: unknown): AgentBinding {
  const binding = parseAgentBinding(rawBinding);
  if (JSON.stringify(input ?? null).includes(binding.token)) throw new ValidationError("Invalid agent request");
  if (Date.parse(binding.expiresAt) <= ctx.now().getTime()) throw new ForbiddenError("Local agent binding expired");
  if (!bindingCapabilities(binding).includes(capability)) throw new ForbiddenError("This binding does not allow that action");
  return binding;
}

async function requireAgent(q: Queryable, binding: AgentBinding): Promise<Principal> {
  const caller = await requireCaller(q, binding.principalId);
  if (caller.kind !== "agent") throw new ForbiddenError("Context binding requires an agent principal");
  return caller;
}

function withheldIfCredential<T>(binding: AgentBinding, response: T): T {
  if (JSON.stringify(response).includes(binding.token)) throw new ValidationError("Credential-like context withheld");
  return response;
}

/** Server/operator binding supplies every authority parameter; callers can only search and bound size. */
export async function getAgentContext(ctx: MemoryNetContext, rawBinding: AgentBinding, rawInput: unknown): Promise<AgentContextResponse> {
  const input = AgentQuerySchema.safeParse(rawInput);
  const binding = authorize(ctx, rawBinding, "context", rawInput);
  if (!input.success) throw new ValidationError("Invalid context query");
  return ctx.db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const scoped = inTransaction(ctx, tx);
    const caller = await requireAgent(tx, binding);
    const result = await getContext(scoped, caller.id, { ...input.data, projectId: binding.projectId,
      applicability: { repositoryId: binding.repositoryId, branch: binding.branch }, currentOnly: true });
    return withheldIfCredential(binding, AgentContextSchema.parse({ schemaVersion: 1,
      scope: { projectId: binding.projectId, repositoryId: binding.repositoryId, branch: binding.branch },
      retrievalId: result.retrievalId, retrievedAt: result.retrievedAt.toISOString(),
      outcome: result.outcome, moreMatches: result.moreMatches,
      // Do not forward notCurrent, owner records, internal ACL metadata or arbitrary future core fields.
      current: result.current.map((memory) => ({
        memoryId: memory.memoryId, revision: memory.revision, type: memory.type, title: memory.title,
        content: memory.content, shortened: memory.shortened,
        approvedBy: memory.approvedBy, approvedAt: memory.approvedAt.toISOString(),
        citations: memory.citations.map((c) => ({ sourceId: c.sourceId, reference: c.reference, url: c.url,
          revision: c.revision, excerpt: c.excerpt, shortened: c.shortened })), moreCitations: memory.moreCitations,
      })),
    }));
  });
}

/** Task context in the binding's exact project, repository and branch, at the current time. */
export async function getAgentTaskContext(ctx: MemoryNetContext, rawBinding: AgentBinding, rawInput: unknown): Promise<AgentTaskContextResponse> {
  const input = AgentTaskQuerySchema.safeParse(rawInput);
  const binding = authorize(ctx, rawBinding, "context", rawInput);
  if (!input.success) throw new ValidationError("Invalid task context query");
  return ctx.db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const scoped = inTransaction(ctx, tx);
    const caller = await requireAgent(tx, binding);
    const result = await getTaskContext(scoped, caller.id, { ...input.data, projectId: binding.projectId,
      applicability: { repositoryId: binding.repositoryId, branch: binding.branch } });
    return withheldIfCredential(binding, AgentTaskContextSchema.parse({ schemaVersion: 2,
      scope: { projectId: binding.projectId, repositoryId: binding.repositoryId, branch: binding.branch },
      retrievalId: result.retrievalId, retrievedAt: result.retrievedAt.toISOString(), outcome: result.outcome,
      items: result.items.map((item) => ({
        memoryId: item.memoryId, revision: item.revision, type: item.type, title: item.title, content: item.content,
        shortened: item.shortened, compact: item.compact, approvedBy: item.approvedBy, approvedAt: item.approvedAt.toISOString(),
        approvals: item.approvals, score: item.score, reasons: item.reasons, paths: item.paths,
        citations: item.citations.map((c) => ({ sourceId: c.sourceId, reference: c.reference, url: c.url, revision: c.revision,
          excerpt: c.excerpt, shortened: c.shortened, flags: c.flags })),
        moreCitations: item.moreCitations,
      })),
      conflicts: result.conflicts, moreConflicts: result.moreConflicts,
      changedDependencies: result.changedDependencies, moreChangedDependencies: result.moreChangedDependencies,
      omitted: result.omitted, budget: result.budget,
    }));
  });
}

/** The memory must be readable and govern exactly the binding's repository and branch. */
async function scopedMemory(ctx: MemoryNetContext, caller: Principal, binding: AgentBinding, memoryId: string) {
  const memory = await getMemory(ctx, caller.id, memoryId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  const scope = memory?.applicability;
  if (!memory || memory.projectId !== binding.projectId || !scope || scope.repositoryId !== binding.repositoryId || scope.branch !== binding.branch) {
    throw new NotFoundError("Memory not found in this binding's scope");
  }
  return memory;
}

/**
 * Submits a pending proposal for human review, scoped to the binding's repository and branch, owned by the
 * person accountable for the binding. Pull request evidence is recorded as sources captured by the agent.
 * Agents cannot approve, and the project policy may turn agent proposals off or limit how many wait.
 */
export async function proposeAgentMemory(ctx: MemoryNetContext, rawBinding: AgentBinding, rawInput: unknown): Promise<AgentProposalReceipt> {
  const parsed = AgentProposeSchema.safeParse(rawInput);
  const binding = authorize(ctx, rawBinding, "propose", rawInput);
  if (!parsed.success) throw new ValidationError("Invalid proposal: give a type, title, content and at least one source or pull request");
  const input = parsed.data;
  const ownerId = bindingOwner(binding)!;
  // One transaction: a refused proposal leaves no evidence records behind.
  return ctx.db.transaction(async (tx) => {
    const scoped = inTransaction(ctx, tx);
    const caller = await requireAgent(tx, binding);
    await requireAgentProposalAllowed(tx, caller.id, binding.projectId);
    const target = input.change ? await scopedMemory(scoped, caller, binding, input.change.memoryId) : null;
    // For a change, an omitted paths/links field keeps the decision's current reviewed value;
    // an explicit list (even empty) replaces it. New proposals start from empty.
    const relations = input.paths === undefined && input.links === undefined ? undefined
      : target
        ? { paths: input.paths ?? target.relations.paths, links: input.links ?? target.relations.links }
        : { paths: input.paths ?? [], links: input.links ?? [] };
    const recorded: string[] = [];
    if (input.evidence.pullRequests?.length) {
      const connection = (await tx.query<{ full_name: string }>(
        `SELECT full_name FROM repository_connections WHERE project_id = $1 AND provider = 'github'
           AND external_repository_id = $2 AND disconnected_at IS NULL`,
        [binding.projectId, binding.repositoryId],
      )).rows[0];
      if (!connection) throw new NotFoundError("The bound repository is not connected to the project");
      for (const pull of input.evidence.pullRequests) {
        const source = await recordSource(scoped, caller.id, { projectId: binding.projectId, provider: "github",
          externalRepositoryId: binding.repositoryId, reference: `pull/${pull.number}`,
          url: `https://github.com/${connection.full_name}/pull/${pull.number}`, excerpt: pull.excerpt,
          ...(pull.commit === undefined ? {} : { revision: pull.commit }) });
        recorded.push(source.id);
      }
    }
    const evidenceSourceIds = [...new Set([...(input.evidence.sourceIds ?? []), ...recorded])];
    const proposal = target && input.change
      ? await proposeChange(scoped, caller.id, { memoryId: target.id, expectedRevision: input.change.revision, kind: input.change.kind,
          type: input.type, title: input.title, content: input.content, evidenceSourceIds, ownerId, ...(relations ? { relations } : {}) })
      : await proposeMemory(scoped, caller.id, { projectId: binding.projectId, type: input.type, title: input.title, content: input.content,
          evidenceSourceIds, ownerId, ...(relations ? { relations } : {}),
          applicability: { repositoryId: binding.repositoryId, branch: binding.branch, validFrom: scoped.now().toISOString() } });
    return withheldIfCredential(binding, AgentProposalReceiptSchema.parse({ schemaVersion: 1, proposalId: proposal.id, revision: 1,
      status: "pending", reviewPath: `/proposals/${proposal.id}`, flags: proposal.flags, recordedSourceIds: recorded }));
  });
}

/** Reports a scoped memory as possibly outdated. A report changes nothing until a person acts on it. */
export async function reportAgentMemory(ctx: MemoryNetContext, rawBinding: AgentBinding, rawInput: unknown): Promise<AgentReportReceipt> {
  const parsed = AgentReportSchema.safeParse(rawInput);
  const binding = authorize(ctx, rawBinding, "report", rawInput);
  if (!parsed.success) throw new ValidationError("Invalid report: give a memory ID and a reason");
  const caller = await requireAgent(ctx.db, binding);
  await scopedMemory(ctx, caller, binding, parsed.data.memoryId);
  const report = await reportOutdated(ctx, caller.id, parsed.data);
  return AgentReportReceiptSchema.parse({ schemaVersion: 1, reportId: report.id, memoryId: report.memoryId, revision: report.revision, status: "open" });
}
