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
export const AGENT_TASK_CONTEXT_PATH = "/api/agent/task-context";
export const AGENT_PROPOSALS_PATH = "/api/agent/proposals";
export const AGENT_REPORTS_PATH = "/api/agent/reports";
export const AGENT_PATHS: ReadonlySet<string> = new Set([AGENT_CONTEXT_PATH, AGENT_TASK_CONTEXT_PATH, AGENT_PROPOSALS_PATH, AGENT_REPORTS_PATH]);

// Mirrors MEMORY_TYPES, MEMORY_RELATIONS and CONTENT_FLAGS (a test keeps them equal) so the MCP process
// never imports database code.
export const AGENT_MEMORY_TYPES = ["decision", "rationale", "lesson", "constraint", "failed_approach", "incident"] as const;
export const AGENT_RELATIONS = ["depends_on", "refines", "conflicts_with", "related"] as const;
export const AGENT_CONTENT_FLAGS = ["secret_removed", "personal_data", "truncated", "instruction_like"] as const;
/** v2 citations also carry review flags, so an agent knows when an excerpt looked like instructions. */
const TaskCitationSchema = CitationSchema.extend({ flags: z.array(z.enum(AGENT_CONTENT_FLAGS)).max(4) }).strict();

/** v2 adds task context. Identity, project, repository and branch still come only from the binding. */
export const AgentTaskQuerySchema = z.object({
  task: z.string().trim().min(1).max(2000),
  paths: z.array(z.string().min(1).max(200)).max(50).optional(),
  maxTokens: z.number().int().min(300).max(8000).optional(),
  maxItems: z.number().int().min(1).max(20).optional(),
  depth: z.number().int().min(0).max(2).optional(),
}).strict();
export type AgentTaskQuery = z.infer<typeof AgentTaskQuerySchema>;

const ReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("matched_task") }).strict(),
  z.object({ kind: z.literal("governs_path"), pattern: z.string().max(200), path: z.string().max(200) }).strict(),
  z.object({ kind: z.literal("linked"), subject: z.uuid(), relation: z.enum(AGENT_RELATIONS), object: z.uuid(), replacedObject: z.uuid().nullable() }).strict(),
  z.object({ kind: z.literal("shared_evidence"), memoryId: z.uuid(), sourceId: z.uuid() }).strict(),
]);

export const AgentTaskContextSchema = z.object({
  schemaVersion: z.literal(2),
  scope: AgentScopeSchema,
  retrievalId: z.uuid(), retrievedAt: z.iso.datetime(),
  outcome: z.enum(["results", "no_results"]),
  items: z.array(z.object({
    memoryId: z.uuid(), revision: z.number().int().positive(), type: z.enum(AGENT_MEMORY_TYPES),
    title: z.string(), content: z.string().max(1500), shortened: z.boolean(), compact: z.boolean(),
    approvedBy: z.uuid(), approvedAt: z.iso.datetime(), approvals: z.number().int().positive(),
    score: z.number().min(0).max(1), reasons: z.array(ReasonSchema).min(1).max(30), paths: z.array(z.string().max(200)).max(20),
    citations: z.array(TaskCitationSchema).max(3), moreCitations: z.number().int().nonnegative(),
  }).strict()).max(40),
  conflicts: z.array(z.object({ memoryId: z.uuid(), conflictsWith: z.uuid(), bothDelivered: z.boolean() }).strict()).max(40),
  moreConflicts: z.number().int().nonnegative(),
  changedDependencies: z.array(z.object({ memoryId: z.uuid(), linkedTo: z.uuid(), replacedBy: z.uuid() }).strict()).max(40),
  moreChangedDependencies: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
  budget: z.object({ maxTokens: z.number().int().positive(), usedTokens: z.number().int().nonnegative() }).strict(),
}).strict().refine((r) => (r.outcome === "results") === (r.items.length > 0), "Outcome must match delivered guidance");
export type AgentTaskContextResponse = z.infer<typeof AgentTaskContextSchema>;

/** A pending proposal for human review. Agents can never approve, and a proposal is never guidance. */
export const AgentProposeSchema = z.object({
  type: z.enum(AGENT_MEMORY_TYPES),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4000),
  evidence: z.object({
    sourceIds: z.array(z.uuid()).max(5).optional(),
    pullRequests: z.array(z.object({
      number: z.number().int().min(1).max(999_999_999),
      excerpt: z.string().trim().min(1).max(2000),
      commit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    }).strict()).max(3).optional(),
  }).strict(),
  paths: z.array(z.string().min(1).max(200)).max(20).optional(),
  links: z.array(z.object({ relation: z.enum(AGENT_RELATIONS), memoryId: z.uuid() }).strict()).max(10).optional(),
  change: z.object({ memoryId: z.uuid(), revision: z.number().int().positive(), kind: z.enum(["revise", "replace"]) }).strict().optional(),
}).strict().refine((value) => (value.evidence.sourceIds?.length ?? 0) + (value.evidence.pullRequests?.length ?? 0) > 0,
  "Cite at least one existing source or pull request");
export type AgentProposeInput = z.infer<typeof AgentProposeSchema>;

export const AgentProposalReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  proposalId: z.uuid(),
  revision: z.literal(1),
  status: z.literal("pending"),
  reviewPath: z.string().regex(/^\/proposals\/[0-9a-f-]{36}$/),
  flags: z.array(z.enum(AGENT_CONTENT_FLAGS)).max(4),
  recordedSourceIds: z.array(z.uuid()).max(3),
}).strict();
export type AgentProposalReceipt = z.infer<typeof AgentProposalReceiptSchema>;

export const AgentReportSchema = z.object({ memoryId: z.uuid(), reason: z.string().trim().min(1).max(500) }).strict();
export type AgentReportInput = z.infer<typeof AgentReportSchema>;
export const AgentReportReceiptSchema = z.object({
  schemaVersion: z.literal(1), reportId: z.uuid(), memoryId: z.uuid(), revision: z.number().int().positive(), status: z.literal("open"),
}).strict();
export type AgentReportReceipt = z.infer<typeof AgentReportReceiptSchema>;

/** Published JSON Schemas (docs/contracts/), regenerated by npm run contract:export and checked by tests. */
export const AGENT_CONTRACT_SCHEMAS = [
  ["agent-query-v1", AgentQuerySchema],
  ["agent-context-v1", AgentContextSchema],
  ["agent-task-query-v2", AgentTaskQuerySchema],
  ["agent-task-context-v2", AgentTaskContextSchema],
  ["agent-proposal-v1", AgentProposeSchema],
  ["agent-proposal-receipt-v1", AgentProposalReceiptSchema],
  ["agent-report-v1", AgentReportSchema],
  ["agent-report-receipt-v1", AgentReportReceiptSchema],
] as const;
