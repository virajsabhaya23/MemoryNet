import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { WorkInputSchema, type WorkInput } from "./work.ts";

const exec = promisify(execFile);
/** Read committed blobs only. Never executes repository code or reads working-tree paths. */
export async function reconcileWorkArtifacts(repository: string, baseline: Pick<WorkInput, "codeCommit" | "artifacts">) {
  const parsed = WorkInputSchema.pick({ codeCommit: true, artifacts: true }).parse(baseline);
  const git = async (...args: string[]) => (await exec("git", ["--no-replace-objects", "-C", repository, ...args],
    { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 10_000 })).stdout;
  // Require the exact commit, not a tag, abbreviation, revision expression or replacement object.
  const commit = (await git("rev-parse", "--verify", `${parsed.codeCommit}^{commit}`)).toString().trim();
  if (commit !== parsed.codeCommit) throw new Error("Expected exact commit object");
  const artifacts = [];
  for (const artifact of parsed.artifacts) {
    const tree = (await git("ls-tree", "-z", commit, "--", `:(literal)${artifact.path}`)).toString();
    const entry = tree.slice(0, tree.indexOf("\t")).split(" ");
    if (!tree) {
      artifacts.push({ ...artifact, observedSha256: null, status: "missing" as const });
      continue;
    }
    if (entry[1] !== "blob" || !["100644", "100755"].includes(entry[0]!)) {
      artifacts.push({ ...artifact, observedSha256: null, status: "unsupported" as const });
      continue;
    }
    const bytes = await git("cat-file", "blob", entry[2]!);
    const observedSha256 = createHash("sha256").update(bytes).digest("hex");
    artifacts.push({ ...artifact, observedSha256, status: observedSha256 === artifact.sha256 ? "match" as const : "changed" as const });
  }
  return { schemaVersion: 1, evidenceKind: "local_git_artifact_observation", codeCommit: commit,
    checkedAt: new Date().toISOString(), outcome: artifacts.every(a => a.status === "match") ? "match" : "review_needed",
    verification: "Committed bytes only; repository identity, branch, current decision authority, requirement semantics and code behavior are not verified.", artifacts };
}
