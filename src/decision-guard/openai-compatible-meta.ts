import { ValidationError } from "../errors.ts";
import { GUARD_OUTPUT_SCHEMA, type DecisionGuardProvider, type GuardCompletion, type GuardReasoningEffort } from "./model.ts";
import { GuardProviderError, type GuardProviderFailure, type GuardProviderMetadata } from "./errors.ts";

export interface MetaProviderConfiguration {
  /** Trusted operator configuration, never a URL supplied by a PR or end user. */
  endpoint: string;
  provider: string;
  /** Exact provider model ID; independently verify publisher, availability and event eligibility. */
  model: string;
  apiKey: string;
  /** Default is disabled. Enabling requires separate authorization for data disclosure and cost. */
  enabled?: boolean;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /** Explicit operator choice. Omitted leaves the compatible provider's behavior unchanged. */
  reasoningEffort?: GuardReasoningEffort;
  /** Hard local attempt cap, including failed requests. Reset only by constructing a new instance. */
  maxRequests?: number;
}

const MAX_RESPONSE_BYTES = 96_000;

/**
 * Wire adapter for a Meta model served by an OpenAI-compatible chat completion endpoint.
 * No endpoint, model, key or billing tier is selected automatically. No retries.
 * This adapter cannot certify model publisher or account credit balance.
 */
export function createMetaCompatibleProvider(
  config: MetaProviderConfiguration,
  fetcher: typeof fetch = fetch,
): DecisionGuardProvider {
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); } catch { throw new ValidationError("Invalid model endpoint configuration"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search ||
      !endpoint.pathname.endsWith("/chat/completions") || !config.provider.trim() || !config.model.trim() || !config.apiKey.trim() ||
      /[\r\n]/.test(config.apiKey)) throw new ValidationError("Invalid model endpoint configuration");
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxOutputTokens = config.maxOutputTokens ?? 2048;
  const maxRequests = config.maxRequests ?? 1;
  const reasoningEffort = config.reasoningEffort;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096 ||
      !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) {
    throw new ValidationError("Invalid model request limits");
  }
  if (reasoningEffort !== undefined && !["minimal", "low", "medium", "high", "xhigh", "max"].some((value) => value === reasoningEffort)) {
    throw new ValidationError("Invalid model reasoning effort");
  }
  const { provider, model, apiKey, enabled } = config;
  // This is the only upstream metadata admitted to an error. Strip credential
  // echoes before constructor-level identifier/enum validation, never log bodies.
  const metadata = (returnedModel: unknown, finishReason?: unknown): GuardProviderMetadata => {
    const scrub = (value: unknown): string | null => typeof value === "string" && !value.includes(apiKey) && !value.includes(apiKey.trim()) ? value : null;
    return { returnedModel: scrub(returnedModel), finishReason: scrub(finishReason) };
  };
  const target = endpoint.href;
  let attempts = 0;
  return {
    async complete(messages): Promise<GuardCompletion> {
      if (enabled !== true) throw new GuardProviderError("disabled", "External model requests are disabled");
      if (attempts >= maxRequests) throw new GuardProviderError("budget", "Model request allowance exhausted");
      if (messages.reduce((size, message) => size + message.content.length, 0) > 44_000) {
        throw new ValidationError("Model request exceeds input limit");
      }
      const controller = new AbortController();
      attempts += 1;
      const startedAt = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const request = async (): Promise<GuardCompletion> => {
        const response = await fetcher(target, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, max_completion_tokens: maxOutputTokens,
            ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }), response_format: {
            type: "json_schema", json_schema: { name: "memorynet_decision_candidates", strict: true, schema: GUARD_OUTPUT_SCHEMA },
          }, stream: false }),
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          const reason: GuardProviderFailure = response.status === 401 || response.status === 403 ? "access" :
            response.status === 402 ? "budget" : response.status === 429 || response.status === 503 ? "busy" :
            response.status === 408 || response.status === 504 ? "timeout" : "unavailable";
          const retry = response.headers.get("retry-after");
          const retryAfterSeconds = retry !== null && /^\d{1,4}$/.test(retry) ? Math.min(Number(retry), 3600) : undefined;
          throw new GuardProviderError(reason, "Model provider refused the request; no decision candidates were accepted", response.status, retryAfterSeconds, "upstream_http");
        }
        if (!response.body) throw new GuardProviderError("invalid_response", "Model provider returned no response body", undefined, undefined, "missing_body");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) throw new GuardProviderError("invalid_response", "Model provider response exceeded the size limit", undefined, undefined, "too_large");
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel(); }
        let raw: unknown;
        try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new GuardProviderError("invalid_response", "Model provider returned invalid JSON", undefined, undefined, "invalid_json"); }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GuardProviderError("invalid_response", "Model provider returned an invalid response envelope", undefined, undefined, "invalid_envelope");
        const data = raw as Record<string, unknown>;
        if (typeof data.model !== "string" || !Array.isArray(data.choices)) throw new GuardProviderError("invalid_response", "Model provider returned an invalid response envelope", undefined, undefined, "invalid_envelope");
        if (data.model !== model) throw new GuardProviderError("invalid_response", "Model provider returned a different model than requested", undefined, undefined, "model_mismatch", metadata(data.model));
        if (data.choices.length !== 1) throw new GuardProviderError("invalid_response", "Model provider returned an unexpected completion count", undefined, undefined, "choice_count");
        const choice = data.choices[0];
        if (!choice || typeof choice !== "object" || Array.isArray(choice) ||
            !choice.message || typeof choice.message !== "object" || Array.isArray(choice.message)) {
          throw new GuardProviderError("invalid_response", "Model provider returned an invalid response envelope", undefined, undefined, "invalid_envelope");
        }
        if (choice.message.refusal !== undefined && choice.message.refusal !== null && typeof choice.message.refusal !== "string") {
          throw new GuardProviderError("invalid_response", "Model provider returned an invalid refusal envelope", undefined, undefined, "invalid_envelope");
        }
        if (choice.finish_reason === "length") throw new GuardProviderError("invalid_response", "Model completion reached its token limit; no candidates were accepted", undefined, undefined, "token_limit", metadata(data.model, choice.finish_reason));
        if (choice.finish_reason === "content_filter" || (typeof choice.message.refusal === "string" && choice.message.refusal.trim() !== "")) {
          throw new GuardProviderError("invalid_response", "Model provider refused the completion; no candidates were accepted", undefined, undefined, "refusal", metadata(data.model, choice.finish_reason));
        }
        if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call" || choice.message.tool_calls || choice.message.function_call) throw new GuardProviderError("invalid_response", "Model provider returned an unexpected tool call", undefined, undefined, "unexpected_tool_call", metadata(data.model, choice.finish_reason));
        if (choice.finish_reason !== "stop") throw new GuardProviderError("invalid_response", "Model provider returned an invalid completion envelope", undefined, undefined, "invalid_envelope", metadata(data.model, choice.finish_reason));
        if (typeof choice.message.content !== "string" || choice.message.content.trim() === "") throw new GuardProviderError("invalid_response", "Model provider returned no completion text", undefined, undefined, "missing_text", metadata(data.model, choice.finish_reason));
        let usage: GuardCompletion["usage"] = null;
        if (data.usage && typeof data.usage === "object") {
          const reported = data.usage as Record<string, unknown>;
          if (Number.isSafeInteger(reported.prompt_tokens) && Number.isSafeInteger(reported.completion_tokens) &&
              (reported.prompt_tokens as number) >= 0 && (reported.completion_tokens as number) >= 0) {
            usage = { inputTokens: reported.prompt_tokens as number, outputTokens: reported.completion_tokens as number };
          }
        }
        const header = response.headers.get("x-request-id");
        const requestId = header !== null && /^[a-zA-Z0-9._:-]{1,128}$/.test(header) ? header : null;
        return { text: choice.message.content, provider, model, usage, requestId,
          latencyMs: Math.max(0, performance.now() - startedAt), parameters: { maxOutputTokens,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } };
      };
      try {
        return await Promise.race([
          request(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => {
            reject(new GuardProviderError("timeout", "Model request timed out; no decision candidates were accepted", undefined, undefined, "timeout"));
            controller.abort();
          }, timeoutMs); }),
        ]);
      } catch (error) {
        controller.abort();
        if (error instanceof GuardProviderError) throw error;
        // Do not attach provider errors: they may contain credentials, prompts or response content.
        throw new GuardProviderError("unavailable", "Model request failed; no decision candidates were accepted", undefined, undefined, "network");
      } finally { clearTimeout(timer); }
    },
  };
}

/** Official Meta configuration; requests light reasoning within the existing output cap.
 * Verified https://dev.meta.ai/docs/reasoning on 2026-10-31. No automatic retries. */
export function createMetaModelApiProvider(
  config: Omit<MetaProviderConfiguration, "endpoint" | "provider" | "model" | "reasoningEffort"> & { model?: string },
  fetcher: typeof fetch = fetch,
): DecisionGuardProvider {
  return createMetaCompatibleProvider({
    ...config,
    provider: "meta-model-api",
    endpoint: "https://api.meta.ai/v1/chat/completions",
    model: config.model ?? "muse-spark-1.3",
    reasoningEffort: "low",
  }, fetcher);
}
