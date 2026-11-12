import type { Principal } from "./access.ts";
import { accessFreshSince, type MemoryNetContext } from "./context.ts";
import type { Queryable } from "./db.ts";
import { ValidationError } from "./errors.ts";

/** depends_on: this guidance assumes the other holds. refines: narrows or details it. conflicts_with: they disagree and a reader must choose. related: worth reading together. */
export const MEMORY_RELATIONS = ["depends_on", "refines", "conflicts_with", "related"] as const;
export type MemoryRelation = (typeof MEMORY_RELATIONS)[number];

export interface MemoryLink {
  relation: MemoryRelation;
  memoryId: string;
}

/** Reviewed with the version: the repository paths it governs and its links to other memories in the project. */
export interface MemoryRelations {
  paths: string[];
  links: MemoryLink[];
}

export interface MemoryRelationsInput {
  paths?: readonly string[];
  links?: ReadonlyArray<{ relation: string; memoryId: string }>;
}

export const NO_RELATIONS: MemoryRelations = Object.freeze({ paths: [], links: [] }) as MemoryRelations;
export const MAX_PATHS = 20;
export const MAX_LINKS = 20;
const MAX_WILDCARDS = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH_CHARS = /^[A-Za-z0-9._@+~*?/ -]+$/;

/** A relative repository path or glob: `**` spans folders, `*` and `?` stay within one name. */
export function requirePathPattern(value: unknown): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (path.length < 1 || path.length > 200 || !PATH_CHARS.test(path) || path.startsWith("/") ||
      /(^|\/)\.\.?(\/|$)/.test(path) || path.includes("//")) {
    throw new ValidationError("Paths must be relative repository paths or globs such as src/api/** (letters, digits, . _ - / * ?)");
  }
  if ((path.match(/[*?]/g) ?? []).length > MAX_WILDCARDS) throw new ValidationError(`A path pattern may use at most ${MAX_WILDCARDS} wildcard characters`);
  return path;
}

/** Validates, removes duplicates and sorts, so equal relations always compare and store the same way. */
export function normalizeRelations(input: MemoryRelationsInput | null | undefined): MemoryRelations {
  if (input == null) return NO_RELATIONS;
  if (typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "paths" && key !== "links")) {
    throw new ValidationError("Relations have paths and links only");
  }
  const rawPaths = input.paths ?? [];
  const rawLinks = input.links ?? [];
  if (!Array.isArray(rawPaths) || !Array.isArray(rawLinks)) throw new ValidationError("Paths and links must be lists");
  const paths = [...new Set(rawPaths.map(requirePathPattern))].sort();
  if (paths.length > MAX_PATHS) throw new ValidationError(`At most ${MAX_PATHS} paths`);
  const links = new Map<string, MemoryLink>();
  for (const link of rawLinks) {
    if (link === null || typeof link !== "object" || Object.keys(link).some((key) => key !== "relation" && key !== "memoryId") ||
        !(MEMORY_RELATIONS as readonly string[]).includes(link.relation) || typeof link.memoryId !== "string" || !UUID.test(link.memoryId)) {
      throw new ValidationError(`Each link names a memory ID and one of: ${MEMORY_RELATIONS.join(", ")}`);
    }
    if (links.has(link.memoryId)) throw new ValidationError("Link to each memory once");
    links.set(link.memoryId, { relation: link.relation as MemoryRelation, memoryId: link.memoryId });
  }
  if (links.size > MAX_LINKS) throw new ValidationError(`At most ${MAX_LINKS} links`);
  return { paths, links: [...links.values()].sort((a, b) => a.memoryId.localeCompare(b.memoryId)) };
}

/** Stored form: null when there are none. */
export function relationsJson(relations: MemoryRelations): string | null {
  return relations.paths.length === 0 && relations.links.length === 0 ? null : JSON.stringify(relations);
}

export function parseRelations(value: unknown): MemoryRelations {
  if (value == null) return NO_RELATIONS;
  const stored = value as { paths?: unknown; links?: unknown };
  return {
    paths: Array.isArray(stored.paths) ? stored.paths.filter((p): p is string => typeof p === "string") : [],
    links: Array.isArray(stored.links) ? (stored.links as MemoryLink[]).map((l) => ({ relation: l.relation, memoryId: l.memoryId })) : [],
  };
}

export function sameRelations(a: MemoryRelations, b: MemoryRelations): boolean {
  return relationsJson(a) === relationsJson(b);
}

/**
 * One path name against one pattern name: `*` matches any run of characters, `?` one character. Two pointers with
 * a single star backtrack, so the cost is bounded by name length times pattern length; no regular expression.
 */
function nameMatches(pattern: string, name: string): boolean {
  let p = 0, n = 0, star = -1, resume = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === name[n])) { p++; n++; }
    else if (p < pattern.length && pattern[p] === "*") { star = p++; resume = n; }
    else if (star !== -1) { p = star + 1; n = ++resume; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * Whether a repository path is governed by a reviewed pattern. A `**` name spans any number of folders; a plain
 * path also covers everything below it, so "src/api" governs "src/api/client.ts". Linear in path and pattern size.
 */
export function pathMatches(pattern: string, path: string): boolean {
  if (!/[*?]/.test(pattern)) return path === pattern || path.startsWith(`${pattern}/`);
  const want = pattern.split("/"), have = path.split("/");
  const seen = new Map<number, boolean>();
  const match = (i: number, j: number): boolean => {
    const key = i * (have.length + 1) + j;
    const known = seen.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === want.length) result = j === have.length;
    else if (want[i] === "**") result = match(i + 1, j) || (j < have.length && match(i, j + 1));
    else result = j < have.length && nameMatches(want[i]!, have[j]!) && match(i + 1, j + 1);
    seen.set(key, result);
    return result;
  };
  return match(0, 0);
}

/** Higher for patterns naming more of the path, so an exact file outranks a whole folder. */
export function pathSpecificity(pattern: string): number {
  return pattern.replace(/\*\*\/?|[*?]/g, "").length;
}

/**
 * IDs among `ids` that the caller may read now (any status), using the shared memory read rule.
 * `readableSql` is READABLE_MEMORIES_SQL, passed in to avoid a module cycle.
 */
export async function readableMemoryIds(
  q: Queryable,
  ctx: MemoryNetContext,
  caller: Principal,
  readableSql: string,
  ids: readonly string[],
): Promise<Map<string, { status: string; projectId: string }>> {
  if (ids.length === 0) return new Map();
  const { rows } = await q.query<{ id: string; status: string; project_id: string }>(
    `SELECT readable.id, readable.status, readable.project_id FROM (${readableSql} AND m.id = ANY($3::uuid[])) readable`,
    [caller.id, accessFreshSince(ctx), [...new Set(ids)]],
  );
  return new Map(rows.map((row) => [row.id, { status: row.status, projectId: row.project_id }]));
}
