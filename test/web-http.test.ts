import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type IncomingHttpHeaders } from "node:http";
import { test, type TestContext } from "node:test";
import { gunzipSync } from "node:zlib";
import type { App } from "../src/web/app.ts";
import { createLocalHttpServer, MAX_BODY_BYTES } from "../src/web/http.ts";

const APP_PORT = 3050;
const okay: App = async () => ({ status: 200, headers: { "Content-Type": "text/plain" }, body: "ok" });

async function start(t: TestContext, app: App = okay) {
  const http = createLocalHttpServer(app, APP_PORT);
  http.server.listen(0, "127.0.0.1");
  await once(http.server, "listening");
  t.after(() => http.close());
  const address = http.server.address();
  assert.ok(address && typeof address !== "string");
  return { ...http, port: address.port };
}

function send(port: number, options: {
  method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; leaveOpen?: boolean;
} = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, path: options.path ?? "/", method: options.method ?? "GET",
      headers: { Host: `localhost:${APP_PORT}`, ...options.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) });
        req.destroy();
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    if (options.leaveOpen) req.flushHeaders();
    else req.end();
  });
}

test("HTTP rejects untrusted hosts and oversized declared bodies before waiting for uploads", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const http = await start(t, async (req) => { calls++; return okay(req); });
  const untrusted = await send(http.port, { method: "POST", headers: { Host: "attacker.example", "Content-Length": "1000" }, leaveOpen: true });
  assert.equal(untrusted.status, 421);
  assert.equal(untrusted.headers["cache-control"], "no-store");
  const oversized = await send(http.port, { method: "POST", headers: { "Content-Length": String(MAX_BODY_BYTES + 1) }, leaveOpen: true });
  assert.equal(oversized.status, 413);
  assert.equal(calls, 0);
});

test("HTTP delivers 413 for an oversized chunked upload instead of resetting the socket", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const http = await start(t, async (req) => { calls++; return okay(req); });
  const result = await send(http.port, {
    method: "POST", headers: { "Transfer-Encoding": "chunked" },
    body: Buffer.alloc(MAX_BODY_BYTES + 1, "x"), leaveOpen: true,
  });
  assert.equal(result.status, 413);
  assert.equal(result.body.toString(), "This form is too large.");
  assert.equal(calls, 0);
});

test("HTTP accepts a body at the limit and refuses unsupported transport inputs", { timeout: 5000 }, async (t) => {
  let received = "";
  const http = await start(t, async (req) => { received = req.body; return okay(req); });
  const body = "x".repeat(MAX_BODY_BYTES);
  assert.equal((await send(http.port, { method: "POST", body })).status, 200);
  assert.equal(received, body);
  assert.equal((await send(http.port, { method: "POST", headers: { "Content-Encoding": "gzip" }, body: "invalid" })).status, 415);
  assert.equal((await send(http.port, { headers: { "Content-Length": "1" }, body: "x" })).status, 400);
  assert.equal((await send(http.port, { path: "http://attacker.example/" })).status, 400);
  const method = await send(http.port, { method: "DELETE" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, "GET, POST");
});

test("HTTP honors compression exclusions and preferences", { timeout: 5000 }, async (t) => {
  const body = "context ".repeat(300);
  const http = await start(t, async () => ({ status: 200, headers: { "Content-Type": "text/plain", "Content-Length": String(Buffer.byteLength(body)) }, body }));
  const plain = await send(http.port, { headers: { "Accept-Encoding": "br;q=0, gzip;q=0" } });
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.body.toString(), body);
  assert.equal(plain.headers.vary, "Accept-Encoding");
  const compressed = await send(http.port, { headers: { "Accept-Encoding": "br;q=0, gzip;q=1" } });
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(compressed.body).toString(), body);
});

test("HTTP shutdown waits for handlers even after their client disconnects", { timeout: 5000 }, async (t) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const http = await start(t, async (req) => { started.resolve(); await release.promise; return okay(req); });
  t.after(() => release.resolve());
  const req = request({ host: "127.0.0.1", port: http.port, headers: { Host: `localhost:${APP_PORT}` } });
  req.on("error", () => {});
  req.end();
  await started.promise;
  const disconnected = new Promise<void>((resolve) => req.once("close", resolve));
  req.destroy();
  await disconnected;
  let closed = false;
  const closing = http.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve();
  await closing;
  assert.equal(closed, true);
});

test("HTTP shutdown aborts incomplete uploads without waiting for the disabled timeout sweep", { timeout: 5000 }, async (t) => {
  let calls = 0;
  const http = await start(t, async (req) => { calls++; return okay(req); });
  const received = once(http.server, "request");
  const req = request({
    host: "127.0.0.1", port: http.port, method: "POST",
    headers: { Host: `localhost:${APP_PORT}`, "Transfer-Encoding": "chunked" },
  });
  req.on("error", () => {});
  t.after(() => req.destroy());
  req.write("unfinished upload");
  await received;
  await http.close();
  assert.equal(calls, 0);
});
