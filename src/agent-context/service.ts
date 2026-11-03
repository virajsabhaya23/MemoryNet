import { requireCaller } from "../access.ts";
import type { MemoryNetContext } from "../context.ts";
import type { Database, Queryable } from "../db.ts";
import { ForbiddenError, ValidationError } from "../errors.ts";
import { getContext } from "../retrieval.ts";
import { parseAgentBinding, type AgentBinding } from "./binding.ts";
import { AgentContextSchema, AgentQuerySchema, type AgentContextResponse } from "./contract.ts";

function inTransaction(ctx: MemoryNetContext, tx: Queryable): MemoryNetContext {
  const now = ctx.now();
  const db: Database = { query: (sql, params) => tx.query(sql, params), exec: (sql) => tx.exec(sql),
    transaction: (fn) => fn(tx), async close() { throw new Error("Transaction cannot close database"); } };
  return { ...ctx, db, now: () => new Date(now) };
}

/** Server/operator binding supplies every authority parameter; callers can only search and bound size. */
export async function getAgentContext(ctx: MemoryNetContext, rawBinding: AgentBinding, rawInput: unknown): Promise<AgentContextResponse> {
  const binding = parseAgentBinding(rawBinding);
  const input = AgentQuerySchema.safeParse(rawInput);
  if (!input.success || input.data.query.includes(binding.token)) throw new ValidationError("Invalid context query");
  if (Date.parse(binding.expiresAt) <= ctx.now().getTime()) throw new ForbiddenError("Local agent binding expired");
  return ctx.db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const scoped = inTransaction(ctx, tx);
    const caller = await requireCaller(tx, binding.principalId);
    if (caller.kind !== "agent") throw new ForbiddenError("Context binding requires an agent principal");
    const result = await getContext(scoped, caller.id, { ...input.data, projectId: binding.projectId,
      applicability: { repositoryId: binding.repositoryId, branch: binding.branch }, currentOnly: true });
    const response = AgentContextSchema.parse({ schemaVersion: 1,
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
    });
    if (JSON.stringify(response).includes(binding.token)) throw new ValidationError("Credential-like context withheld");
    return response;
  });
}
