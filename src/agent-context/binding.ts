import { randomBytes } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { requireDecisionBranch } from "../knowledge.ts";
import { AgentScopeSchema } from "./contract.ts";

/** context: read approved guidance. propose: submit pending proposals for human review. report: flag a memory as possibly outdated. */
export const AGENT_CAPABILITIES = ["context", "propose", "report"] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

const Common = AgentScopeSchema.extend({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  principalId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
/** v1: read-only context. */
const BindingV1Schema = Common.extend({ schemaVersion: z.literal(1) }).strict();
/** v2: explicit capabilities, and the person accountable for what the agent proposes. */
const BindingV2Schema = Common.extend({
  schemaVersion: z.literal(2),
  capabilities: z.array(z.enum(AGENT_CAPABILITIES)).min(1).max(3),
  ownerId: z.uuid().nullable(),
}).strict().refine((b) => new Set(b.capabilities).size === b.capabilities.length, "Capabilities must be unique")
  .refine((b) => !b.capabilities.includes("propose") || b.ownerId !== null, "Proposing needs an accountable person");

/** An OS-protected local capability, not production authentication or OAuth. */
export const AgentBindingSchema = z.union([BindingV1Schema, BindingV2Schema]);
export type AgentBinding = z.infer<typeof AgentBindingSchema>;

export function parseAgentBinding(value: unknown): AgentBinding {
  const parsed = AgentBindingSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError("Invalid local agent binding");
  requireDecisionBranch(parsed.data.branch);
  return parsed.data;
}

export function bindingCapabilities(binding: AgentBinding): readonly AgentCapability[] {
  return binding.schemaVersion === 1 ? ["context"] : binding.capabilities;
}

/** The person who answers for proposals made with this binding; null for read-only bindings. */
export function bindingOwner(binding: AgentBinding): string | null {
  return binding.schemaVersion === 1 ? null : binding.ownerId;
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

export interface BindingInput {
  principalId: string;
  projectId: string;
  repositoryId: string;
  branch: string;
  /** Omit both for a read-only v1 binding, exactly as earlier releases wrote. */
  capabilities?: readonly AgentCapability[];
  ownerId?: string | null;
  /** 1 to 168 hours; 24 by default. */
  ttlHours?: number;
}

function newBinding(input: BindingInput, now: Date): AgentBinding {
  const ttl = input.ttlHours ?? 24;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 168) throw new ValidationError("Binding lifetime must be 1 to 168 hours");
  const common = {
    principalId: input.principalId, projectId: input.projectId, repositoryId: input.repositoryId, branch: input.branch,
    token: randomBytes(32).toString("hex"), expiresAt: new Date(now.getTime() + ttl * 60 * 60 * 1000).toISOString(),
  };
  return parseAgentBinding(input.capabilities === undefined && input.ownerId === undefined
    ? { ...common, schemaVersion: 1 }
    : { ...common, schemaVersion: 2, capabilities: [...(input.capabilities ?? ["context"])], ownerId: input.ownerId ?? null });
}

/** Exclusive creation prevents accidentally replacing another client's authority. Grants no DB role. */
export async function writeAgentBindingFile(path: string, input: BindingInput, now = new Date()): Promise<void> {
  const binding = newBinding(input, now);
  await writeFile(path, `${JSON.stringify(binding, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

/**
 * Issues a fresh token and expiry in place. Only replaces a valid owner-only binding for the same agent,
 * project, repository and branch, so it cannot silently take over another client's file.
 */
export async function rotateAgentBindingFile(path: string, input: BindingInput, now = new Date()): Promise<void> {
  const current = await readAgentBindingFile(path);
  if (current.principalId !== input.principalId || current.projectId !== input.projectId ||
      current.repositoryId !== input.repositoryId || current.branch !== input.branch) {
    throw new ValidationError("That binding file belongs to a different agent or scope; choose a new path");
  }
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeAgentBindingFile(temporary, input, now);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
