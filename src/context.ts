import type { Database, Queryable } from "./db.ts";

export interface MemoryNetContext {
  readonly db: Database;
  readonly now: () => Date;
  /** How long an observed repository permission is trusted before access fails closed. */
  readonly repositoryAccessMaxAgeMs: number;
  /**
   * Observations older than this never count. GitHub sign-in sets it to server start: the server owns the database
   * exclusively and records only GitHub-verified access, so self-declared reports from earlier runs are ignored.
   */
  readonly repositoryAccessNotBefore?: Date;
}

/** Provisional until the pilot agrees a permission refresh policy (docs/architecture.md). */
export const DEFAULT_REPOSITORY_ACCESS_MAX_AGE_MS = 15 * 60 * 1000;

export function createContext(
  db: Database,
  options: { now?: () => Date; repositoryAccessMaxAgeMs?: number; repositoryAccessNotBefore?: Date } = {},
): MemoryNetContext {
  const maxAge =
    options.repositoryAccessMaxAgeMs ?? DEFAULT_REPOSITORY_ACCESS_MAX_AGE_MS;
  if (!Number.isInteger(maxAge) || maxAge <= 0) {
    throw new RangeError("repositoryAccessMaxAgeMs must be a positive integer");
  }
  return {
    db,
    now: options.now ?? (() => new Date()),
    repositoryAccessMaxAgeMs: maxAge,
    ...(options.repositoryAccessNotBefore ? { repositoryAccessNotBefore: options.repositoryAccessNotBefore } : {}),
  };
}

/** Oldest repository access observation that still counts as current. */
export function accessFreshSince(ctx: MemoryNetContext): Date {
  const oldest = ctx.now().getTime() - ctx.repositoryAccessMaxAgeMs;
  return new Date(Math.max(oldest, ctx.repositoryAccessNotBefore?.getTime() ?? oldest));
}

/** Reuse a live transaction for nested domain calls, with a fixed check time. */
export function inTransaction(ctx: MemoryNetContext, tx: Queryable): MemoryNetContext {
  const now = ctx.now();
  const db: Database = { query: (sql, params) => tx.query(sql, params), exec: (sql) => tx.exec(sql),
    transaction: (fn) => fn(tx), async close() { throw new Error("Transaction cannot close database"); } };
  return { ...ctx, db, now: () => new Date(now) };
}
