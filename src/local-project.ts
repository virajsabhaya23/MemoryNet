import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { createContext, inTransaction } from "./context.ts";
import { openMigratedDatabase } from "./database-upgrade.ts";
import { connectRepository, recordRepositoryAccess } from "./repositories.ts";
import { recordSource } from "./knowledge.ts";
import { selectedCheckout, type LocalRepository } from "./local-discovery.ts";
import { LOCAL_ACCESS_MAX_AGE_MS, setupWorkspace } from "./setup.ts";
import { readWorkspaceProfile, type WorkspaceProfile } from "./workspace.ts";

export function localProfilePath(repo: LocalRepository, state: string) {
  const refKey = createHash("sha256").update(repo.branch).digest("hex").slice(0, 16);
  return resolve(state, repo.id, refKey, "workspace.json");
}

export async function registerLocalProject(repo: LocalRepository, state: string, at: string, port = 3050) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a loopback port from 1024 to 65535");
  if (repo.commit !== at) throw new Error("HEAD differs from the preview. Preview again.");
  const profilePath = localProfilePath(repo, state);
  const previous = await readWorkspaceProfile(profilePath);
  if (previous) {
    if (previous.repository.id !== repo.id || previous.repository.branch !== repo.branch) throw new Error("Profile scope mismatch");
    return previous;
  }
  // Build a complete isolated project before publishing its directory. Failed/concurrent attempts never
  // merge credentials with another registration or damage the winning database.
  const parent = resolve(state, repo.id);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(parent, ".register-"));
  const target = resolve(profilePath, "..");
  try {
    const name = repo.project === "." ? "checkout" : basename(repo.project);
    const result = await setupWorkspace({
      repository: { fullName: "local/" + name, id: repo.id, branch: repo.branch },
      appUrl: `http://127.0.0.1:${port}`,
      operatorName: "Fixture operator", reviewerNames: ["Fixture reviewer"],
      dataDir: join(stage, "data"), bindingFile: join(stage, "binding.json"), profilePath: join(stage, "workspace.json"),
    });
    const profile = { ...result.profile, dataDir: join(target, "data"), bindingFile: join(target, "binding.json") };
    await writeFile(join(stage, "workspace.json"), JSON.stringify(profile, null, 2) + "\n");
    try { await rename(stage, target); }
    catch (e) {
      if (!["ENOTEMPTY", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      const winner = await readWorkspaceProfile(profilePath);
      if (!winner || winner.repository.id !== repo.id || winner.repository.branch !== repo.branch) throw e;
      return winner;
    }
    return profile;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function importLocalDocument(root: string, project: string, at: string, document: string, profile: WorkspaceProfile, publicSourceProject?: string) {
  if (publicSourceProject) {
    const { repository: target } = await selectedCheckout(root, project);
    if (target.id !== profile.repository.id || target.branch !== profile.repository.branch) throw new Error("Target profile no longer matches this checkout");
  }
  const { repository, evidence } = await selectedCheckout(root, publicSourceProject ?? project, document);
  if (!evidence || repository.commit !== at || (!publicSourceProject && (repository.id !== profile.repository.id || repository.branch !== profile.repository.branch))) {
    throw new Error("Checkout no longer matches the selected branch and preview. Preview again.");
  }
  const { db } = await openMigratedDatabase(profile.dataDir);
  try {
    const ctx = createContext(db, { repositoryAccessMaxAgeMs: LOCAL_ACCESS_MAX_AGE_MS });
    return await db.transaction(async tx => {
      const scoped = inTransaction(ctx, tx);
      if (publicSourceProject && repository.id !== profile.repository.id) {
        // First explicit public attachment only. A retry must never reconnect or reinstate revoked access.
        const previous = await tx.query("SELECT 1 FROM repository_connections WHERE provider='local' AND external_repository_id=$1", [repository.id]);
        if (!previous.rows.length) {
          await connectRepository(scoped, profile.operatorId, { projectId: profile.projectId, provider: "local",
            externalRepositoryId: repository.id, fullName: "local/" + (repository.project === "." ? "checkout" : basename(repository.project)) });
          for (const principalId of [profile.operatorId, ...profile.reviewerIds, profile.agentId]) {
            const existing = await tx.query("SELECT 1 FROM repository_access WHERE provider='local' AND external_repository_id=$1 AND principal_id=$2",
              [repository.id, principalId]);
            if (existing.rows.length) continue;
            await recordRepositoryAccess(scoped, { principalId, provider: "local", externalRepositoryId: repository.id, canRead: true });
          }
        }
      }
      return recordSource(scoped, profile.operatorId, { projectId: profile.projectId, provider: "local",
        externalRepositoryId: repository.id, revision: at, reference: evidence.reference, url: evidence.url, excerpt: evidence.excerpt });
    });
  } finally { await db.close(); }
}
