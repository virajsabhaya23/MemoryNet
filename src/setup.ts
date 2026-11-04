import { REPOSITORY_ID, repositoryProvider } from "./repository-identity.ts";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeAgentBindingFile } from "./agent-context/binding.ts";
import { createContext, type MemoryNetContext } from "./context.ts";
import { migrate, openDatabase } from "./db.ts";
import { ValidationError } from "./errors.ts";
import { assignRole, createPrincipal } from "./members.ts";
import { createBusinessUnit, createOrganization, createProject } from "./organizations.ts";
import { connectRepository, recordRepositoryAccess } from "./repositories.ts";
import { requireDecisionBranch } from "./knowledge.ts";
import { readWorkspaceProfile, WORKSPACE_PROFILE_PATH, type WorkspaceProfile } from "./workspace.ts";

/** Local access declarations last 30 days in the local app; nothing refreshes them from GitHub. */
export const LOCAL_ACCESS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;

export interface RepositoryInfo {
  fullName: string;
  id: string;
  defaultBranch: string;
  private: boolean;
}

/** owner/name of a GitHub remote URL (https or ssh), or null. */
export function parseGithubRemote(url: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? match[1]! : null;
}

/** The GitHub repository of a local checkout, from its origin remote. */
export function detectRepository(directory: string): string | null {
  try {
    const url = execFileSync("git", ["-C", directory, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseGithubRemote(url);
  } catch {
    return null;
  }
}

/** Repository ID, default branch and visibility from the GitHub CLI's existing login. Read-only. */
export function lookupRepository(fullName: string): RepositoryInfo {
  if (!FULL_NAME.test(fullName)) throw new ValidationError("Repository must look like owner/name");
  let raw: string;
  try {
    raw = execFileSync("gh", ["api", `repos/${fullName}`, "--jq", "[.id, .default_branch, .private, .full_name] | @tsv"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  } catch {
    throw new ValidationError(`Could not read ${fullName} with the GitHub CLI. Run "gh auth login", or pass --repo-id and --branch yourself.`);
  }
  const [id, defaultBranch, isPrivate, name] = raw.trim().split("\t");
  if (!id || !/^[1-9][0-9]{0,18}$/.test(id) || !defaultBranch || !name) throw new ValidationError("Unexpected repository details from the GitHub CLI");
  return { fullName: name, id, defaultBranch, private: isPrivate === "true" };
}

function slugify(value: string, fallback: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 63).replace(/-$/, "");
  return slug === "" ? fallback : slug;
}

export interface SetupOptions {
  dataDir: string;
  repository: { fullName: string; id: string; branch: string };
  operatorName: string;
  reviewerNames: readonly string[];
  agentName?: string;
  organizationName?: string;
  bindingFile: string;
  bindingTtlHours?: number;
  appUrl?: string;
  profilePath?: string;
  now?: Date;
}

export interface SetupResult {
  profile: WorkspaceProfile;
  profilePath: string;
}

async function isEmptyOrMissing(directory: string): Promise<boolean> {
  try {
    if (!(await stat(directory)).isDirectory()) return false;
    return (await readdir(directory)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/**
 * Creates a local workspace: organization, business unit and project for one GitHub repository, the operator as
 * owner, optional reviewers, a contributor agent with an owner-only MCP binding, and a profile `npm start` reads.
 * Repository access is a local declaration, not verified with GitHub. Run with the app stopped.
 */
export async function setupWorkspace(options: SetupOptions): Promise<SetupResult> {
  const profilePath = options.profilePath ?? WORKSPACE_PROFILE_PATH;
  if (await readWorkspaceProfile(profilePath)) throw new ValidationError(`A workspace is already set up (${profilePath}). Use it with npm start, or remove that file to start over.`);
  if (!FULL_NAME.test(options.repository.fullName) || !REPOSITORY_ID.test(options.repository.id)) throw new ValidationError("Give the repository as owner/name with its numeric GitHub ID");
  requireDecisionBranch(options.repository.branch);
  const names = [options.operatorName, ...options.reviewerNames, options.agentName ?? "Coding agent"].map((name) => name.trim());
  if (names.some((name) => name.length < 1 || name.length > 100)) throw new ValidationError("Names must be 1 to 100 characters");
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new ValidationError("Use a different name for each person and the agent");
  if (!(await isEmptyOrMissing(options.dataDir))) throw new ValidationError(`${options.dataDir} already holds data; choose a new --data-dir so nothing is overwritten`);
  const now = options.now ?? new Date();
  const db = await openDatabase(options.dataDir);
  try {
    await migrate(db);
    const ctx: MemoryNetContext = createContext(db, { now: () => now, repositoryAccessMaxAgeMs: LOCAL_ACCESS_MAX_AGE_MS });
    const operator = await createPrincipal(ctx, { kind: "human", displayName: options.operatorName.trim() });
    const reviewers = [];
    for (const name of options.reviewerNames) reviewers.push(await createPrincipal(ctx, { kind: "human", displayName: name.trim() }));
    const agent = await createPrincipal(ctx, { kind: "agent", displayName: (options.agentName ?? "Coding agent").trim() });
    const repoName = options.repository.fullName.split("/")[1]!;
    const organizationName = options.organizationName?.trim() || `${options.repository.fullName.split("/")[0]} (local workspace)`;
    const organization = await createOrganization(ctx, operator.id, { slug: slugify(organizationName, "workspace"), name: organizationName });
    const unit = await createBusinessUnit(ctx, operator.id, { organizationId: organization.id, slug: "engineering", name: "Engineering" });
    const project = await createProject(ctx, operator.id, { businessUnitId: unit.id, slug: slugify(repoName, "project"), name: options.repository.fullName });
    const scope = { level: "project" as const, id: project.id };
    for (const reviewer of reviewers) await assignRole(ctx, operator.id, { principalId: reviewer.id, scope, role: "reviewer", reason: "Local workspace setup" });
    await assignRole(ctx, operator.id, { principalId: agent.id, scope, role: repositoryProvider(options.repository.id) === "local" ? "reader" : "contributor", reason: "Local coding agent setup" });
    await connectRepository(ctx, operator.id, { projectId: project.id, provider: repositoryProvider(options.repository.id), externalRepositoryId: options.repository.id, fullName: options.repository.fullName });
    for (const principal of [operator, ...reviewers, agent]) {
      await recordRepositoryAccess(ctx, { principalId: principal.id, provider: repositoryProvider(options.repository.id), externalRepositoryId: options.repository.id, canRead: true });
    }
    await mkdir(dirname(resolve(options.bindingFile)), { recursive: true, mode: 0o700 });
    await writeAgentBindingFile(options.bindingFile, {
      principalId: agent.id, projectId: project.id, repositoryId: options.repository.id, branch: options.repository.branch,
      capabilities: repositoryProvider(options.repository.id) === "local" ? ["context"] : ["context", "propose", "report"], ownerId: operator.id, ttlHours: options.bindingTtlHours ?? 24,
    }, now);
    await db.exec("ANALYZE");
    const profile: WorkspaceProfile = {
      schemaVersion: 1, dataDir: options.dataDir, appUrl: options.appUrl ?? "http://127.0.0.1:3050",
      organizationId: organization.id, projectId: project.id,
      repository: { id: options.repository.id, fullName: options.repository.fullName, branch: options.repository.branch },
      operatorId: operator.id, reviewerIds: reviewers.map((r) => r.id), agentId: agent.id,
      bindingFile: options.bindingFile, createdAt: now.toISOString(),
    };
    await mkdir(dirname(resolve(profilePath)), { recursive: true, mode: 0o700 });
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { profile, profilePath };
  } finally {
    await db.close();
  }
}

/**
 * Renews this workspace's local access declarations that are still granted, so a local trial keeps working past
 * 30 days. Never grants access that was removed. Not a GitHub permission check.
 */
export async function renewLocalAccess(ctx: MemoryNetContext, profile: WorkspaceProfile): Promise<number> {
  const principals = [profile.operatorId, ...profile.reviewerIds, profile.agentId];
  const { rows } = await ctx.db.query<{ principal_id: string }>(
    `SELECT principal_id FROM repository_access WHERE provider = $3 AND external_repository_id = $1
       AND principal_id = ANY($2::uuid[]) AND can_read`,
    [profile.repository.id, principals, repositoryProvider(profile.repository.id)],
  );
  for (const row of rows) {
    await recordRepositoryAccess(ctx, { principalId: row.principal_id, provider: repositoryProvider(profile.repository.id), externalRepositoryId: profile.repository.id, canRead: true });
  }
  return rows.length;
}
