import { timingSafeEqual } from "node:crypto";
import type { MemoryNetContext } from "../context.ts";
import { MemoryNetError } from "../errors.ts";
import { SECURITY_HEADERS, type WebRequest, type WebResponse } from "../web/kit.ts";
import { parseAgentBinding, type AgentBinding } from "./binding.ts";
import { getAgentContext } from "./service.ts";

export type AgentBindingLoader = () => Promise<AgentBinding>;
function response(status: number, value: unknown): WebResponse {
  return { status, headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(value) };
}
const CODES = { validation_failed: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 } as const;

/** Called only after createApp's loopback Host check. No session/System impersonation fallback. */
export function createAgentContextHandler(ctx: MemoryNetContext, load: AgentBindingLoader) {
  return async (request: WebRequest): Promise<WebResponse> => {
    if (request.method !== "POST") return response(405, { error: "method_not_allowed" });
    if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined) return response(403, { error: "browser_request_refused" });
    let binding: AgentBinding;
    try { binding = parseAgentBinding(await load()); }
    catch { return response(403, { error: "not_authorized" }); }
    const given = request.headers.authorization ?? "";
    const expected = `Bearer ${binding.token}`;
    if (given.length > 256 || Buffer.byteLength(given) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return response(403, { error: "not_authorized" });
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "") || Buffer.byteLength(request.body) > 8192 || request.query.size !== 0) return response(400, { error: "validation_failed" });
    try { return response(200, await getAgentContext(ctx, binding, JSON.parse(request.body))); }
    catch (error) {
      if (error instanceof SyntaxError) return response(400, { error: "validation_failed" });
      if (error instanceof MemoryNetError) return response(CODES[error.code], { error: error.code });
      return response(503, { error: "unavailable" });
    }
  };
}
