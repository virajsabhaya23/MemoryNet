export type ErrorCode =
  | "validation_failed"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "unavailable";

/** Expected, caller-facing failure. Messages must never reveal records the caller cannot see. */
export class MemoryNetError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends MemoryNetError {
  constructor(message: string) {
    super("validation_failed", message);
  }
}

/** Also used when a record exists but the caller has no access to it. */
export class NotFoundError extends MemoryNetError {
  constructor(message: string) {
    super("not_found", message);
  }
}

export class ForbiddenError extends MemoryNetError {
  constructor(message: string) {
    super("forbidden", message);
  }
}

export class ConflictError extends MemoryNetError {
  constructor(message: string) {
    super("conflict", message);
  }
}

/** Something MemoryNet depends on failed, so nothing was done. Never means "nothing found". */
export class UnavailableError extends MemoryNetError {
  constructor(message: string, options?: ErrorOptions) {
    super("unavailable", message, options);
  }
}
