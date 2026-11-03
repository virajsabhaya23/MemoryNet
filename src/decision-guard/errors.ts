import { UnavailableError } from "../errors.ts";

export type GuardProviderFailure = "disabled" | "budget" | "access" | "busy" | "timeout" | "invalid_response" | "unavailable";
export const GUARD_PROVIDER_DIAGNOSTICS = [
  "missing_body", "too_large", "invalid_json", "invalid_envelope", "model_mismatch", "choice_count", "token_limit", "refusal", "missing_text", "unexpected_tool_call", "network", "timeout", "upstream_http",
] as const;
export type GuardProviderDiagnostic = (typeof GUARD_PROVIDER_DIAGNOSTICS)[number];
export const GUARD_FINISH_REASONS = ["stop", "length", "tool_calls", "content_filter", "function_call"] as const;
export type GuardFinishReason = (typeof GUARD_FINISH_REASONS)[number];
export interface GuardProviderMetadata { returnedModel?: string | null; finishReason?: string | null }
export interface GuardProviderSafeMetadata { returnedModel: string | null; finishReason: GuardFinishReason | null }

/** Stable UI-safe diagnostics. Never include upstream bodies, prompts, keys or causes. */
export class GuardProviderError extends UnavailableError {
  readonly reason: GuardProviderFailure;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;
  readonly diagnostic: GuardProviderDiagnostic | null;
  readonly metadata: GuardProviderSafeMetadata;

  constructor(reason: GuardProviderFailure, message: string, httpStatus?: number, retryAfterSeconds?: number, diagnostic?: GuardProviderDiagnostic, metadata?: GuardProviderMetadata) {
    super(message);
    this.reason = reason;
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus! >= 400 && httpStatus! <= 599 ? httpStatus! : null;
    this.retryAfterSeconds = Number.isInteger(retryAfterSeconds) && retryAfterSeconds! >= 0 && retryAfterSeconds! <= 3600 ? retryAfterSeconds! : null;
    this.diagnostic = diagnostic !== undefined && GUARD_PROVIDER_DIAGNOSTICS.includes(diagnostic) ? diagnostic : null;
    this.metadata = {
      returnedModel: typeof metadata?.returnedModel === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(metadata.returnedModel) ? metadata.returnedModel : null,
      finishReason: typeof metadata?.finishReason === "string" && (GUARD_FINISH_REASONS as readonly string[]).includes(metadata.finishReason) ? metadata.finishReason as GuardFinishReason : null,
    };
  }
}
