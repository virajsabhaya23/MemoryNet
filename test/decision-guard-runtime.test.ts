// Runtime wiring uses injected HTTP and workflow doubles, never a live Meta call.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryNetContext } from "../src/context.ts";
import { createGuardRuntime } from "../src/decision-guard/runtime.ts";
import type { createGuardRun, GuardRun } from "../src/decision-guard/workflow.ts";

const AGENT = "10000000-0000-4000-8000-000000000001";
const KEY = "controlled-runtime-secret";
const ctx = {} as MemoryNetContext;
const input = { projectId: AGENT, sourceIds: [AGENT] };
const run: typeof createGuardRun = async (_ctx, _human, _agent, provider) => {
  await provider.complete([{ role: "user", content: "Original controlled test text." }]);
  return { id: "controlled-run" } as GuardRun;
};
function envelope() {
  return Response.json({ model: "muse-spark-1.3", choices: [{ finish_reason: "stop", message: { content: '{"candidates":[]}' } }] });
}

test("selected applicability cannot persist a configured credential outside the model prompt", async () => {
  let calls = 0; let workflows = 0;
  const runtime = createGuardRuntime({ apiKey: KEY, agentId: AGENT,
    run: async (...args) => { workflows++; return run(...args); },
    fetcher: async () => { calls++; return envelope(); } });
  await assert.rejects(runtime.createRun(ctx, AGENT, { ...input,
    applicability: { repositoryId: "1001", branch: KEY, validFrom: "2026-10-30T00:00:00.000Z" } }), /metadata contains a configured credential/);
  assert.equal(calls, 0);
  assert.equal(workflows, 0);
  assert.equal(runtime.status().remainingRequests, 5);
});

test("the masked-setup runtime never calls Meta or returns key material on configuration", async () => {
  let calls = 0;
  const runtime = createGuardRuntime({ run, fetcher: async () => { calls++; return envelope(); } });
  assert.equal(runtime.status().configured, false);
  await runtime.configure(KEY, { agentId: AGENT });
  assert.equal(calls, 0);
  assert.equal(runtime.status().enabled, true);
  assert.equal(JSON.stringify(runtime.status()).includes(KEY), false);
  assert.equal(JSON.stringify(runtime).includes(KEY), false);
  await runtime.configure("", { agentId: AGENT });
  await runtime.createRun(ctx, AGENT, input);
  assert.equal(calls, 1);
});

test("failed requests count and configuring or forgetting the key cannot refill the allowance", async () => {
  let calls = 0;
  const runtime = createGuardRuntime({ run, maxRequests: 1, fetcher: async () => { calls++; throw new Error("controlled upstream details"); } });
  await runtime.configure(KEY, { agentId: AGENT });
  await assert.rejects(runtime.createRun(ctx, AGENT, input), /Model request failed/);
  await runtime.forget();
  await runtime.configure("another-controlled-secret", { agentId: AGENT });
  await assert.rejects(runtime.createRun(ctx, AGENT, input), /allowance is exhausted/);
  assert.equal(runtime.status().remainingRequests, 0);
  assert.equal(calls, 1);
});

test("concurrent runs cannot exceed the process attempt allowance", async () => {
  let calls = 0;
  const runtime = createGuardRuntime({ apiKey: KEY, agentId: AGENT, run, maxRequests: 1, fetcher: async () => { calls++; return envelope(); } });
  const outcomes = await Promise.allSettled([runtime.createRun(ctx, AGENT, input), runtime.createRun(ctx, AGENT, input)]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
});

test("invalid secret input and missing agent fail without echoing the input", async () => {
  const runtime = createGuardRuntime({ run });
  for (const bad of ["", "abc", "secret\ncontrolled", "secret controlled"]) {
    await assert.rejects(runtime.configure(bad, { agentId: AGENT }), (error: Error) => {
      assert.doesNotMatch(error.message, /secret|abc/);
      return true;
    });
  }
  await assert.rejects(runtime.createRun(ctx, AGENT, input), /Connect a Meta key/);
  assert.equal(runtime.status().remainingRequests, 5);
});

test("forgetting a key while the provider is in flight refuses its completed output", async () => {
  let release!: (response: Response) => void;
  let admitted!: () => void;
  const started = new Promise<void>((resolve) => { admitted = resolve; });
  const runtime = createGuardRuntime({ apiKey: KEY, agentId: AGENT, run, fetcher: async () => {
    admitted();
    return new Promise<Response>((resolve) => { release = resolve; });
  } });
  const pending = runtime.createRun(ctx, AGENT, input);
  await started;
  await runtime.forget();
  release(envelope());
  await assert.rejects(pending, /configuration changed/);
  assert.equal(runtime.status().configured, false);
  assert.equal(runtime.status().remainingRequests, 4);
});

test("unauthorized preflight failures do not consume a model request", async () => {
  const runtime = createGuardRuntime({ apiKey: KEY, agentId: AGENT, run: async () => { throw new Error("controlled preflight denial"); } });
  await assert.rejects(runtime.createRun(ctx, AGENT, input), /preflight denial/);
  assert.equal(runtime.status().remainingRequests, 5);
});

test("upstream credential echoes including escaped JSON and request metadata are never accepted", async () => {
  for (const mode of ["plain", "escaped", "requestId"]) {
    const runtime = createGuardRuntime({ apiKey: KEY, agentId: AGENT, run, fetcher: async () => {
      const text = mode === "plain" ? JSON.stringify({ candidates: [{ decision: KEY }] }) :
        mode === "escaped" ? '{"candidate":"' + [...KEY].map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, "0")).join("") + '"}' : '{"candidates":[]}';
      return Response.json({ model: "muse-spark-1.3", choices: [{ finish_reason: "stop", message: { content: text } }] },
        { headers: mode === "requestId" ? { "x-request-id": KEY } : {} });
    } });
    await assert.rejects(runtime.createRun(ctx, AGENT, input), (error: Error) => {
      assert.match(error.message, /configured credential/);
      assert.ok(!error.message.includes(KEY));
      return true;
    });
  }
});

test("the actual configured credential cannot be sent inside model context", async () => {
  let calls = 0;
  const unsafeRun: typeof createGuardRun = async (_ctx, _human, _agent, provider) => {
    await provider.complete([{ role: "user", content: JSON.stringify({ source: KEY }) }]);
    return {} as GuardRun;
  };
  const runtime = createGuardRuntime({ apiKey: KEY, agentId: AGENT, run: unsafeRun, fetcher: async () => { calls++; return envelope(); } });
  await assert.rejects(runtime.createRun(ctx, AGENT, input), /nothing was sent/);
  assert.equal(calls, 0);
  assert.equal(runtime.status().remainingRequests, 5);
});

test("completion allowance changes retain the key and request counter without dispatch", async () => {
  const limits: number[] = [];
  const runtime = createGuardRuntime({ apiKey: KEY, agentId: AGENT, run, fetcher: async (_url, request) => {
    limits.push(JSON.parse(request!.body as string).max_completion_tokens);
    return envelope();
  } });
  await runtime.createRun(ctx, AGENT, input);
  await runtime.configure("", { agentId: AGENT, maxOutputTokens: 4096 });
  assert.equal(runtime.status().remainingRequests, 4);
  assert.equal(runtime.status().maxOutputTokens, 4096);
  assert.deepEqual(limits, [2048]);
  await runtime.createRun(ctx, AGENT, input);
  assert.deepEqual(limits, [2048, 4096]);
  await assert.rejects(runtime.configure("", { agentId: AGENT, maxOutputTokens: 100000 }));
  assert.equal(runtime.status().remainingRequests, 3);
});

test("failure logging receives only whitelisted metadata and never changes the failure", async () => {
  const events: unknown[] = [];
  const runtime = createGuardRuntime({ apiKey: KEY, agentId: AGENT, run, fetcher: async () => { throw new Error(KEY); },
    onFailure(event) { events.push(event); throw new Error("controlled logger failure"); } });
  await assert.rejects(runtime.createRun(ctx, AGENT, input), /Model request failed/);
  assert.equal(events.length, 1);
  const event = events[0] as Record<string, unknown>;
  assert.equal(event.event, "meta_request_failed");
  assert.equal(event.reason, "unavailable");
  assert.equal(event.remainingRequests, 4);
  assert.ok(!JSON.stringify(events).includes(KEY));
  assert.deepEqual(Object.keys(event).sort(), ["diagnostic", "event", "finishReason", "model", "occurredAt", "reason", "remainingRequests", "returnedModel"]);
});
