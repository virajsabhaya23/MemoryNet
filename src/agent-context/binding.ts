import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { requireDecisionBranch } from "../knowledge.ts";
import { AgentScopeSchema } from "./contract.ts";

/** An OS-protected local capability, not production authentication or OAuth. */
export const AgentBindingSchema = AgentScopeSchema.extend({
  schemaVersion: z.literal(1),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  principalId: z.uuid(),
  expiresAt: z.iso.datetime(),
}).strict();
export type AgentBinding = z.infer<typeof AgentBindingSchema>;

export function parseAgentBinding(value: unknown): AgentBinding {
  const parsed = AgentBindingSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Invalid local agent binding");
  requireDecisionBranch(parsed.data.branch);
  return parsed.data;
}

/** Never print this file: it contains an independent local bearer credential, not the Meta key. */
export async function readAgentBindingFile(path: string): Promise<AgentBinding> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 16_384 ||
      (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
    throw new ValidationError("Agent binding must be a small owner-only file (chmod 600)");
  }
  return parseAgentBinding(JSON.parse(await readFile(path, "utf8")));
}

/** Exclusive creation prevents accidentally replacing another client's authority. Grants no DB role. */
export async function writeAgentBindingFile(path: string, input: {
  principalId: string; projectId: string; repositoryId: string; branch: string;
}, now = new Date()): Promise<void> {
  const binding = parseAgentBinding({ ...input, schemaVersion: 1,
    token: randomBytes(32).toString("hex"), expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString() });
  await writeFile(path, `${JSON.stringify(binding, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
