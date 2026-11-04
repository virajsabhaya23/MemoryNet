// Local IDs and GitHub's numeric IDs occupy disjoint namespaces in every scope and receipt.
import { ValidationError } from "./errors.ts";

export const REPOSITORY_ID = /^(?:[1-9][0-9]{0,18}|local-[a-f0-9]{32})$/;
export function repositoryProvider(id: string): "github" | "local" {
  return id.startsWith("local-") ? "local" : "github";
}
export function requireRepositoryId(value: unknown, field: string): string {
  if (typeof value !== "string" || !REPOSITORY_ID.test(value)) throw new ValidationError(`${field} requires a GitHub or local repository ID`);
  return value;
}

// Only these committed regular files may be offered as local source evidence.
export const LOCAL_DOCUMENT = /^(?:README(?:\.md)?|AGENTS\.md|docs\/(?:adr|decisions|specs)\/(?!(?:credentials?|secrets?|private[-_]?keys?|tokens?)(?:[._-]|$))[a-z0-9][a-z0-9._-]{0,95}\.md)$/i;
