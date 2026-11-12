import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { findPrincipal } from "../access.ts";
import { listReviewQueue } from "../knowledge.ts";
import { listOrganizations } from "../organizations.ts";
import {
  createAgentContextHandler,
  type AgentBindingLoader,
} from "../agent-context/http.ts";
import { AGENT_PATHS } from "../agent-context/contract.ts";
import type { MemoryNetContext } from "../context.ts";
import type { DecisionGuardWebRuntime } from "../decision-guard/runtime.ts";
import { MemoryNetError, ValidationError, type ErrorCode } from "../errors.ts";
import {
  errorPage,
  isTheme,
  redirect,
  SECURITY_HEADERS,
  themeCookie,
  type RequestContext,
  type Route,
  type RouteAccess,
  type WebRequest,
  type WebResponse,
} from "./kit.ts";
import type { CheckoutCatalog } from "../repository-checkouts.ts";
import {
  createGitHubSignIn,
  GITHUB_REFRESH_MS,
  type GitHubSignInOptions,
} from "./github-sign-in.ts";
import { repositoryRoutes } from "./routes/repository.ts";
import { connectionsPage } from "./routes/connections.ts";
import { captureRoutes } from "./routes/capture.ts";
import { definitionRoutes } from "./routes/definitions.ts";
import { governanceRoutes } from "./routes/governance.ts";
import { createDecisionGuardRoutes } from "./routes/decision-guard.ts";
import { createBrainBriefRoutes, brainCaptureRoutes } from "./routes/brain.ts";
import { knowledgeRoutes } from "./routes/knowledge.ts";
import { memoryRoutes } from "./routes/memories.ts";
import { myNetworkRoutes } from "./routes/my-network.ts";
import { networkRoutes } from "./routes/network.ts";
import { organizationRoutes } from "./routes/organizations.ts";
import { promptRoutes } from "./routes/prompt.ts";
import { reviewRoutes } from "./routes/review.ts";
import { searchRoutes } from "./routes/search.ts";
import { workRoutes } from "./routes/work.ts";
import { systemRoutes } from "./routes/system.ts";
import {
  clearedSessionCookie,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  SessionStore,
} from "./session.ts";

export type App = (request: WebRequest) => Promise<WebResponse>;

export interface AppOptions {
  /** The loopback port the app answers on; requests naming another host are refused. */
  port: number;
  sessions?: SessionStore;
  /** Fixed operator for a single-user localhost workspace; opens without a login screen. */
  localPrincipalId?: string;
  checkouts?: CheckoutCatalog;
  prototype?: { principalId: string; login: string; accessKeyHash: string };
  /** Optional account connection in local mode; verified sign-in in GitHub mode. */
  github?: GitHubSignInOptions;
  decisionGuard?: DecisionGuardWebRuntime;
  /** Local operator binding, reloaded on every request; never accepts a browser identity. */
  agentBinding?: AgentBindingLoader;
}

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  validation_failed: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
};

const STYLESHEET = ["cobalt-system.css", "fonts.css"]
  .map((name) =>
    readFileSync(new URL(`./assets/${name}`, import.meta.url), "utf8"),
  )
  .join("\n");

const BRAND_MARK = readFileSync(
  new URL("./assets/brand/mark.svg", import.meta.url),
  "utf8",
);
const ICON = readFileSync(
  new URL("./assets/brand/icon.svg", import.meta.url),
  "utf8",
);
const FONTS = new Map(
  [
    "host-grotesk-latin-variable.woff2",
    "atkinson-hyperlegible-mono-latin-variable.woff2",
    "geist-variable.woff2",
    "familjen-grotesk-latin-variable.woff2",
    "ibm-plex-sans-latin-variable.woff2",
    "jetbrains-mono-latin-variable.woff2",
  ].map((name) => [
    `/assets/fonts/${name}`,
    readFileSync(new URL(`./assets/fonts/${name}`, import.meta.url)),
  ]),
);

// Only the network and prompt anatomy pages load these; they read what the page embeds, and the
// network page also re-reads its own permission-filtered payload while it is open.
const SCRIPTS: ReadonlyMap<string, string> = new Map(
  [
    "shell.js",
    "graph-tiers.js",
    "network.js",
    "icons.js",
    "graph-engine.js",
    "network-view.js",
    "prompt.js",
    "prompt-view.js",
    "my-network.js",
    "my-network-view.js",
  ].map((name) => [
    `/assets/${name}`,
    readFileSync(new URL(`./assets/${name}`, import.meta.url), "utf8"),
  ]),
);

function sameToken(given: string | null, expected: string): boolean {
  if (given === null || expected === "") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function plainText(status: number, text: string): WebResponse {
  return {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: text,
  };
}

function withCookie(response: WebResponse, cookie: string): WebResponse {
  return {
    ...response,
    headers: { ...response.headers, "Set-Cookie": cookie },
  };
}

/** The page the form came from, on this app only; never another site. */
function returnPath(rc: RequestContext): string {
  const referer = rc.req.headers.referer;
  if (!referer?.startsWith(`${rc.origin}/`)) return "/";
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return "/";
  }
  if (url.origin !== rc.origin || url.pathname.startsWith("//")) return "/";
  url.searchParams.delete("done");
  const query = url.searchParams.toString();
  return query === "" ? url.pathname : `${url.pathname}?${query}`;
}

function match(
  routes: readonly Route[],
  request: WebRequest,
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== request.method) continue;
    const found = route.pattern.exec(request.path);
    if (!found) continue;
    const params: Record<string, string> = {};
    try {
      for (const [name, value] of Object.entries(found.groups ?? {})) {
        params[name] = decodeURIComponent(value);
      }
    } catch {
      return null;
    }
    return { route, params };
  }
  return null;
}

/**
 * The local test app as a plain request handler, so tests need no network port.
 * Every form must come from this app's own pages: same origin, plus a token tied to
 * the signed-in session (or to this app run, for the System page).
 */
export function createApp(ctx: MemoryNetContext, options: AppOptions): App {
  const hosts = new Set([
    `localhost:${options.port}`,
    `127.0.0.1:${options.port}`,
  ]);
  const sessions = options.sessions ?? new SessionStore();
  const systemToken = randomBytes(32).toString("base64url");
  let loginFailures = 0,
    failureWindow = Date.now();
  if (options.localPrincipalId && options.prototype)
    throw new Error("Local access and access-key sign-in are separate modes");
  if (
    options.prototype &&
    !/^[a-f0-9]{64}$/.test(options.prototype.accessKeyHash)
  )
    throw new Error("Prototype authentication needs a valid access-key hash");
  const agentContext = options.agentBinding
    ? createAgentContextHandler(ctx, options.agentBinding)
    : null;
  const github = options.github
    ? createGitHubSignIn(
        ctx,
        sessions,
        systemToken,
        options.github,
        options.agentBinding,
        options.localPrincipalId,
      )
    : null;
  const refreshMs = options.github?.refreshIntervalMs ?? GITHUB_REFRESH_MS;
  if (github && refreshMs > 0)
    setInterval(() => void github.refresh(), refreshMs).unref();

  async function signIn(rc: RequestContext): Promise<WebResponse> {
    if (options.localPrincipalId)
      return errorPage(
        rc,
        403,
        "This local workspace opens as its configured operator. No sign-in is needed.",
      );
    if (github)
      return errorPage(rc, 403, "This workspace uses GitHub sign-in.");
    let principal;
    if (options.prototype) {
      if (Date.now() - failureWindow > 60_000) {
        loginFailures = 0;
        failureWindow = Date.now();
      }
      if (loginFailures >= 5)
        return errorPage(
          rc,
          429,
          "Too many sign-in attempts. Try again in one minute.",
        );
      const supplied = rc.form.get("accessKey") ?? "";
      const hash = createHash("sha256").update(supplied).digest("hex");
      if (
        !sameToken(rc.form.get("_login"), systemToken) ||
        !sameToken(hash, options.prototype.accessKeyHash)
      ) {
        loginFailures++;
        return errorPage(rc, 403, "The access key is not valid.");
      }
      principal = await findPrincipal(rc.ctx.db, options.prototype.principalId);
      loginFailures = 0;
    } else {
      principal = await findPrincipal(
        rc.ctx.db,
        rc.form.get("principalId") ?? "",
      ).catch(() => null);
    }
    if (!principal)
      throw new ValidationError("Choose a person or agent from the list");
    if (rc.session) sessions.delete(rc.session.token);
    const session = sessions.create(principal.id);
    return withCookie(redirect("/", "signed-in"), sessionCookie(session.token));
  }

  async function signOut(rc: RequestContext): Promise<WebResponse> {
    if (options.localPrincipalId)
      return errorPage(
        rc,
        403,
        "Use Connections to disconnect GitHub. Local workspace access does not require sign-in.",
      );
    if (rc.session) sessions.delete(rc.session.token);
    return withCookie(redirect("/"), clearedSessionCookie());
  }

  async function setTheme(rc: RequestContext): Promise<WebResponse> {
    const theme = rc.form.get("theme");
    if (!isTheme(theme))
      throw new ValidationError("Choose Auto, Light, or Dark");
    return withCookie(redirect(returnPath(rc)), themeCookie(theme));
  }

  const routes: readonly Route[] = [
    {
      method: "POST",
      pattern: /^\/sign-in$/,
      access: "public",
      handle: signIn,
    },
    {
      method: "POST",
      pattern: /^\/sign-out$/,
      access: "user",
      handle: signOut,
    },
    ...(options.localPrincipalId
      ? ([
          {
            method: "GET",
            pattern: /^\/connections$/,
            access: "user",
            handle: connectionsPage,
          },
        ] satisfies Route[])
      : []),
    ...(github && options.localPrincipalId
      ? ([
          {
            method: "POST",
            pattern: /^\/connections\/github$/,
            access: "user",
            handle: github.start,
          },
          {
            method: "GET",
            pattern: /^\/connections\/github$/,
            access: "user",
            handle: github.poll,
          },
          {
            method: "POST",
            pattern: /^\/connections\/github\/disconnect$/,
            access: "user",
            handle: github.disconnect,
          },
        ] satisfies Route[])
      : github
        ? ([
            {
              method: "POST",
              pattern: /^\/sign-in\/github$/,
              access: "public",
              handle: github.start,
            },
            {
              method: "GET",
              pattern: /^\/sign-in\/github$/,
              access: "public",
              handle: github.poll,
            },
          ] satisfies Route[])
        : []),
    {
      method: "POST",
      pattern: /^\/preferences\/theme$/,
      access: "public",
      handle: setTheme,
    },
    ...organizationRoutes,
    ...governanceRoutes,
    ...repositoryRoutes,
    ...knowledgeRoutes,
    ...searchRoutes,
    ...workRoutes,
    ...memoryRoutes,
    ...reviewRoutes,
    ...definitionRoutes,
    ...promptRoutes,
    ...myNetworkRoutes,
    ...networkRoutes,
    ...systemRoutes,
    ...captureRoutes,
    ...(options.decisionGuard
      ? createDecisionGuardRoutes(options.decisionGuard)
      : []),
    ...(options.decisionGuard
      ? createBrainBriefRoutes(options.decisionGuard)
      : []),
    ...brainCaptureRoutes,
  ];

  function refusePost(rc: RequestContext, access: RouteAccess): string | null {
    const origin = rc.req.headers.origin;
    const fetchSite = rc.req.headers["sec-fetch-site"];
    const sameOrigin =
      origin === undefined ? fetchSite === "same-origin" : origin === rc.origin;
    if (!sameOrigin) return "Forms must be sent from MemoryNet's own pages.";
    if (
      access === "user" &&
      !sameToken(rc.form.get("_csrf"), rc.session?.csrfToken ?? "")
    ) {
      return "This form has expired. Reload the page and try again.";
    }
    if (
      access === "system" &&
      !sameToken(rc.form.get("_system"), systemToken)
    ) {
      return "This System form has expired. Reload the System page and try again.";
    }
    return null;
  }

  return async function handle(request: WebRequest): Promise<WebResponse> {
    const host = request.headers.host ?? "";
    if (!hosts.has(host)) {
      return plainText(421, "MemoryNet only answers on localhost.");
    }
    if (AGENT_PATHS.has(request.path)) {
      if (!agentContext)
        return plainText(404, "Agent context is not configured.");
      return agentContext(request);
    }
    if (
      request.method === "GET" &&
      (request.path === "/favicon.ico" ||
        request.path === "/assets/icon.svg" ||
        request.path === "/assets/brand/icon.svg" ||
        request.path === "/assets/brand/mark.svg")
    ) {
      return {
        status: 200,
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "image/svg+xml",
          "Cache-Control": "max-age=86400",
        },
        body: request.path === "/assets/brand/mark.svg" ? BRAND_MARK : ICON,
      };
    }
    if (request.method === "GET" && FONTS.has(request.path)) {
      return {
        status: 200,
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "font/woff2",
          "Content-Length": String(FONTS.get(request.path)!.byteLength),
          "Cache-Control": "max-age=86400",
        },
        body: "",
        binaryBody: FONTS.get(request.path)!,
      };
    }
    if (request.method === "GET" && request.path === "/assets/style.css") {
      return {
        status: 200,
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "text/css; charset=utf-8",
        },
        body: STYLESHEET,
      };
    }
    const script =
      request.method === "GET" ? SCRIPTS.get(request.path) : undefined;
    if (script !== undefined) {
      return {
        status: 200,
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "text/javascript; charset=utf-8",
        },
        body: script,
      };
    }
    let session = sessions.find(
      readCookie(request.headers.cookie, SESSION_COOKIE),
    );
    // Ignore sessions from any other identity, including a previous sandbox session.
    if (
      options.localPrincipalId &&
      session?.principalId !== options.localPrincipalId
    )
      session = null;
    const user =
      session || options.localPrincipalId
        ? await findPrincipal(
            ctx.db,
            options.localPrincipalId ?? session!.principalId,
          )
        : null;
    if (options.localPrincipalId && (!user || user.kind !== "human")) {
      return plainText(
        503,
        "The configured local operator is unavailable. Check the workspace configuration.",
      );
    }
    // Bootstrap only on reads. Mutations still need an existing session and its CSRF token.
    const newLocalSession =
      !!options.localPrincipalId && !session && request.method === "GET";
    if (newLocalSession) session = sessions.create(options.localPrincipalId!);
    const rc: RequestContext = {
      ctx,
      req: request,
      params: {},
      form: new URLSearchParams(request.method === "POST" ? request.body : ""),
      session: user ? session : null,
      user,
      systemToken,
      origin: `http://${host}`,
      decisionGuardAvailable: options.decisionGuard !== undefined,
      checkouts: options.checkouts,
      prototype: options.prototype
        ? {
            principalId: options.prototype.principalId,
            login: options.prototype.login,
          }
        : undefined,
      github: github !== null,
      local: !!options.localPrincipalId,
    };
    const respond = (response: WebResponse) =>
      newLocalSession
        ? withCookie(response, sessionCookie(session!.token))
        : response;
    const found = match(routes, request);
    if (user && request.method === "GET" && !found?.route.data) {
      try {
        rc.shell = {
          reviewCount:
            user.kind === "human"
              ? (await listReviewQueue(ctx, user.id, { limit: 200 })).length
              : 0,
          primaryOrganizationId:
            (await listOrganizations(ctx, user.id))[0]?.id ?? null,
        };
      } catch {
        rc.shell = undefined;
      }
    }
    try {
      if (
        (options.localPrincipalId || options.prototype || github) &&
        /^\/system(?:\/|$)/.test(request.path)
      )
        return respond(
          errorPage(
            rc,
            404,
            "This test-only feature is disabled in this workspace.",
          ),
        );
      if (!found)
        return respond(errorPage(rc, 404, "There is no page at this address."));
      if (request.method === "POST") {
        const refusal = refusePost(rc, found.route.access);
        if (refusal) return errorPage(rc, 403, refusal);
      }
      if (found.route.access === "user" && !rc.user) {
        return request.method === "GET"
          ? redirect("/")
          : errorPage(rc, 403, "Choose who you are first.");
      }
      return respond(await found.route.handle({ ...rc, params: found.params }));
    } catch (error) {
      if (error instanceof MemoryNetError) {
        return respond(
          errorPage(rc, STATUS_BY_CODE[error.code], error.message),
        );
      }
      console.error(error);
      return errorPage(
        rc,
        500,
        "Something went wrong. The terminal running the app shows the details.",
      );
    }
  };
}
