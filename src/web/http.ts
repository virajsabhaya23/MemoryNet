import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { App } from "./app.ts";
import { SECURITY_HEADERS } from "./kit.ts";

export const MAX_BODY_BYTES = 256 * 1024;

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  // The default async iterator destroys the socket on an early return, preventing
  // the client from receiving our 413 response for a chunked oversized upload.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function refuse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/plain; charset=utf-8",
    // Do not retain a socket with unread or rejected request bytes.
    Connection: "close",
  });
  response.end(message);
}

function encodingQuality(header: string, encoding: string): number {
  let wildcard = 0;
  for (const item of header.toLowerCase().split(",")) {
    const [name, ...parameters] = item.trim().split(";");
    const quality = parameters.find((part) => part.trim().startsWith("q="));
    const parsed = quality === undefined ? 1 : Number(quality.trim().slice(2));
    const q = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    if (name === encoding) return q;
    if (name === "*") wildcard = q;
  }
  return wildcard;
}

/** Shared transport for the local app and public demonstrations. */
export function createLocalHttpServer(app: App, port: number) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const inFlight = new Set<Promise<void>>();
  const requests = new Set<IncomingMessage>();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      // Reject DNS rebinding before accepting any request body.
      if (!hosts.has(request.headers.host ?? "")) {
        refuse(response, 421, "MemoryNet only answers on localhost.");
        return;
      }
      const target = request.url ?? "/";
      if (!target.startsWith("/") || target.startsWith("//")) {
        refuse(response, 400, "Use a local request path.");
        return;
      }
      if (request.method !== "GET" && request.method !== "POST") {
        response.setHeader("Allow", "GET, POST");
        refuse(response, 405, "Method not allowed.");
        return;
      }
      const length = Number(request.headers["content-length"] ?? 0);
      if (length > MAX_BODY_BYTES) {
        refuse(response, 413, "This form is too large.");
        return;
      }
      if (request.headers["content-encoding"] !== undefined && request.headers["content-encoding"] !== "identity") {
        refuse(response, 415, "Compressed request bodies are not supported.");
        return;
      }
      if (request.method === "GET" && (length > 0 || request.headers["transfer-encoding"] !== undefined)) {
        refuse(response, 400, "GET requests cannot contain a body.");
        return;
      }
      const body = request.method === "POST" ? await readBody(request) : "";
      if (body === null) {
        refuse(response, 413, "This form is too large.");
        return;
      }
      const url = new URL(target, `http://localhost:${port}`);
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      const result = await app({ method: request.method, path: url.pathname, query: url.searchParams, headers, body });
      if (response.destroyed) return;
      const resultHeaders = { ...SECURITY_HEADERS, ...result.headers };
      const compressible = !result.binaryBody && result.body.length > 1024 &&
        /^(text\/|image\/svg|application\/json)/.test(result.headers["Content-Type"] ?? "");
      if (compressible) {
        resultHeaders.Vary = resultHeaders.Vary ? `${resultHeaders.Vary}, Accept-Encoding` : "Accept-Encoding";
        const accepts = headers["accept-encoding"] ?? "";
        const br = encodingQuality(accepts, "br");
        const gzip = encodingQuality(accepts, "gzip");
        if (br > 0 || gzip > 0) {
          const useBrotli = br >= gzip;
          const compressed = useBrotli
            ? brotliCompressSync(result.body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
            : gzipSync(result.body, { level: 6 });
          delete resultHeaders["Content-Length"];
          response.writeHead(result.status, { ...resultHeaders, "Content-Encoding": useBrotli ? "br" : "gzip" });
          response.end(compressed);
          return;
        }
      }
      response.writeHead(result.status, resultHeaders);
      response.end(result.binaryBody ?? result.body);
    } catch (error) {
      // An abandoned upload is an ordinary disconnect, not an application error.
      if (request.aborted || response.destroyed) return;
      console.error(error);
      if (!response.headersSent) refuse(response, 500, "Something went wrong.");
      else response.destroy();
    }
  }

  const server = createServer({
    maxHeaderSize: 16 * 1024,
    headersTimeout: 10_000,
    requestTimeout: 30_000,
    connectionsCheckingInterval: 1_000,
    keepAliveTimeout: 5_000,
  }, (request, response) => {
    requests.add(request);
    const pending = handle(request, response);
    inFlight.add(pending);
    void pending.finally(() => { inFlight.delete(pending); requests.delete(request); });
  });

  let closing: Promise<void> | undefined;
  return {
    server,
    close(): Promise<void> {
      return closing ??= (async () => {
        // Node stops its request-timeout sweep when close() begins. Incomplete
        // uploads must therefore be aborted explicitly, and a client that stops
        // reading a response must not keep the listener alive indefinitely.
        const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
        deadline.unref();
        try {
          const stopped = new Promise<void>((resolve, reject) => {
            server.close((error) => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
          });
          for (const request of requests) if (!request.complete) request.destroy();
          await stopped;
          // Disconnected clients can leave handlers finishing a transaction.
          // Drain those too before the caller closes the embedded database.
          await Promise.allSettled(inFlight);
        } finally { clearTimeout(deadline); }
      })();
    },
  };
}
