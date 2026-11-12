import type { z } from "zod";
import {
  AGENT_REVALIDATE_PATH, ReceiptQuerySchema, ReceiptCheckV2Schema, type ReceiptQuery, type ReceiptCheck,
  AGENT_CONTEXT_PATH,
  AGENT_PROPOSALS_PATH,
  AGENT_REPORTS_PATH,
  AGENT_TASK_CONTEXT_PATH,
  AgentContextSchema,
  AgentProposalReceiptSchema,
  AgentProposeSchema,
  AgentQuerySchema,
  AgentReportReceiptSchema,
  AgentReportSchema,
  AgentTaskContextV3Schema,
  AgentTaskQuerySchema,
  type AgentContextResponse,
  type AgentProposalReceipt,
  type AgentProposeInput,
  type AgentQuery,
  type AgentReportInput,
  type AgentReportReceipt,
  type AgentTaskContextResponse,
  type AgentTaskQuery,
} from "../agent-context/contract.ts";
import { UnavailableError, ValidationError } from "../errors.ts";

/** MemoryNet understood the request and refused it, for example because of the project policy. */
export class AgentRequestRefused extends Error {
  readonly code: string;
  constructor(code: string, reason: string | null) {
    super(reason ?? "MemoryNet refused the request");
    this.name = "AgentRequestRefused";
    this.code = code;
  }
}

export interface AgentBridge {
  revalidate(input: ReceiptQuery): Promise<ReceiptCheck>;
  context(input: AgentQuery): Promise<AgentContextResponse>;
  taskContext(input: AgentTaskQuery): Promise<AgentTaskContextResponse>;
  propose(input: AgentProposeInput): Promise<AgentProposalReceipt>;
  report(input: AgentReportInput): Promise<AgentReportReceipt>;
}

const REFUSALS = new Set(["validation_failed", "forbidden", "not_found", "conflict"]);

/** Loopback only, fixed paths, no redirects; the stdio process never opens the web process's PGlite file. */
export function createAgentBridge(baseUrl: string, token: string): AgentBridge {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.port || !/^[a-f0-9]{64}$/.test(token)) throw new ValidationError("MCP bridge requires a loopback app URL and local credential");
  async function call<I, O>(path: string, input: unknown, request: z.ZodType<I>, reply: z.ZodType<O>, explain: boolean): Promise<O> {
    const parsed = request.safeParse(input);
    if (!parsed.success) throw new ValidationError("Invalid request");
    let refusal: AgentRequestRefused | null = null;
    try {
      const result = await fetch(new URL(path, url), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(parsed.data), redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!result.headers.get("content-type")?.startsWith("application/json")) { await result.body?.cancel(); throw new Error("Unexpected response"); }
      const reader = result.body?.getReader();
      if (!reader) throw new Error("Missing response");
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength; if (length > 256_000) throw new Error("Response too large"); chunks.push(part.value); }
      } finally { await reader.cancel().catch(() => undefined); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (!result.ok) {
        const error = body as { error?: unknown; message?: unknown };
        if (explain && typeof error.error === "string" && REFUSALS.has(error.error)) {
          const message = typeof error.message === "string" && !error.message.includes(token)
            ? error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300) : null;
          refusal = new AgentRequestRefused(error.error, message);
        }
        throw new Error("Request refused");
      }
      return reply.parse(body);
    } catch {
      if (refusal) throw refusal;
      throw new UnavailableError("MemoryNet request failed; nothing was delivered or recorded by this call");
    }
  }
  return {
    revalidate: input => call(AGENT_REVALIDATE_PATH, input, ReceiptQuerySchema, ReceiptCheckV2Schema, true),
    context: (input) => call(AGENT_CONTEXT_PATH, input, AgentQuerySchema, AgentContextSchema, false),
    taskContext: (input) => call(AGENT_TASK_CONTEXT_PATH, input, AgentTaskQuerySchema, AgentTaskContextV3Schema, true),
    propose: (input) => call(AGENT_PROPOSALS_PATH, input, AgentProposeSchema, AgentProposalReceiptSchema, true),
    report: (input) => call(AGENT_REPORTS_PATH, input, AgentReportSchema, AgentReportReceiptSchema, true),
  };
}

/** The v1 read-only bridge: any failure is reported as unavailable, never as an empty result. */
export function createContextBridge(baseUrl: string, token: string): (input: AgentQuery) => Promise<AgentContextResponse> {
  const bridge = createAgentBridge(baseUrl, token);
  return async (input) => {
    try { return await bridge.context(input); }
    catch { throw new UnavailableError("MemoryNet context request failed; no guidance was delivered"); }
  };
}
