import { ValidationError } from "./errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f]/;
const MULTI_LINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const GITHUB_NUMERIC_ID = /^[1-9][0-9]{0,18}$/;
const GITHUB_FULL_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const COMMIT_SHA = /^[0-9a-f]{7,64}$/;
const PULL_REQUEST_REFERENCE = /^pull\/([1-9][0-9]{0,9})$/;
const PULL_REQUEST_PATH = /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]{0,9})(?:\/|$)/;

export function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ValidationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

export function requireIds(
  value: unknown,
  field: string,
  max: number,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`${field} must list at least one ID`);
  }
  if (value.length > max)
    throw new ValidationError(`${field} can list at most ${max} IDs`);
  const ids = value.map((item) => requireId(item, field));
  if (new Set(ids).size !== ids.length)
    throw new ValidationError(`${field} must not repeat IDs`);
  return ids;
}

export function requireSlug(value: unknown, field: string): string {
  if (typeof value !== "string" || !SLUG.test(value)) {
    throw new ValidationError(
      `${field} must be 1-63 lowercase letters, digits, or inner hyphens`,
    );
  }
  return value;
}

/** Trimmed, non-empty, bounded text. Only multiline text may contain tabs and line breaks. */
export function requireText(
  value: unknown,
  field: string,
  maxLength: number,
  multiline = false,
): string {
  if (typeof value !== "string")
    throw new ValidationError(`${field} must be text`);
  // Browsers send form line breaks as CRLF; store one kind.
  const trimmed = (multiline ? value.replace(/\r\n?/g, "\n") : value).trim();
  if (trimmed.length === 0) throw new ValidationError(`${field} is required`);
  if (trimmed.length > maxLength) {
    throw new ValidationError(
      `${field} must be at most ${maxLength} characters`,
    );
  }
  if ((multiline ? MULTI_LINE_CONTROL : SINGLE_LINE_CONTROL).test(trimmed)) {
    throw new ValidationError(`${field} contains control characters`);
  }
  return trimmed;
}

export function optionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  return value === undefined || value === null
    ? null
    : requireText(value, field, maxLength);
}

export function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new ValidationError(`${field} must be true or false`);
  return value;
}

export function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be a positive whole number`);
  }
  return value;
}

export function optionalLimit(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const limit = requirePositiveInteger(value, "limit");
  if (limit > max) throw new ValidationError(`limit must be at most ${max}`);
  return limit;
}

export function optionalDate(value: unknown, field: string): Date | null {
  if (value === undefined) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ValidationError(`${field} must be a valid date`);
  }
  return value;
}

export function requireGithubId(value: unknown, field: string): string {
  if (typeof value !== "string" || !GITHUB_NUMERIC_ID.test(value)) {
    throw new ValidationError(
      `${field} must be a numeric GitHub ID written as text`,
    );
  }
  return value;
}

export function requireGithubFullName(value: unknown, field: string): string {
  if (typeof value !== "string" || !GITHUB_FULL_NAME.test(value)) {
    throw new ValidationError(`${field} must look like owner/repository`);
  }
  return value;
}

export function optionalCommitSha(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) {
    throw new ValidationError(
      `${field} must be a lowercase hexadecimal commit SHA`,
    );
  }
  return value;
}

export function requireCommitSha(value: unknown, field: string): string {
  const sha = optionalCommitSha(value, field);
  if (sha === null) throw new ValidationError(`${field} is required`);
  return sha;
}

/** A pull request reference such as pull/123. Returns the pull request number. */
export function requirePullRequestReference(
  value: unknown,
  field: string,
): number {
  const match =
    typeof value === "string" ? PULL_REQUEST_REFERENCE.exec(value) : null;
  if (!match?.[1]) {
    throw new ValidationError(
      `${field} must be a pull request, such as pull/123; other kinds of evidence are not supported yet`,
    );
  }
  return Number(match[1]);
}

/** True when an https URL links to this pull request on github.com, in the named repository if one is given. */
export function isPullRequestUrl(
  url: string,
  pullNumber: number,
  fullName: string | null,
): boolean {
  const parsed = new URL(url);
  const match = PULL_REQUEST_PATH.exec(parsed.pathname);
  return (
    parsed.host === "github.com" &&
    match?.[2] === String(pullNumber) &&
    (fullName === null || match[1]?.toLowerCase() === fullName.toLowerCase())
  );
}

export function requireHttpsUrl(value: unknown, field: string): string {
  const raw = requireText(value, field, 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`${field} must be a valid URL`);
  }
  if (url.protocol !== "https:")
    throw new ValidationError(`${field} must use https`);
  if (url.username !== "" || url.password !== "") {
    throw new ValidationError(`${field} must not contain credentials`);
  }
  return url.toString();
}
