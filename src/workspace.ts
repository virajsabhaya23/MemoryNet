import { REPOSITORY_ID } from "./repository-identity.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

/** Written by `npm run setup`; holds paths and identifiers only, never credentials. */
export const WORKSPACE_PROFILE_PATH = ".local/memorynet/workspace.json";
export const DEFAULT_DATA_DIR = ".data/memorynet";

export const WorkspaceProfileSchema = z.object({
  schemaVersion: z.literal(1),
  dataDir: z.string().min(1).max(500),
  appUrl: z.url(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  repository: z.object({
    id: z.string().regex(REPOSITORY_ID),
    fullName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/),
    branch: z.string().min(1).max(255),
  }).strict(),
  operatorId: z.uuid(),
  reviewerIds: z.array(z.uuid()).max(10),
  agentId: z.uuid(),
  bindingFile: z.string().min(1).max(500),
  createdAt: z.iso.datetime(),
}).strict();
export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;

export async function readWorkspaceProfile(path = process.env.MEMORYNET_WORKSPACE_PROFILE || WORKSPACE_PROFILE_PATH): Promise<WorkspaceProfile | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = WorkspaceProfileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${path} is not a valid MemoryNet workspace profile; run npm run setup again`);
  return parsed.data;
}

/** MEMORYNET_DATA_DIR, else the workspace from `npm run setup`, else the default. */
export async function workspaceDataDir(): Promise<string> {
  if (process.env.MEMORYNET_DATA_DIR) return process.env.MEMORYNET_DATA_DIR;
  const profile = await readWorkspaceProfile();
  return profile ? resolve(profile.dataDir) : DEFAULT_DATA_DIR;
}
