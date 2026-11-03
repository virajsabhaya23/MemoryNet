import type { CheckoutCatalog } from "../repository-checkouts.ts";
import type { Principal } from "../access.ts";
import type { MemoryNetContext } from "../context.ts";
import { html, type SafeHtml } from "./html.ts";
import { ICON_PATHS } from "./assets/icons.js";
import { readCookie } from "./session.ts";

/** MemoryNet's local HTTP port. */
export const APP_PORT = 3050;

export const THEME_COOKIE = "mn_theme";
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

/** A display preference only, so it needs no session. */
export function themeCookie(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}

function themeOf(rc: RequestContext): Theme {
  const value = readCookie(rc.req.headers.cookie, THEME_COOKIE);
  return isTheme(value) ? value : "system";
}

export interface WebRequest {
  method: string;
  /** Path without the query string, such as /projects/123. */
  path: string;
  query: URLSearchParams;
  /** Header names are lowercase. */
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
}

export interface WebResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Raw assets such as self-hosted fonts bypass text encoding. */
  binaryBody?: Uint8Array;
}

export interface Session {
  token: string;
  principalId: string;
  csrfToken: string;
  createdAt: number;
}

export interface RequestContext {
  ctx: MemoryNetContext;
  req: WebRequest;
  params: Readonly<Record<string, string>>;
  /** Submitted form fields; empty for GET requests. */
  form: URLSearchParams;
  session: Session | null;
  /** The signed-in person or agent. Routes with access "user" always have one. */
  user: Principal | null;
  /** Token that System page forms must send back. */
  systemToken: string;
  /** Such as http://localhost:3050. */
  origin: string;
  /** Local Meta workflow routes are registered by the server. */
  decisionGuardAvailable?: boolean;
  checkouts?: CheckoutCatalog;
  prototype?: {principalId:string;login:string};
}

/** public: anyone. user: a signed-in person or agent. system: the System page, which stands in for GitHub. */
export type RouteAccess = "public" | "user" | "system";

export interface Route {
  method: "GET" | "POST";
  /** Anchored pattern. Named groups become params. */
  pattern: RegExp;
  access: RouteAccess;
  handle(rc: RequestContext): Promise<WebResponse>;
}

/** Fixed messages shown after a form succeeds, chosen by the ?done= code. */
const NOTICES: Readonly<Record<string, string>> = {
  "signed-in": "You are signed in.",
  "org-created": "Organization created. You are its owner.",
  "bu-created": "Business unit created.",
  "project-created": "Project created.",
  "role-assigned": "Role saved.",
  "role-revoked": "Role removed.",
  "member-removed":
    "Every role this member held in the organization was removed.",
  "repo-connected": "Repository connected.",
  "repo-disconnected":
    "Repository disconnected. Its sources are no longer readable.",
  "example-data": "Synthetic example data loaded. Choose a person to continue.",
  "principal-created": "Person or agent added. They have no roles yet.",
  "access-reported": "Repository access report saved.",
  "repo-removed": "Repository removal reported.",
  "repo-removed-none":
    "No project had this repository connected. Nothing changed.",
  "source-recorded": "Evidence saved as a source.",
  proposed:
    "Proposal saved. It is not knowledge until a different reviewer approves it.",
  "proposed-by-agent":
    "Proposal sent for review. Agents cannot see proposals, so it is not listed for you.",
  approved: "Approved. This memory is now knowledge, with its own ID.",
  rejected:
    "Proposal rejected. It stays as a review record and is not knowledge.",
  "pr-captured":
    "Merged pull request captured as a source. People who can read the repository can now cite it.",
  "pr-duplicate": "Already captured. The stored evidence was left unchanged.",
  "pr-ignored": "No project uses this repository, so nothing was stored.",
  edited: "Saved as a new version. Reviewers now decide on this version.",
  "change-proposed":
    "Change proposed. The memory stays as it is until a different reviewer approves the change.",
  suspended:
    "Suspended. It is no longer current guidance until a reviewer resolves it.",
  reinstated: "Reinstated. It is current guidance again.",
  reported: "Reported. Nothing changes until a person acts on it.",
  "report-dismissed": "Report dismissed. The memory is unchanged.",
  "definition-proposed":
    "Proposal saved. It is not guidance until a different reviewer approves it.",
  "definition-proposed-by-agent":
    "Proposal sent for review. Agents cannot see proposals, so it is not listed for you.",
  "definition-change-proposed":
    "Change proposed. The current version stays in use until a different reviewer approves it.",
  "definition-approved": "Approved. This version is now the current guidance.",
  "definition-rejected":
    "Proposal rejected. It stays as a review record and changes nothing.",
};

const NAV: ReadonlyArray<readonly [string, string, string]> = [
  ["Organizations", "/", "organization"], ["Review", "/review", "review"], ["System", "/system", "system"],
];

export function interfaceIcon(name: string): SafeHtml {
  return html`<svg class="interface-icon" width="20" height="20" viewBox="-12 -12 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON_PATHS[name] ?? ICON_PATHS.project}" /></svg>`;
}
const navIcon = interfaceIcon;

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part !== "");
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cache-Control": "no-store",
};

export function htmlResponse(status: number, body: SafeHtml): WebResponse {
  return {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
    },
    body: body.__html,
  };
}

/** See Other: the browser loads the location with GET after a form. */
export function redirect(location: string, done?: string): WebResponse {
  const target =
    done === undefined
      ? location
      : `${location}${location.includes("?") ? "&" : "?"}done=${done}`;
  return {
    status: 303,
    headers: { ...SECURITY_HEADERS, Location: target },
    body: "",
  };
}

export function requireUser(rc: RequestContext): Principal {
  if (!rc.user) throw new Error("Route needs a signed-in user");
  return rc.user;
}

export function csrfField(rc: RequestContext): SafeHtml {
  return html`<input
    type="hidden"
    name="_csrf"
    value="${rc.session?.csrfToken ?? ""}"
  />`;
}

export function systemField(rc: RequestContext): SafeHtml {
  return html`<input type="hidden" name="_system" value="${rc.systemToken}" />`;
}

/** A submitted field, or undefined when it is missing or empty. */
export function formValue(
  rc: RequestContext,
  name: string,
): string | undefined {
  const value = rc.form.get(name);
  return value === null || value.trim() === "" ? undefined : value;
}

/** A small form that posts to action with the session's CSRF token. */
export function postForm(
  rc: RequestContext,
  action: string,
  fields: SafeHtml | string,
  button: string,
  className = "inline",
): SafeHtml {
  return html`<form method="post" action="${action}" class="${className}">
    ${csrfField(rc)} ${fields}
    <button type="submit">${button}</button>
  </form>`;
}

export interface PageOptions {
  title: string;
  crumbs?: ReadonlyArray<readonly [string, string]>;
  body: SafeHtml;
  status?: number;
  /** Full width, and the body brings its own heading. */
  workspace?: boolean;
  /** The body fills the whole window beside the rail, as on the network map. */
  immersive?: boolean;
}

export function breadcrumbs(
  crumbs: ReadonlyArray<readonly [string, string]>,
): SafeHtml {
  if (crumbs.length === 0) return html``;
  return html`<nav class="crumbs" aria-label="Breadcrumbs">
    ${crumbs.map(
      ([label, href], index) =>
        html`${index > 0
            ? html`<span class="sep" aria-hidden="true">/</span>`
            : ""}<a href="${href}">${label}</a>`,
    )}
  </nav>`;
}

const THEME_LABELS: Readonly<Record<Theme, [string, string]>> = {
  system: ["Auto", "Match this computer's light or dark setting"],
  light: ["Light", "Always light"],
  dark: ["Dark", "Always dark"],
};

function themeSwitch(theme: Theme): SafeHtml {
  return html`<form
    class="theme-switch"
    method="post"
    action="/preferences/theme"
    aria-label="Color theme"
  >
    ${THEMES.map(
      (value) =>
        html`<button
          type="submit"
          name="theme"
          value="${value}"
          title="${THEME_LABELS[value][1]}"
          aria-pressed="${value === theme ? "true" : "false"}"
        >
          ${THEME_LABELS[value][0]}
        </button>`,
    )}
  </form>`;
}

// One vector source, colored by the app theme through a CSS mask.
const BRAND_MARK = html`<span class="brand-mark" aria-hidden="true"></span>`;

function isCurrent(rc: RequestContext, href: string): boolean {
  if (href === "/") {
    return (
      rc.req.path === "/" ||
      rc.req.path.startsWith("/orgs/") ||
      rc.req.path.startsWith("/business-units/") ||
      rc.req.path.startsWith("/projects/")
    );
  }
  return rc.req.path === href || rc.req.path.startsWith(`${href}/`);
}

function layout(rc: RequestContext, options: PageOptions): SafeHtml {
  const done = rc.req.query.get("done");
  const notice = done === null ? undefined : NOTICES[done];
  const user = rc.user;
  const crumbs = options.crumbs ?? [];
  const theme = themeOf(rc);
  return html`<!doctype html>
    <html lang="en" data-theme="${theme}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="color-scheme"
          content="${theme === "system" ? "light dark" : theme}"
        />
        <title>${options.title} · MemoryNet</title>
        <link
          rel="preload"
          href="/assets/fonts/ibm-plex-sans-latin-variable.woff2"
          as="font"
          type="font/woff2"
          crossorigin
        />
        <link rel="stylesheet" href="/assets/style.css" />
        <link
          rel="icon"
          href="/assets/brand/icon.svg"
          type="image/svg+xml"
          sizes="any"
        />
      </head>
      <body class="${options.immersive ? "immersive" : ""}">
        <a class="skip" href="#main">Skip to content</a>
        <header class="rail top">
          <a class="brand" href="/" title="MemoryNet" aria-label="MemoryNet home"
            >${BRAND_MARK}<span class="brand-name">MemoryNet</span></a
          >
          <nav aria-label="Main">
            ${NAV.filter(([,href])=>!rc.prototype||href!=="/system").map(
              ([label, href, icon]) =>
                html`<a
                  href="${href}"
                  title="${label}"
                  aria-label="${label}"
                  ${isCurrent(rc, href) ? html`aria-current="page"` : ""}
                  >${navIcon(icon)}<span class="nav-label">${label}</span></a
                >`,
            )}
          </nav>
          <div class="rail-foot">
            <span class="tag" title="${rc.prototype ? "Secured local prototype using original public repository evidence" : "Local pilot: public or synthetic evidence only. Identity selection is not authentication."}"
              ><span class="tag-text">${rc.prototype ? "Local prototype" : "Local pilot"}</span></span
            >
            ${themeSwitch(theme)}
            ${user
              ? html`<form class="who" method="post" action="/sign-out">
                  <span class="avatar" aria-hidden="true"
                    >${initialsOf(user.displayName)}</span
                  >
                  <span class="who-text"
                    ><strong>${user.displayName}</strong>
                    <small
                      >(${user.kind === "agent" ? "agent" : "person"})</small
                    ></span
                  >
                  ${csrfField(rc)}
                  <button type="submit" class="secondary">${rc.prototype ? "Sign out" : "Switch person"}</button>
                </form>`
              : html`<span class="who"
                  ><span class="avatar" aria-hidden="true">?</span
                  ><span class="who-text">Not signed in</span></span
                >`}
          </div>
        </header>
        <div class="workspace-bar" aria-label="Workspace context">
          <span>Engineering workspace</span>
          <span class="workspace-location">${options.title}</span>
          <a href="/review">Review queue</a>
        </div>
        <main
          id="main"
          class="${options.immersive
            ? "immersive"
            : options.workspace
              ? "workspace"
              : ""}"
        >
          ${options.workspace
            ? ""
            : html`<div class="page-head">
                ${breadcrumbs(crumbs)}
                <h1>${options.title}</h1>
              </div>`}
          ${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
          ${options.body}
        </main>
      </body>
    </html>`;
}

export function page(rc: RequestContext, options: PageOptions): WebResponse {
  return htmlResponse(options.status ?? 200, layout(rc, options));
}

/** A same-origin page the browser came from, so an error can link back to the form. */
export function backLink(rc: RequestContext): SafeHtml {
  const referer = rc.req.headers.referer;
  if (referer?.startsWith(`${rc.origin}/`)) {
    const path = referer.slice(rc.origin.length).split("?")[0] ?? "/";
    return html`<p><a href="${path}">Go back</a></p>`;
  }
  return html`<p><a href="/">Go to the start page</a></p>`;
}

export function errorPage(
  rc: RequestContext,
  status: number,
  message: string,
): WebResponse {
  return page(rc, {
    title: status === 404 ? "Not found" : "That did not work",
    status,
    body: html`<p class="error" role="alert">${message}</p>
      ${backLink(rc)}`,
  });
}
