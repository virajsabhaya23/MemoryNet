import { requireScopeRef, resolveScope, type ScopeRef } from "../access.ts";
import type { ContentFlag } from "../content-checks.ts";
import { NotFoundError } from "../errors.ts";
import type { Evidence, MemoryStatus } from "../knowledge.ts";
import { describePrincipals } from "../members.ts";
import {
  getOrganizationTree,
  type OrganizationTree,
} from "../organizations.ts";
import { ROLE_RANK, type PrincipalKind, type Role } from "../roles.ts";
import { requireId } from "../validation.ts";
import { badge, externalLink, html, join, type SafeHtml } from "./html.ts";
import { requireUser, type RequestContext } from "./kit.ts";

export function scopePath(scope: ScopeRef): string {
  if (scope.level === "organization") return `/orgs/${scope.id}`;
  if (scope.level === "business_unit") return `/business-units/${scope.id}`;
  return `/projects/${scope.id}`;
}

/** The scope named by a /scopes/:level/:id route. */
export function routeScope(rc: RequestContext): ScopeRef {
  return requireScopeRef({ level: rc.params.level, id: rc.params.id });
}

export function rankOf(role: Role | null): number {
  return role === null ? 0 : ROLE_RANK[role];
}

export function roleBadge(role: Role | null): SafeHtml {
  return role === null ? badge("no role here", "muted") : badge(role, "role");
}

export function typeLabel(type: string): string {
  return type.replaceAll("_", " ");
}

export const REASON_INPUT = html`<label
  >Reason <input name="reason" required maxlength="500"
/></label>`;

/** Loading a hidden scope reads the same as a missing one. */
export function notFoundAs(message: string): (error: unknown) => never {
  return (error) => {
    if (error instanceof NotFoundError) throw new NotFoundError(message);
    throw error;
  };
}

type TreeUnit = OrganizationTree["businessUnits"][number];
type TreeProject = TreeUnit["projects"][number];

export interface ProjectView {
  tree: OrganizationTree;
  businessUnit: TreeUnit;
  project: TreeProject;
}

/** A project the signed-in person can see, with its organization and business unit. */
export async function loadProject(
  rc: RequestContext,
  projectId: string | undefined,
): Promise<ProjectView> {
  const user = requireUser(rc);
  const id = requireId(projectId, "projectId");
  const scope = await resolveScope(rc.ctx.db, { level: "project", id });
  const tree = await getOrganizationTree(
    rc.ctx,
    user.id,
    scope.organizationId,
  ).catch(notFoundAs("Project not found"));
  for (const businessUnit of tree.businessUnits) {
    const project = businessUnit.projects.find((item) => item.id === id);
    if (project) return { tree, businessUnit, project };
  }
  throw new NotFoundError("Project not found");
}

export function projectCrumbs(
  view: ProjectView,
): ReadonlyArray<readonly [string, string]> {
  return [
    [view.tree.organization.name, `/orgs/${view.tree.organization.id}`],
    [view.businessUnit.name, `/business-units/${view.businessUnit.id}`],
    [view.project.name, `/projects/${view.project.id}`],
  ];
}

export type Names = Map<string, { displayName: string; kind: PrincipalKind }>;

export function namesFor(
  rc: RequestContext,
  ids: ReadonlyArray<string | null>,
): Promise<Names> {
  return describePrincipals(
    rc.ctx.db,
    ids.filter((id): id is string => id !== null),
  );
}

export function nameOf(
  names: Names,
  id: string | null,
  fallback = "—",
): string {
  if (id === null) return fallback;
  const entry = names.get(id);
  if (!entry) return "Unknown";
  return entry.kind === "agent"
    ? `${entry.displayName} (agent)`
    : entry.displayName;
}

const FLAG_LABELS: Readonly<Record<ContentFlag, string>> = {
  secret_removed: "secret removed",
  personal_data: "possible personal data",
  truncated: "shortened",
};

export function flagBadges(flags: readonly ContentFlag[]): SafeHtml {
  return join(
    flags.map((flag) =>
      badge(FLAG_LABELS[flag], flag === "truncated" ? "muted" : "warn"),
    ),
  );
}

export function shortSha(revision: string | null): string {
  return revision === null ? "no commit" : revision.slice(0, 7);
}

const MEMORY_STATUS_BADGES: Readonly<
  Record<MemoryStatus, readonly [string, string]>
> = {
  approved: ["current", "ok"],
  suspended: ["suspended", "warn"],
  superseded: ["replaced", "muted"],
  revoked: ["revoked", "warn"],
};

/** current, suspended, or replaced, so old or disputed guidance never looks current. */
export function memoryStatusBadge(status: MemoryStatus): SafeHtml {
  const [label, variant] = MEMORY_STATUS_BADGES[status];
  return badge(label, variant);
}

/** Cited sources: link, commit, capture time, flags, and the excerpt itself. */
export function evidenceList(evidence: readonly Evidence[]): SafeHtml {
  if (evidence.length === 0) {
    return html`<p class="empty">No evidence you can read.</p>`;
  }
  return html`<ul class="evidence">
    ${evidence.map(
      (item) =>
        html`<li>
          <p>
            ${externalLink(item.url, item.reference)}
            <small
              >commit ${shortSha(item.revision)} · captured
              ${item.capturedAt}</small
            >
            ${flagBadges(item.flags)}
            <a href="/sources/${item.sourceId}">source record</a>
          </p>
          <blockquote>${item.excerpt}</blockquote>
        </li>`,
    )}
  </ul>`;
}
