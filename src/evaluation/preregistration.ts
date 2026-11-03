import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const artifact = z.object({
  path: z.string().min(1).max(240).refine(p => !isAbsolute(p) && !p.includes("\\") && p.split("/").every(s => s !== ".." && s !== "." && s !== ""), "Use a relative path without traversal"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const task = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  prompt: artifact,
  evidence: artifact,
  instructionsBefore: artifact,
  instructionsAfter: artifact,
  oracle: artifact,
  changeAtToolCall: z.number().int().min(1),
  concurrentTasks: z.number().int().min(2).max(10),
}).strict();
export const preregistrationSchema = z.object({
  schemaVersion: z.literal(1),
  studyId: z.string().regex(/^[a-z0-9-]{1,64}$/),
  purpose: z.enum(["smoke", "study"]),
  repository: z.object({ url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  model: z.object({ provider: z.string().min(1).max(100), id: z.string().min(1).max(200), parameters: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])) }).strict(),
  arms: z.tuple([z.literal("maintained-agents-md"), z.literal("memorynet")]),
  budgetPerTaskPerArm: z.object({ maxToolCalls: z.number().int().min(2).max(500), maxOutputTokens: z.number().int().min(1).max(200_000), maxMinutes: z.number().int().min(1).max(120) }).strict(),
  repetitions: z.number().int().min(1).max(10),
  primaryMetrics: z.tuple([z.literal("stale_implementation_rate"), z.literal("human_maintenance_minutes")]),
  tasks: z.array(task).min(1).max(50),
}).strict().superRefine((plan, ctx) => {
  if (plan.purpose === "study" && plan.tasks.length < 10) ctx.addIssue({ code: "custom", message: "A study requires at least ten decision changes" });
  if (new Set(plan.tasks.map(t => t.id)).size !== plan.tasks.length) ctx.addIssue({ code: "custom", message: "Task IDs must be unique" });
  for (const t of plan.tasks) {
    if (t.changeAtToolCall >= plan.budgetPerTaskPerArm.maxToolCalls) ctx.addIssue({ code: "custom", message: "Decision change must precede the tool budget limit" });
    if (t.instructionsBefore.sha256 === t.instructionsAfter.sha256) ctx.addIssue({ code: "custom", message: "Before and after instructions must differ" });
  }
});

/** Validates real input bytes and a clean pinned checkout; never executes the evaluator or agents. */
export async function freezePreregistration(manifestPath: string, repositoryPath: string, outputPath: string) {
  const manifestBytes = await boundedRead(resolve(manifestPath), 1_000_000);
  const plan = preregistrationSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  const git = (...args: string[]) => execFileSync("git", ["-C", resolve(repositoryPath), ...args], { encoding: "utf8", maxBuffer: 1_000_000, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git("rev-parse", "HEAD") !== plan.repository.commit) throw new Error("Repository HEAD differs from the registered commit");
  if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("Repository must be clean before registration");
  const normalize = (url: string) => url.replace(/\.git$/, "").toLowerCase();
  if (normalize(git("remote", "get-url", "origin")) !== normalize(plan.repository.url)) throw new Error("Repository origin differs from the registered HTTPS URL");
  const root = await realpath(dirname(resolve(manifestPath)));
  const snapshots: { path: string; sha256: string; contentBase64: string }[] = [];
  let total = 0;
  for (const t of plan.tasks) {
    for (const a of [t.prompt, t.evidence, t.instructionsBefore, t.instructionsAfter, t.oracle]) {
      const existing = snapshots.find(s => s.path === a.path);
      if (existing) {
        if (existing.sha256 !== a.sha256) throw new Error("Conflicting artifact hashes");
        continue;
      }
      let current = root;
      for (const segment of a.path.split("/")) {
        current = join(current, segment);
        if ((await lstat(current)).isSymbolicLink()) throw new Error("Artifact symlinks are not permitted");
      }
      const actual = await realpath(current);
      const within = relative(root, actual);
      if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("Artifact escapes the manifest directory");
      const bytes = await boundedRead(actual, 1_000_000);
      total += bytes.length;
      if (total > 16_000_000) throw new Error("Artifact bundle exceeds 16 MB");
      if (digest(bytes) !== a.sha256) throw new Error(`Artifact hash mismatch: ${a.path}`);
      snapshots.push({ path: a.path, sha256: a.sha256, contentBase64: bytes.toString("base64") });
    }
  }
  const payload = { schemaVersion: 1, frozenAt: new Date().toISOString(), manifestSha256: digest(manifestBytes), plan, snapshots };
  const lock = { ...payload, payloadSha256: digest(JSON.stringify(payload)) };
  const file = await open(resolve(outputPath), "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(lock, null, 2)}\n`); } finally { await file.close(); }
  return { studyId: plan.studyId, tasks: plan.tasks.length, artifactCount: snapshots.length, payloadSha256: lock.payloadSha256 };
}

async function boundedRead(path: string, limit: number): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("Input must be a bounded regular file");
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error("Input exceeds the byte limit");
  return bytes;
}
