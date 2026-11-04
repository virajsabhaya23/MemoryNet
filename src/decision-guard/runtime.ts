import type { MemoryNetContext } from "../context.ts";
import { buildBriefInput, createBrainBrief, type BrainBrief } from "../brain.ts";
import { MemoryNetError, ValidationError } from "../errors.ts";
import { requireId } from "../validation.ts";
import { GuardProviderError, type GuardProviderDiagnostic, type GuardProviderFailure } from "./errors.ts";
import type { DecisionGuardProvider } from "./model.ts";
import { createMetaModelApiProvider } from "./openai-compatible-meta.ts";
import type { ExtractionForReviewInput } from "./review.ts";
import { createGuardRun, type GuardRun } from "./workflow.ts";

export interface DecisionGuardWebRuntime {
  status(): { configured: boolean; enabled: boolean; model: string; remainingRequests: number; agentId: string | null; maxOutputTokens?: number };
  /** Blank key retains an existing configured key; no key is ever returned. */
  configure(apiKey: string, options: { agentId: string; maxOutputTokens?: number }): Promise<void>;
  forget(): Promise<void>;
  createRun(ctx: MemoryNetContext, requesterId: string, input: ExtractionForReviewInput): Promise<GuardRun>;
  /** A labeled AI synthesis of a project's current approved memories; stored append-only, never knowledge. Optional so test doubles and older runtimes stay valid; routes check for it. */
  brief?(ctx: MemoryNetContext, requesterId: string, input: { projectId: string }): Promise<BrainBrief>;
}

export interface GuardRuntimeOptions {
  apiKey?: string;
  agentId?: string;
  maxRequests?: number;
  fetcher?: typeof fetch;
  /** Dependency injection for offline tests; production uses the permission-bound workflow. */
  run?: typeof createGuardRun;
  maxOutputTokens?: number;
  /** Safe metadata only. Never receives exception objects, prompts, outputs or keys. */
  onFailure?: (event: GuardFailureEvent) => void;
}

export interface GuardFailureEvent {
  event: "meta_request_failed";
  reason: GuardProviderFailure | "input_validation" | "access_denied" | "workflow_failure";
  diagnostic: GuardProviderDiagnostic | null;
  returnedModel: string | null;
  finishReason: string | null;
  model: string;
  remainingRequests: number;
  occurredAt: string;
}

const MODEL = "muse-spark-1.3";

function checkedKey(value: string): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{8,2048}$/.test(value)) {
    throw new ValidationError("Enter a valid Meta Model API key without spaces or line breaks");
  }
  return value;
}

function checkedOutputLimit(value: number): number {
  if (value !== 2048 && value !== 4096) throw new ValidationError("Choose a completion allowance of 2048 or 4096 tokens");
  return value;
}

function containsCredential(value: unknown, secret: string): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && item.includes(secret)) return true;
    if (item !== null && typeof item === "object") {
      for (const [name, child] of Object.entries(item)) {
        if (name.includes(secret)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

function decoded(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/** One local server runtime. Keys stay in closures, never status/DB/disk/browser storage. */
export function createGuardRuntime(options: GuardRuntimeOptions = {}): DecisionGuardWebRuntime {
  const maxRequests = options.maxRequests ?? 5;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 20) {
    throw new ValidationError("Meta request allowance must be between 1 and 20");
  }
  let key = options.apiKey ? checkedKey(options.apiKey) : null;
  let agentId = options.agentId ? requireId(options.agentId, "agentId") : null;
  let used = 0;
  let generation = 0;
  let maxOutputTokens = checkedOutputLimit(options.maxOutputTokens ?? 2048);
  const run = options.run ?? createGuardRun;

  function provider(): DecisionGuardProvider {
    if (!key || !agentId) throw new GuardProviderError("disabled", "Connect a Meta key and choose an extraction agent first");
    const admittedGeneration = generation;
    const admittedKey = key;
    const delegate = createMetaModelApiProvider({ apiKey: admittedKey, enabled: true, maxRequests, maxOutputTokens }, options.fetcher);
    return {
      async complete(messages) {
        if (!key || generation !== admittedGeneration) throw new GuardProviderError("disabled", "Meta configuration changed; start a new extraction");
        if (used >= maxRequests) throw new GuardProviderError("budget", "This server's Meta request allowance is exhausted");
        if (messages.some((message) => containsCredential(message.content, admittedKey) || containsCredential(decoded(message.content), admittedKey))) {
          throw new GuardProviderError("invalid_response", "The selected context contains a configured credential; nothing was sent");
        }
        // Count dispatch attempts, including failures, across every key update and run.
        used += 1;
        const completion = await delegate.complete(messages);
        if (!key || generation !== admittedGeneration) throw new GuardProviderError("disabled", "Meta configuration changed; no new draft was accepted");
        if (containsCredential(completion, admittedKey) || containsCredential(decoded(completion.text), admittedKey)) {
          throw new GuardProviderError("invalid_response", "The provider output contained a configured credential; no draft was accepted");
        }
        return completion;
      },
    };
  }

  return {
    status() {
      return { configured: key !== null, enabled: key !== null && agentId !== null && used < maxRequests, model: MODEL, remainingRequests: Math.max(0, maxRequests - used), agentId, maxOutputTokens };
    },
    async configure(apiKey, input) {
      const nextAgent = requireId(input.agentId, "agentId");
      const nextKey = apiKey === "" && key !== null ? key : checkedKey(apiKey);
      const nextOutputLimit = checkedOutputLimit(input.maxOutputTokens ?? maxOutputTokens);
      key = nextKey;
      agentId = nextAgent;
      maxOutputTokens = nextOutputLimit;
      generation += 1;
    },
    async forget() {
      key = null;
      agentId = null;
      generation += 1;
    },
    async createRun(ctx, requesterId, input) {
      const requestKey = key;
      try {
        if (requestKey && containsCredential(input, requestKey)) {
          throw new ValidationError("Extraction metadata contains a configured credential; nothing was sent or saved");
        }
        const selectedProvider = provider();
        return await run(ctx, requesterId, agentId!, selectedProvider, input);
      } catch (error) {
        const reason = error instanceof GuardProviderError ? error.reason : error instanceof ValidationError ? "input_validation" :
          error instanceof MemoryNetError && (error.code === "forbidden" || error.code === "not_found") ? "access_denied" : "workflow_failure";
        const safeField = (value: string | null) => value !== null &&
          !(requestKey && value.includes(requestKey)) && !(key && value.includes(key)) ? value : null;
        try { options.onFailure?.({ event: "meta_request_failed", reason,
          diagnostic: error instanceof GuardProviderError ? error.diagnostic : null,
          returnedModel: error instanceof GuardProviderError ? safeField(error.metadata.returnedModel) : null,
          finishReason: error instanceof GuardProviderError ? safeField(error.metadata.finishReason) : null,
          model: MODEL, remainingRequests: Math.max(0, maxRequests - used), occurredAt: new Date().toISOString() }); } catch { /* Logging never changes the original outcome. */ }
        throw error;
      }
    },
    async brief(ctx, requesterId, input) {
      // Permission and input checks run before any provider spend.
      const { memories } = await buildBriefInput(ctx, requesterId, input.projectId);
      const selectedProvider = provider();
      const records = memories
        .map((memory) => `ID: ${memory.id}\nTitle: ${memory.title}\n${memory.content}`)
        .join("\n\n");
      const completion = await selectedProvider.complete([
        {
          role: "developer",
          content:
            "You write a short brain brief for an engineering team from the approved memories supplied by the user. Use only those records. Cite the memory ID in brackets after each claim, like [ID]. If the records do not cover something, say so plainly. Never invent decisions, people, or dates.",
        },
        {
          role: "user",
          content: records === "" ? "There are no approved memories in this project yet." : records,
        },
      ]);
      const citations = memories
        .filter((memory) => completion.text.includes(memory.id))
        .map((memory) => memory.id);
      return createBrainBrief(ctx, requesterId, {
        projectId: input.projectId,
        agentId: agentId!,
        model: MODEL,
        content: completion.text,
        citations,
      });
    },
  };
}
