import type { ScopeLevel } from "../../access.ts";
import type { PrincipalKind, Role } from "../../roles.ts";
import { badge, html } from "../html.ts";
import {
  initialsOf,
  page,
  type RequestContext,
  type WebResponse,
} from "../kit.ts";

export const LEVEL_LABEL: Readonly<Record<ScopeLevel, string>> = {
  organization: "organization",
  business_unit: "business unit",
  project: "project",
};

/** The most people the picker lists at once. */
export const PICKER_LIMIT = 60;

interface Grant {
  role: Role;
  level: ScopeLevel;
  scope: string;
}

interface Person {
  kind: PrincipalKind;
  name: string;
  /** Full sentences, such as "owner of Acme (organization)", for search and the tooltip. */
  roles: string[];
  grants: Grant[];
}

const LEVEL_RANK: Readonly<Record<ScopeLevel, number>> = {
  organization: 0,
  business_unit: 1,
  project: 2,
};

const GROUP_TITLES = [
  "Organization-wide",
  "Agents",
  "Business units",
  "Projects",
  "No role yet",
] as const;

function rankOf(person: Person): number {
  return Math.min(3, ...person.grants.map((grant) => LEVEL_RANK[grant.level]));
}

// Agents are few and often needed for testing, so they sit right after organization-wide people.
function groupOf(person: Person): number {
  if (person.kind === "agent") return 1;
  const rank = rankOf(person);
  return rank === 0 ? 0 : rank + 1;
}

function widestGrant(person: Person): Grant | undefined {
  return person.grants.reduce<Grant | undefined>(
    (best, grant) =>
      best === undefined || LEVEL_RANK[grant.level] < LEVEL_RANK[best.level]
        ? grant
        : best,
    undefined,
  );
}

interface PickerRow {
  id: string;
  kind: PrincipalKind;
  display_name: string;
  role: Role | null;
  level: ScopeLevel | null;
  scope_name: string | null;
}

/**
 * Local stand-in for sign-in: anyone at this computer may act as any synthetic person or agent.
 * Real sign-in waits for an approved sign-in library and GitHub docs.
 */
export async function signInPicker(rc: RequestContext): Promise<WebResponse> {
  if(rc.prototype)return page(rc,{title:"Sign in",body:html`<section class="prototype-login"><h2>Your engineering workspace</h2><p>Sign in as <strong>${rc.prototype.login}</strong> to explore original Vercel source and review imported evidence.</p><form method="post" action="/sign-in" class="stacked"><input type="hidden" name="_login" value="${rc.systemToken}"/><label>Local access key<input type="password" name="accessKey" required autocomplete="current-password" maxlength="256"/></label><button type="submit">Sign in</button></form><p class="hint">This local prototype uses a private access key. Your identity is bound to the configured GitHub operator; account impersonation and test-data controls are disabled.</p></section>`});
  const { rows } = await rc.ctx.db.query<PickerRow>(
    `SELECT pr.id, pr.kind, pr.display_name, ra.role,
            CASE WHEN ra.id IS NULL THEN NULL
                 WHEN ra.project_id IS NOT NULL THEN 'project'
                 WHEN ra.business_unit_id IS NOT NULL THEN 'business_unit'
                 ELSE 'organization' END AS level,
            COALESCE(p.name, b.name, o.name) AS scope_name
     FROM principals pr
     LEFT JOIN role_assignments ra ON ra.principal_id = pr.id AND ra.revoked_at IS NULL
     LEFT JOIN organizations o ON o.id = ra.organization_id
     LEFT JOIN business_units b ON b.id = ra.business_unit_id
     LEFT JOIN projects p ON p.id = ra.project_id
     ORDER BY pr.kind = 'agent', pr.display_name, pr.id, o.name, b.name NULLS FIRST,
              p.name NULLS FIRST`,
  );
  const people = new Map<string, Person>();
  for (const row of rows) {
    const entry = people.get(row.id) ?? {
      kind: row.kind,
      name: row.display_name,
      roles: [],
      grants: [],
    };
    if (row.role && row.level && row.scope_name) {
      entry.roles.push(
        `${row.role} of ${row.scope_name} (${LEVEL_LABEL[row.level]})`,
      );
      entry.grants.push({
        role: row.role,
        level: row.level,
        scope: row.scope_name,
      });
    }
    people.set(row.id, entry);
  }
  // At organization size there are thousands of people: show the most useful first, and search.
  const query = (rc.req.query.get("q") ?? "").trim().toLowerCase();
  const everyone = [...people];
  const matching =
    query === ""
      ? everyone
      : everyone.filter(([, person]) =>
          `${person.name} ${person.roles.join(" ")}`
            .toLowerCase()
            .includes(query),
        );
  const shown = matching
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        groupOf(a.entry[1]) - groupOf(b.entry[1]) ||
        rankOf(a.entry[1]) - rankOf(b.entry[1]) ||
        a.index - b.index,
    )
    .slice(0, PICKER_LIMIT)
    .map(({ entry }) => entry);
  // Each card is its own submit button, so choosing someone signs in at once.
  const card = ([id, person]: [string, Person]) => {
    const main = widestGrant(person);
    const more = person.grants.length - 1;
    return html`<button
      type="submit"
      name="principalId"
      value="${id}"
      class="person-card"
      title="${person.roles.length > 0 ? person.roles.join("\n") : "No roles yet"}"
    >
      <span class="avatar" aria-hidden="true">${initialsOf(person.name)}</span>
      <span class="person-text">
        <span class="person-name"
          ><strong>${person.name}</strong>
          ${person.kind === "agent" ? badge("agent", "agent") : ""}</span
        >
        <span class="person-role"
          >${main
            ? html`<span class="person-role-name">${main.role}</span> ·
                ${main.scope}`
            : "No roles yet"}</span
        >
        ${more > 0
          ? html`<span class="person-more"
              >+${more} more ${more === 1 ? "role" : "roles"}</span
            >`
          : ""}
      </span>
    </button>`;
  };
  const groups = GROUP_TITLES.map((title, group) => ({
    title,
    members: shown.filter(([, person]) => groupOf(person) === group),
  })).filter((group) => group.members.length > 0);
  const choices = groups.map(
    (group) =>
      html`<div class="picker-group">
        <h2>
          ${group.title}
          <span class="picker-count">${group.members.length}</span>
        </h2>
        <div class="person-grid">${group.members.map(card)}</div>
      </div>`,
  );
  const search =
    people.size > PICKER_LIMIT || query !== ""
      ? html`<form method="get" action="/" class="picker-search" role="search">
          <label class="visually-hidden" for="who-search"
            >Find a person by name or role</label
          >
          <input
            id="who-search"
            type="search"
            name="q"
            value="${query}"
            placeholder="Find a person by name, role, or place…"
          />
          <button type="submit" class="secondary">Find</button>
        </form>`
      : html``;
  const note =
    matching.length > shown.length
      ? html`<p class="picker-more">
          Showing ${shown.length} of ${matching.length}, people with wider
          roles first. Search to find anyone else.
        </p>`
      : query !== "" && matching.length === 0
        ? html`<p class="empty">Nobody matches “${query}”.</p>`
        : html``;
  return page(rc, {
    title: "Choose who you are",
    body: html`<p class="warning">
        Local testing only. Real sign-in is not built yet, so anyone using this
        computer can act as any person below. Use only public or synthetic evidence.
      </p>
      ${people.size === 0
        ? html`<p class="empty">
            No people yet. <a href="/system">Load the synthetic example data</a>
            first.
          </p>`
        : html`<div class="picker-bar">${search} ${note}</div>
            <form method="post" action="/sign-in" class="picker">
              <p class="picker-hint">Pick a card to sign in as that person.</p>
              ${choices}
            </form>`}`,
  });
}
