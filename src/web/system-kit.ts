import { UNCONNECTED_EXAMPLE_REPOSITORY } from "../demo-data.ts";
import type { PrincipalKind } from "../roles.ts";
import { html, options, type SafeHtml } from "./html.ts";
import { systemField, type RequestContext } from "./kit.ts";

/** A form on the System page. It carries the system token instead of a person's session token. */
export function systemForm(
  rc: RequestContext,
  action: string,
  fields: SafeHtml,
  button: string,
): SafeHtml {
  return html`<form method="post" action="${action}" class="stacked">
    ${systemField(rc)} ${fields}
    <button type="submit">${button}</button>
  </form>`;
}

export interface PrincipalRow {
  id: string;
  kind: PrincipalKind;
  display_name: string;
  github_user_id: string | null;
}

export async function allPrincipals(
  rc: RequestContext,
): Promise<PrincipalRow[]> {
  const { rows } = await rc.ctx.db.query<PrincipalRow>(
    `SELECT id, kind, display_name, github_user_id FROM principals
     ORDER BY kind = 'agent', display_name, id`,
  );
  return rows;
}

export function principalOptions(
  principals: readonly PrincipalRow[],
): SafeHtml {
  return options(
    principals.map((principal) => ({
      value: principal.id,
      label:
        principal.kind === "agent"
          ? `${principal.display_name} (agent)`
          : principal.display_name,
    })),
  );
}

export interface KnownRepository {
  externalRepositoryId: string;
  /** Null when no project ever connected it and it is not the synthetic example. */
  fullName: string | null;
}

/** Repositories the synthetic GitHub App knows about: connected ones and ones with access reports. */
export async function knownRepositories(
  rc: RequestContext,
): Promise<KnownRepository[]> {
  const { rows } = await rc.ctx.db.query<{
    external_repository_id: string;
    full_name: string | null;
  }>(
    `SELECT r.external_repository_id,
            (SELECT c.full_name FROM repository_connections c
             WHERE c.external_repository_id = r.external_repository_id
             ORDER BY c.connected_at DESC LIMIT 1) AS full_name
     FROM (SELECT external_repository_id FROM repository_access
           UNION SELECT external_repository_id FROM repository_connections) r
     ORDER BY length(r.external_repository_id), r.external_repository_id`,
  );
  return rows.map((row) => ({
    externalRepositoryId: row.external_repository_id,
    fullName:
      row.full_name ??
      (row.external_repository_id ===
      UNCONNECTED_EXAMPLE_REPOSITORY.externalRepositoryId
        ? UNCONNECTED_EXAMPLE_REPOSITORY.fullName
        : null),
  }));
}

export function repositoryOptions(
  repositories: readonly KnownRepository[],
): SafeHtml {
  return options(
    repositories.map((repository) => ({
      value: repository.externalRepositoryId,
      label: `${repository.externalRepositoryId} ${repository.fullName ?? "(never connected)"}`,
    })),
  );
}

/** The System page's tabs, in order: what each is called and what it is for. */
export const SYSTEM_TABS = [
  ["overview", "Overview", "Status and the everyday event"],
  ["people", "People", "Stand-in accounts"],
  ["access", "Repository access", "What GitHub says each person can read"],
  ["github", "GitHub events", "Merged pull requests and removed repositories"],
  ["checks", "Check preview", "What a pull request check would say"],
] as const;
export type SystemTab = (typeof SYSTEM_TABS)[number][0];

export function isSystemTab(
  value: string | null | undefined,
): value is SystemTab {
  return SYSTEM_TABS.some(([id]) => id === value);
}

/** Where a System form returns: the tab it was sent from, or the overview. */
export function systemPath(rc: RequestContext): string {
  const back = rc.form.get("back");
  return isSystemTab(back) && back !== "overview"
    ? `/system?tab=${back}`
    : "/system";
}

/** A date and time to the minute, in UTC. */
export function stamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
