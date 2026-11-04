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
  /** Present after GitHub sign-in. The token stays in server memory and is never rendered or stored. */
  github?: { readonly token: string; readonly login: string; readonly userId: string };
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
  /** GitHub sign-in is configured: persona selection, access keys and System controls are off. */
  github?: boolean;
  /** Single local operator; no application sign-in or persona switching. */
  local?: boolean;
  /** Shell data computed once per page request; absent when it could not be loaded. */
  shell?: { reviewCount: number; primaryOrganizationId: string | null };
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
  "approval-recorded":
    "Approval recorded for this exact version. It is published once enough different reviewers approve the same version.",
  "policy-saved": "Review policy saved as a new version. It applies to approvals from now on.",
  "batch-reviewed": "Review finished. Each proposal's result is listed below.",
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

export type ScopeLevelName = "organization" | "business_unit" | "project";

/** The scope a URL lives inside, if any. Mirrors the route patterns; names come from pages, not here. */
export function scopeFromPath(path: string): { level: ScopeLevelName; id: string } | null {
  const scoped = /^\/scopes\/(organization|business_unit|project)\/([^/]+)/.exec(path);
  if (scoped) return { level: scoped[1] as ScopeLevelName, id: scoped[2]! };
  const org = /^\/orgs\/([^/]+)/.exec(path);
  if (org) return { level: "organization", id: org[1]! };
  const unit = /^\/business-units\/([^/]+)/.exec(path);
  if (unit) return { level: "business_unit", id: unit[1]! };
  const project = /^\/projects\/([^/]+)/.exec(path);
  if (project) return { level: "project", id: project[1]! };
  return null;
}

interface NavLink { label: string; href: string; icon: string }

function contextLinks(rc: RequestContext): { heading: string; links: NavLink[] } | null {
  const scope = scopeFromPath(rc.req.path);
  if (!scope) return null;
  if (scope.level === "organization") {
    return { heading: "This organization", links: [
      { label: "Overview", href: `/orgs/${scope.id}`, icon: "organization" },
      { label: "Network", href: `/orgs/${scope.id}/network`, icon: "network" },
      { label: "Your network", href: `/orgs/${scope.id}/you`, icon: "person" },
      { label: "Definitions", href: `/scopes/organization/${scope.id}/definitions`, icon: "instruction" },
      { label: "Integrity", href: `/orgs/${scope.id}/integrity`, icon: "rule" },
    ] };
  }
  if (scope.level === "business_unit") {
    return { heading: "This business unit", links: [
      { label: "Overview", href: `/business-units/${scope.id}`, icon: "business_unit" },
      { label: "Definitions", href: `/scopes/business_unit/${scope.id}/definitions`, icon: "instruction" },
      { label: "Roles", href: `/scopes/business_unit/${scope.id}/roles`, icon: "person" },
    ] };
  }
  const links: NavLink[] = [
    { label: "Knowledge", href: `/projects/${scope.id}#current-knowledge`, icon: "memory" },
    { label: "Definitions", href: `/scopes/project/${scope.id}/definitions`, icon: "instruction" },
    { label: "Evidence", href: `/projects/${scope.id}#evidence`, icon: "source" },
    { label: "Work", href: `/projects/${scope.id}/work`, icon: "project" },
    { label: "Search", href: `/projects/${scope.id}/search`, icon: "memory" },
    { label: "Activity", href: `/projects/${scope.id}/retrievals`, icon: "review" },
  ];
  if (rc.decisionGuardAvailable && rc.user?.kind === "human") {
    links.push({ label: "Decision Guard", href: `/projects/${scope.id}/decision-guard`, icon: "agent" });
  }
  return { heading: "This project", links };
}

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
            ${(() => {
              const context = contextLinks(rc);
              const scopeOrg = scopeFromPath(rc.req.path);
              const orgId = rc.shell?.primaryOrganizationId ?? (scopeOrg?.level === "organization" ? scopeOrg.id : null);
              const reviewCount = rc.shell?.reviewCount ?? 0;
              const showSystem = !(rc.local || rc.prototype || rc.github);
              const link = (label: string, href: string, icon: string, current = isCurrent(rc, href.split("#")[0]!)) => html`<a href="${href}" title="${label}" aria-label="${label}" ${current ? html`aria-current="page"` : ""}>${navIcon(icon)}<span class="nav-label">${label}</span></a>`;
              const disabled = (label: string, icon: string, hint: string) => html`<a aria-disabled="true" title="${hint}">${navIcon(icon)}<span class="nav-label">${label}</span></a>`;
              return html`<div class="nav-section" data-nav="work">
                  <span class="nav-heading">Work</span>
                  ${link("Overview", "/", "organization")}
                  <a href="/review" title="Review" aria-label="Review" ${isCurrent(rc, "/review") ? html`aria-current="page"` : ""}>${navIcon("review")}<span class="nav-label">Review</span>${reviewCount > 0 ? html`<span class="nav-count" data-review-count="${reviewCount}">${reviewCount}</span>` : ""}</a>
                  ${orgId ? link("Network", `/orgs/${orgId}/network`, "network", rc.req.path === `/orgs/${orgId}/network`) : disabled("Network", "network", "Join an organization to open its network")}
                  ${orgId ? link("Your network", `/orgs/${orgId}/you`, "person", rc.req.path === `/orgs/${orgId}/you`) : disabled("Your network", "person", "Join an organization to see your network")}
                </div>
                ${context ? html`<div class="nav-section" data-nav="context">
                    <span class="nav-heading">${context.heading}</span>
                    ${context.links.map((item) => link(item.label, item.href, item.icon, rc.req.path === item.href.split("#")[0] && !item.href.includes("#")))}
                  </div>` : ""}
                ${showSystem ? html`<div class="nav-section" data-nav="system">${link("System", "/system", "system")}</div>` : ""}`;
            })()}
          </nav>
          <div class="rail-foot">
            <span class="tag" title="${rc.local ? "Single-operator workspace on this computer. No app sign-in required." : rc.github ? "Signed in with GitHub; repository access is checked with GitHub" : rc.prototype ? "Secured local prototype using original public repository evidence" : "Local pilot: public or synthetic evidence only. Identity selection is not authentication."}"
              ><span class="tag-text">${rc.local ? "Local workspace" : rc.github ? "GitHub sign-in" : rc.prototype ? "Local prototype" : "Local pilot"}</span></span
            >
            ${themeSwitch(theme)}
            ${rc.local && user
              ? html`<div class="who"><span class="avatar" aria-hidden="true">${initialsOf(user.displayName)}</span>
                  <span class="who-text"><strong>${user.displayName}</strong><small>Local operator</small></span>
                  <a href="/connections">Connections</a></div>`
              : user
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
                  <button type="submit" class="secondary">${rc.prototype || rc.github ? "Sign out" : "Switch person"}</button>
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
          <details class="jump">
            <summary><span>Jump to</span><span class="jump-keys" aria-hidden="true"><kbd>⌘</kbd><kbd>K</kbd></span></summary>
            <div class="jump-menu">
              <a data-jump href="/">Overview</a>
              <a data-jump href="/review">Review queue</a>
              ${rc.shell?.primaryOrganizationId ? html`<a data-jump href="/orgs/${rc.shell.primaryOrganizationId}/network">Network</a><a data-jump href="/orgs/${rc.shell.primaryOrganizationId}/you">Your network</a>` : ""}
              ${(contextLinks(rc)?.links ?? []).map((item) => html`<a data-jump href="${item.href}">${item.label}</a>`)}
            </div>
          </details>
          <a href="/review">Review queue${rc.shell && rc.shell.reviewCount > 0 ? html` (${rc.shell.reviewCount})` : ""}</a>
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
        <script type="module" src="/assets/shell.js"></script>
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
