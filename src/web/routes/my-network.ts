import { NotFoundError } from "../../errors.ts";
import { badge, html, table, type SafeHtml } from "../html.ts";
import {
  page,
  interfaceIcon,
  requireUser,
  SECURITY_HEADERS,
  type RequestContext,
  type Route,
  type WebResponse,
} from "../kit.ts";
import {
  getMyOverview,
  getMyPlace,
  ROLE_MEANING,
  type MyOverview,
  type MyPlace,
} from "../my-network.ts";
import { OPEN_BUDGET, PLACE_BUDGET } from "../assets/my-network-view.js";
import { scopePath } from "../views.ts";
import { scriptJson } from "./network.ts";

const LEVEL_LABEL = {
  organization: "Organization",
  business_unit: "Business unit",
  project: "Project",
} as const;

/** Most rows in the list view and most names offered by "Find a place", so the page stays light. */
const LIST_LIMIT = 500;
const FIND_LIMIT = 2000;

function placeHref(place: MyPlace): string {
  return scopePath({ level: place.level, id: place.recordId });
}

function accessWords(place: MyPlace): string {
  if (place.role === null) return "guidance reaches you";
  return place.access === "covered"
    ? `${place.role}, from ${place.roleFrom}`
    : place.role;
}

function shortCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

/** Projects are named like "owner/repository"; the map shows the last part. */
function displayName(place: MyPlace): string {
  return place.level === "project"
    ? (place.name.split("/").at(-1) ?? place.name)
    : place.name;
}

function suffixOf(place: MyPlace): string {
  return place.access === "direct" && place.role !== null
    ? ` · ${place.role}`
    : "";
}

function total(place: MyPlace): number {
  return place.counts.work + place.counts.know;
}

function placeWords(place: MyPlace): string {
  return `${LEVEL_LABEL[place.level]}: ${place.name}. Your access: ${accessWords(
    place,
  )}. ${total(place)} pieces of knowledge.`;
}

/**
 * The places on the map as links, in the order they hang from you. The canvas cannot be read by a
 * screen reader or reached with Tab, so these are how the keyboard moves through the map: each one
 * selects its place on the canvas when focused and opens it when followed.
 */
function placeLinks(view: MyOverview): SafeHtml {
  const drawn = view.places.filter((place) => place.drawn);
  const childrenOf = (id: string) =>
    drawn.filter((place) => place.parentId === id);
  const more =
    view.listed.length === 0
      ? html``
      : html`<li>
          <a
            href="#myn-panel"
            data-id="more:units"
            aria-label="${view.listed.length} more business units, listed in the panel."
            >${view.listed.length} more business units</a
          >
        </li>`;
  const entry = (place: MyPlace): SafeHtml =>
    html`<li>
      <a
        href="${placeHref(place)}"
        data-id="${place.id}"
        aria-label="${placeWords(place)}"
        >${place.name}</a
      >
      <ul data-holds="${place.id}">
        ${childrenOf(place.id).map(entry)}
        ${place.level === "organization" ? more : ""}
      </ul>
    </li>`;
  const org = drawn.find((place) => place.level === "organization");
  return html`<nav class="myn-places" id="myn-places" aria-label="Places on the map">
    <ul>
      <li>
        <a
          href="#myn-panel"
          data-id="you"
          aria-label="You: ${view.viewer.name}. Your access in ${view.organization.name}."
          >You</a
        >
      </li>
      ${org ? entry(org) : ""}
    </ul>
  </nav>`;
}

function accessSummary(view: MyOverview): SafeHtml {
  const direct = view.places.filter((place) => place.access === "direct");
  const t = view.totals;
  return html`<h2>Your access</h2>
    ${direct.length === 0
      ? html`<p>
          You have no role of your own in ${view.organization.name}; you see
          only the guidance that reaches where you work.
        </p>`
      : html`<ul class="plain myn-roles">
          ${direct.slice(0, 12).map(
            (place) =>
              html`<li>
                ${badge(place.role ?? "", "role")} of
                <strong>${place.name}</strong>
                <small
                  >${LEVEL_LABEL[place.level].toLowerCase()}: you can
                  ${place.role === null ? "" : ROLE_MEANING[place.role]}</small
                >
              </li>`,
          )}
          ${direct.length > 12
            ? html`<li>
                <small>and ${direct.length - 12} more places</small>
              </li>`
            : ""}
        </ul>`}
    <p>
      You can see ${t.places} ${t.places === 1 ? "place" : "places"}, ${t.know}
      ${t.know === 1 ? "memory" : "memories"}, ${t.work} rules, instructions,
      skills, and agents, and ${t.evidence} pieces of evidence.
      ${t.owned > 0 ? html`${t.owned} of them are yours.` : ""}
    </p>
    ${view.viewer.kind === "agent"
      ? html`<p class="hint">
          As an agent account you can read and propose, never approve.
        </p>`
      : ""}
    <p class="hint">
      Click a place to open it: its knowledge (up to ${OPEN_BUDGET} at a time)
      grows around it while everything else stays put. Drag to move, scroll to
      zoom, use the arrow keys to step between places, or find a place by
      name. Point at anything to read its name.
    </p>`;
}

function listAlternative(view: MyOverview): SafeHtml {
  const parentName = new Map(
    view.places.map((place) => [place.id, place.name]),
  );
  const rows = view.places.slice(0, LIST_LIMIT);
  return html`<details class="network-list">
    <summary>Show your access as a list</summary>
    ${table(
      ["Place", "Level", "Inside", "Your access", "Memories", "How we work"],
      rows.map((place) => [
        html`<a href="${placeHref(place)}">${place.name}</a>`,
        html`${LEVEL_LABEL[place.level]}`,
        html`${place.parentId === null
          ? "—"
          : (parentName.get(place.parentId) ?? "—")}`,
        html`${accessWords(place)}`,
        html`${place.counts.know}`,
        html`${place.counts.work}`,
      ]),
      "No places.",
    )}
    ${view.places.length > rows.length
      ? html`<p class="hint">
          The first ${rows.length} of ${view.places.length} places. Each
          business unit's page lists all of its projects.
        </p>`
      : ""}
  </details>`;
}

function placeInfo(place: MyPlace, parentName: string, organization: string) {
  return {
    title: place.name,
    name: displayName(place),
    suffix: suffixOf(place),
    kind: LEVEL_LABEL[place.level],
    level: place.level,
    parent: place.parentId,
    where: parentName,
    access: place.access,
    why: place.why,
    count: shortCount(total(place)),
    total: total(place),
    facts: [
      `Your access: ${accessWords(place)}`,
      `${place.counts.know} memories, ${place.counts.work} rules, instructions, skills, and agents, ${place.counts.evidence} pieces of evidence`,
      ...(place.level === "business_unit"
        ? [`${place.children} projects`]
        : []),
    ],
    href: placeHref(place),
    full: `/orgs/${organization}/network?focus=${encodeURIComponent(place.id)}`,
  };
}

function payload(view: MyOverview) {
  const parentName = new Map(
    view.places.map((place) => [place.id, place.name]),
  );
  const places: Record<string, unknown> = {};
  const find: Array<{ id: string; name: string; parent: string | null }> = [];
  for (const place of view.places) {
    if (place.drawn) {
      places[place.id] = placeInfo(
        place,
        place.parentId === null ? "" : (parentName.get(place.parentId) ?? ""),
        view.organization.id,
      );
    } else if (place.level === "project" && find.length < FIND_LIMIT) {
      find.push({ id: place.id, name: place.name, parent: place.parentId });
    }
  }
  const org = view.places.find((place) => place.level === "organization");
  return {
    organization: view.organization.id,
    viewer: view.viewer.name,
    org: org?.id ?? "",
    endpoint: `/orgs/${view.organization.id}/you/places/`,
    folded: view.folded,
    tops: view.tops,
    kids: view.kids,
    places,
    listed: view.listed
      .slice(0, LIST_LIMIT)
      .map((place) => ({ name: place.name, href: placeHref(place) })),
    listedCount: view.listed.length,
    find,
  };
}


async function myNetworkPage(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  const view = await getMyOverview(rc.ctx, user.id, rc.params.id ?? "");
  const org = view.organization;
  const t = view.totals;
  const metric = (name: string, label: string, value: number) =>
    html`<div class="myn-metric">
      <dt>${label}</dt>
      <dd><span class="myn-count-up" data-count="${name}">${value}</span></dd>
    </div>`;
  const names = view.places
    .filter((place) => place.drawn || place.level === "project")
    .slice(0, FIND_LIMIT);
  const family = (name: string, label: string, pressed: boolean) =>
    html`<button
      type="button"
      class="myn-key fam-${name}"
      data-family="${name}"
      aria-pressed="${pressed ? "true" : "false"}"
    >
      <span class="myn-swatch" aria-hidden="true"></span>${label}
    </button>`;
  return page(rc, {
    title: `Your network in ${org.name}`,
    workspace: true,
    immersive: true,
    body: html`<div class="myn-app" id="myn-app">
        <div class="myn-stage" id="myn-stage">
          <header class="myn-hud myn-head glass">
            <p class="myn-eyebrow">
              <a href="/orgs/${org.id}">${org.name}</a>
              <span aria-hidden="true">/</span> Your network
            </p>
            <h1>Your network</h1>
            <p class="myn-sub">
              You at the center of ${org.name}. Only what you may see is here.
              <a href="/orgs/${org.id}/network">Open the full map</a>
            </p>
            ${view.folded
              ? html`<p class="myn-sub">
                  More than ${PLACE_BUDGET} projects: the ones you have a role
                  in are drawn; open a business unit to see the rest.
                </p>`
              : ""}
            <ul class="myn-legend" aria-label="How your access is drawn">
              <li class="myn-legend-direct">
                <span aria-hidden="true"></span>Your own role: a bright line
                from you
              </li>
              <li class="myn-legend-covered">
                <span aria-hidden="true"></span>Covered by a role above
              </li>
              <li class="myn-legend-inside">
                <span aria-hidden="true"></span>No role: guidance reaches you
              </li>
            </ul>
            <dl class="myn-dash" aria-label="What you can see">
              ${metric("places", "Places", t.places)}
              ${metric("know", "What we know", t.know)}
              ${metric("work", "How we work", t.work)}
              ${metric("evidence", "Evidence", t.evidence)}
              ${metric("owned", "Yours", t.owned)}
            </dl>
          </header>

          <div class="myn-hud myn-bar glass">
            <div class="myn-keys" role="group" aria-label="Show or hide">
              ${family("work", "How we work", true)}
              ${family("know", "What we know", true)}
              ${family("evidence", "Evidence", false)}
            </div>
            <label class="visually-hidden" for="myn-find">Find a place</label>
            <input
              id="myn-find"
              class="myn-find"
              type="search"
              list="myn-place-names"
              placeholder="Find a place…"
              autocomplete="off"
            />
            <datalist id="myn-place-names">
              ${names.map(
                (place) => html`<option value="${place.name}"></option>`,
              )}
            </datalist>
          </div>

          <canvas
            id="myn-canvas"
            class="myn-canvas"
            tabindex="0"
            role="application"
            aria-roledescription="map"
            aria-label="Your network: you in the middle, then ${org.name}, its business units, and its projects. Arrow keys move between them, Enter opens one, Escape goes back. The list below the map has the same places as text."
          ></canvas>
          <div class="myn-tip" id="myn-tip" role="presentation" hidden></div>
          ${placeLinks(view)}

          <aside class="myn-hud myn-panel glass" id="myn-panel" aria-live="polite">
            <div id="myn-summary">${accessSummary(view)}</div>
            <div id="myn-detail" hidden></div>
          </aside>

          <div class="myn-hud myn-controls glass">
            <button
              type="button"
              id="myn-zoom-in"
              aria-label="Zoom in"
              title="Zoom in (+)"
            >${interfaceIcon("plus")}</button>
            <button
              type="button"
              id="myn-zoom-out"
              aria-label="Zoom out"
              title="Zoom out (−)"
            >${interfaceIcon("minus")}</button>
            <button
              type="button"
              id="myn-fit"
              aria-label="Fit everything"
              title="Fit everything (0)"
            >${interfaceIcon("fit")}</button>
            <a
              class="myn-to-list"
              href="#myn-list"
              title="The same places as a list"
              >List</a
            >
          </div>

          <p class="visually-hidden" role="status" id="myn-status"></p>
        </div>
        <section class="network-list-wrap myn-list-wrap" id="myn-list">
          ${listAlternative(view)}
        </section>
      </div>
      <script type="application/json" id="myn-data">
        ${scriptJson(payload(view))}
      </script>
      <script type="module" src="/assets/my-network.js"></script>`,
  });
}

function json(status: number, value: unknown): WebResponse {
  return {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(value),
  };
}

/** One opened place, for the page's script. Hidden places read as missing. */
async function placeContents(rc: RequestContext): Promise<WebResponse> {
  const user = requireUser(rc);
  try {
    const contents = await getMyPlace(
      rc.ctx,
      user.id,
      rc.params.id ?? "",
      rc.params.place ?? "",
    );
    return json(200, {
      ...contents,
      children: contents.children.map((child) => ({
        id: child.id,
        ...placeInfo(child, "", rc.params.id ?? ""),
      })),
    });
  } catch (error) {
    if (error instanceof NotFoundError)
      return json(404, { error: "Not found" });
    throw error;
  }
}

export const myNetworkRoutes: readonly Route[] = [
  {
    method: "GET",
    pattern: /^\/orgs\/(?<id>[^/]+)\/you$/,
    access: "user",
    handle: myNetworkPage,
  },
  {
    method: "GET",
    pattern: /^\/orgs\/(?<id>[^/]+)\/you\/places\/(?<place>[^/]+)$/,
    access: "user",
    handle: placeContents,
  },
];
