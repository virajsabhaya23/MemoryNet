import { z } from "zod";

/** v1 is current-only, exact-branch and read-only. Identity/scope are never client arguments. */
export const AgentQuerySchema = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();
export type AgentQuery = z.infer<typeof AgentQuerySchema>;

export const AgentScopeSchema = z.object({
  projectId: z.uuid(),
  repositoryId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  branch: z.string().min(1).max(255),
}).strict();

const CitationSchema = z.object({
  sourceId: z.uuid(), reference: z.string(), url: z.url(), revision: z.string().nullable(),
  excerpt: z.string().max(400), shortened: z.boolean(),
}).strict();

export const AgentContextSchema = z.object({
  schemaVersion: z.literal(1),
  scope: AgentScopeSchema,
  retrievalId: z.uuid(), retrievedAt: z.iso.datetime(),
  outcome: z.enum(["results", "no_results"]), moreMatches: z.boolean(),
  current: z.array(z.object({
    memoryId: z.uuid(), revision: z.number().int().positive(), type: z.string(),
    title: z.string(), content: z.string().max(1500), shortened: z.boolean(),
    approvedBy: z.uuid(), approvedAt: z.iso.datetime(),
    citations: z.array(CitationSchema).max(3), moreCitations: z.number().int().nonnegative(),
  }).strict()).max(20),
}).strict().refine((r) => (r.outcome === "results") === (r.current.length > 0), "Outcome must match current guidance");
export type AgentContextResponse = z.infer<typeof AgentContextSchema>;

export const AGENT_CONTEXT_PATH = "/api/agent/context";
