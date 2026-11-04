export const ROLES = [
  "reader",
  "contributor",
  "reviewer",
  "administrator",
  "owner",
] as const;
export type Role = (typeof ROLES)[number];

export const PRINCIPAL_KINDS = ["human", "agent"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** Mirrors the roles table. Each role includes every permission of the lower ranks. */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  reader: 1,
  contributor: 2,
  reviewer: 3,
  administrator: 4,
  owner: 5,
};

/** Roles an AI agent may hold: read and propose, never review or administer. */
export const AGENT_ROLES: readonly Role[] = ["reader", "contributor"];

/** Lowest role that may perform each action, at the target scope or any scope above it. */
export const MINIMUM_ROLE = {
  read: "reader",
  propose: "contributor",
  readProposals: "contributor",
  review: "reviewer",
  manageStructure: "administrator",
  manageRepositories: "administrator",
  manageMembers: "administrator",
  manageAdministrators: "owner",
  exportKnowledge: "administrator",
  reportOutdated: "reader",
  suspend: "contributor",
  reinstate: "reviewer",
  /** Everyone's retrieval records in the scope; anyone may read their own. */
  readRetrievalLog: "administrator",
  /** Recompute an organization's tamper-evident audit and receipt chain. */
  verifyLedger: "administrator",
  /** Change a project's review policy: required approvals and agent proposal limits. */
  managePolicy: "administrator",
} as const satisfies Record<string, Role>;

export function roleForRank(rank: number): Role {
  const role = ROLES.find((candidate) => ROLE_RANK[candidate] === rank);
  if (!role) throw new Error(`Unknown role rank: ${rank}`);
  return role;
}

/** Granting, changing, or removing an administrator or owner needs an owner. */
export function roleNeededToManage(role: Role): Role {
  return ROLE_RANK[role] >= ROLE_RANK.administrator
    ? MINIMUM_ROLE.manageAdministrators
    : MINIMUM_ROLE.manageMembers;
}
