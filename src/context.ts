import type { Database } from "./db.ts";

export interface MemoryNetContext {
  readonly db: Database;
  readonly now: () => Date;
  /** How long an observed repository permission is trusted before access fails closed. */
  readonly repositoryAccessMaxAgeMs: number;
}

/** Provisional until the pilot agrees a permission refresh policy (docs/architecture.md). */
export const DEFAULT_REPOSITORY_ACCESS_MAX_AGE_MS = 15 * 60 * 1000;

export function createContext(
  db: Database,
  options: { now?: () => Date; repositoryAccessMaxAgeMs?: number } = {},
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
  };
}

/** Oldest repository access observation that still counts as current. */
export function accessFreshSince(ctx: MemoryNetContext): Date {
  return new Date(ctx.now().getTime() - ctx.repositoryAccessMaxAgeMs);
}
