// Loads public GitHub pull requests (downloaded by src/scripts/download-public-data.ts) as one large
// organization, for local scale testing. People are stand-ins: no GitHub user names are stored.
import type { Principal, ScopeRef } from "./access.ts";
import { captureMergedPullRequest } from "./capture.ts";
import type { MemoryNetContext } from "./context.ts";
import {
  approveDefinitionProposal,
  proposeDefinition,
  proposeDefinitionRetirement,
  type Definition,
  type DefinitionLink,
} from "./definitions.ts";
import { ConflictError, ValidationError } from "./errors.ts";
import { suspendMemory } from "./history.ts";
import {
  approveProposal,
  proposeMemory,
  type Memory,
  type MemoryType,
} from "./knowledge.ts";
import { assignRole, createPrincipal } from "./members.ts";
import {
  createBusinessUnit,
  createOrganization,
  createProject,
} from "./organizations.ts";
import { connectRepository, recordRepositoryAccess } from "./repositories.ts";
import type { Role } from "./roles.ts";

export const PUBLIC_DATA_FORMAT = "memorynet.public-prs";

export interface PublicPullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  mergeCommitSha: string;
  mergedAt: string;
  /** A one-way key for the author, so the same author maps to the same stand-in. */
  authorKey: string;
  labels: string[];
}

export interface PublicRepository {
  id: number;
  name: string;
  fullName: string;
  description: string;
  url: string;
  /** The repository's main language from GitHub, when known. */
  language?: string | null;
  /** The repository's GitHub topics, when known. */
  topics?: string[];
  pullRequests: PublicPullRequest[];
}

export interface PublicDataset {
  format: typeof PUBLIC_DATA_FORMAT;
  version: 1;
  downloadedAt: string;
  organizations: string[];
  repositories: PublicRepository[];
}

export interface PublicDataSummary {
  organizationId: string;
  businessUnits: number;
  projects: number;
  people: number;
  sources: number;
  memories: number;
  pending: number;
  definitions: number;
}

/** Removes HTML comments, sign-off lines, email addresses, and @mentions from public text. */
export function scrubPublicText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(signed-off-by|co-authored-by):/i.test(line))
    .join("\n")
    .replace(
      /[\w.%+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g,
      "[email removed]",
    )
    .replace(/(^|[^\w`/])@[A-Za-z0-9][A-Za-z0-9-]{0,38}/g, "$1@someone")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const FIRST = [
  "Alex",
  "Blake",
  "Casey",
  "Devon",
  "Emery",
  "Finley",
  "Gray",
  "Harper",
  "Indy",
  "Jules",
  "Kai",
  "Lane",
  "Milan",
  "Noor",
  "Oakley",
  "Parker",
  "Quinn",
  "Reese",
  "Sage",
  "Tatum",
  "Uma",
  "Vic",
  "Wren",
  "Yael",
  "Zion",
];
const LAST = [
  "Abbott",
  "Brooks",
  "Carver",
  "Dalton",
  "Ellis",
  "Foster",
  "Grant",
  "Hayes",
  "Irwin",
  "Jensen",
  "Keller",
  "Lowell",
  "Mercer",
  "Nash",
  "Orton",
  "Pryce",
  "Quill",
  "Rowe",
  "Sutton",
  "Thorne",
  "Upton",
  "Vance",
  "Wade",
  "Yates",
  "Zeller",
];

const KIND_TYPES: ReadonlyArray<readonly [string, MemoryType]> = [
  ["kind/regression", "incident"],
  ["kind/failing-test", "lesson"],
  ["kind/flake", "lesson"],
  ["kind/bug", "lesson"],
  ["kind/deprecation", "constraint"],
  ["kind/api-change", "decision"],
  ["kind/feature", "decision"],
  ["kind/design", "rationale"],
  ["kind/documentation", "rationale"],
  ["kind/cleanup", "decision"],
];

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619) >>> 0;
  }
  return value;
}

function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "x" : slug;
}

function titleCase(words: string): string {
  return words
    .split(/[-_ ]+/)
    .filter((word) => word !== "")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/** The value most of a repository's pull requests yield from their labels, ties broken by name. */
function majorityLabel(
  repository: PublicRepository,
  pick: (label: string) => string | null,
): string | null {
  const counts = new Map<string, number>();
  for (const pull of repository.pullRequests) {
    for (const label of pull.labels) {
      const value = pick(label);
      if (value !== null && value !== "") {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
  }
  return (
    [...counts].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0] ?? null
  );
}

const TEAM_LABEL = /^(team|created-by)[:/]\s*(.+?)( team)?$/i;

/**
 * The business unit name a repository belongs to: the SIG most of its pull requests are labeled
 * with ("SIG Node"), else its most common team label ("Turbopack"), else its language
 * ("Rust engineering"), else its owner when the dataset spans several organizations, else
 * "Community infrastructure".
 */
export function groupOf(
  repository: PublicRepository,
  multipleOrgs: boolean,
): string {
  const sig = majorityLabel(repository, (label) =>
    label.startsWith("sig/") ? label.slice(4) : null,
  );
  if (sig !== null) return `SIG ${titleCase(sig)}`;
  const team = majorityLabel(
    repository,
    (label) => TEAM_LABEL.exec(label.trim())?.[2]?.trim() ?? null,
  );
  if (team !== null) return titleCase(team.replace(/\//g, " "));
  const language = repository.language?.trim();
  if (language) return `${language} engineering`;
  const owner = repository.fullName.split("/")[0] ?? "";
  if (multipleOrgs && owner !== "") return titleCase(owner);
  return "Community infrastructure";
}

const LABEL_TYPES: ReadonlyArray<readonly [ReadonlyArray<string>, MemoryType]> =
  [
    [["regression", "incident", "outage", "hotfix"], "incident"],
    [["security", "vulnerability"], "constraint"],
    [["breaking", "breaking-change", "deprecation", "deprecated"], "constraint"],
    [["bug", "type: bug", "flaky", "flake"], "lesson"],
    [["documentation", "docs", "rfc", "design", "proposal", "adr"], "rationale"],
    [["feature", "enhancement", "type: feature", "api-change"], "decision"],
    [["performance", "perf"], "lesson"],
  ];

const CONVENTIONAL_TYPES: Readonly<Record<string, MemoryType | null>> = {
  revert: "incident",
  fix: "lesson",
  bugfix: "lesson",
  hotfix: "lesson",
  perf: "lesson",
  feat: "decision",
  feature: "decision",
  refactor: "decision",
  docs: "rationale",
  security: "constraint",
  chore: null,
  test: null,
  tests: null,
  ci: null,
  build: null,
  style: null,
  deps: null,
  release: null,
  backport: null,
  bump: null,
};

interface TitlePrefix {
  type: string;
  breaking: boolean;
  rest: string;
}

/** A leading "type(scope)!: " or "[type] " on a title, if any. */
function titlePrefix(title: string): TitlePrefix | null {
  const conventional = /^\s*([a-z][\w-]*)(?:\([^)]*\))?(!)?:\s*(.*)$/is.exec(
    title,
  );
  if (conventional) {
    return {
      type: (conventional[1] ?? "").toLowerCase(),
      breaking: conventional[2] === "!",
      rest: conventional[3] ?? "",
    };
  }
  const bracket = /^\s*\[([^\]]+)\]\s*(.*)$/s.exec(title);
  if (bracket) {
    return {
      type: (bracket[1] ?? "").trim().toLowerCase(),
      breaking: false,
      rest: bracket[2] ?? "",
    };
  }
  return null;
}

const VERB_TYPES: ReadonlyArray<readonly [RegExp, MemoryType]> = [
  [/^revert\b/i, "incident"],
  [/^(fix|fixes|fixed|resolve|prevent|handle)\b/i, "lesson"],
  [/^(deprecate|remove support|drop support)\b/i, "constraint"],
  [/^(add|introduce|support|implement|enable|allow)\b/i, "decision"],
  [/^(document|docs?)\b/i, "rationale"],
];

/**
 * The memory type a merged pull request suggests, or null when it holds nothing worth remembering.
 * Kubernetes kind labels come first, then common labels, then a conventional-commit title prefix,
 * then the title's leading verb.
 */
/** Version bumps from bots or by hand: routine upkeep, not knowledge worth keeping. */
export function isDependencyBump(title: string): boolean {
  const text = title.trim().replace(/^\[[^\]]*\]\s*/, "");
  return (
    /^(chore|build|fix|deps)?\(deps(-dev)?\)!?:/i.test(text) ||
    /^(bump|update|upgrade)\s.*\s(from|to)\s+[v^~=<>]*\d/i.test(
      text.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, ""),
    ) ||
    /^(bump|update|upgrade)\s+(the\s+)?[\w@./-]+\s+(dependencies|deps|group)\b/i.test(
      text.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, ""),
    )
  );
}

export function memoryTypeOf(pull: PublicPullRequest): MemoryType | null {
  // Upkeep comes first: a dependency bump is not a decision, whatever it is labelled.
  if (isDependencyBump(pull.title)) return null;
  for (const [label, type] of KIND_TYPES) {
    if (pull.labels.includes(label)) return type;
  }
  const labels = new Set(pull.labels.map((label) => label.trim().toLowerCase()));
  for (const [names, type] of LABEL_TYPES) {
    if (names.some((name) => labels.has(name))) return type;
  }
  let title = pull.title.trim();
  const prefix = titlePrefix(title);
  if (prefix) {
    if (prefix.breaking) return "constraint";
    if (Object.hasOwn(CONVENTIONAL_TYPES, prefix.type)) {
      return CONVENTIONAL_TYPES[prefix.type] ?? null;
    }
    title = prefix.rest.trim();
  }
  if (
    /^(bump|update)\s.*\s(from|to)\s+[v^~=<>]*\d/i.test(title) ||
    /^chore\(deps\)/i.test(title)
  ) {
    return null;
  }
  for (const [pattern, type] of VERB_TYPES) {
    if (pattern.test(title)) return type;
  }
  return null;
}

/** A pull request title for a memory: a known conventional-commit prefix is dropped. */
export function memoryTitleOf(pull: PublicPullRequest): string {
  const prefix = titlePrefix(pull.title);
  let title = pull.title;
  if (
    prefix &&
    Object.hasOwn(CONVENTIONAL_TYPES, prefix.type) &&
    prefix.rest.trim() !== ""
  ) {
    const rest = prefix.rest.trim();
    title = rest[0]?.toUpperCase() + rest.slice(1);
  }
  return `${title.slice(0, 180)} (#${pull.number})`;
}

/** The "what this PR does" part of a pull request description, or its first paragraph. */
export function summaryOf(pull: PublicPullRequest): string {
  const body = pull.body;
  const section =
    /what this pr does[^\n]*\n([\s\S]*?)(?:\n#{1,6}\s|\n\*\*which issue|$)/i.exec(
      body,
    )?.[1] ??
    body.split(/\n\s*\n/)[0] ??
    "";
  const text = section
    .replace(/^#{1,6}\s.*$/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const short = text.length > 800 ? `${text.slice(0, 797)}…` : text;
  return short.length >= 20 ? short : pull.title;
}

/**
 * One organization from the dataset: business units come from groupOf (SIG, team label, language, or
 * owner), projects are repositories, and merged pull requests are captured sources. Memories come
 * from pull requests whose labels or title suggest a memory type (memoryTypeOf), proposed and
 * approved by stand-in people through the normal checks; some are left pending, a few suspended.
 */
export async function loadPublicDataset(
  ctx: MemoryNetContext,
  dataset: PublicDataset,
  options: { slug?: string; name?: string } = {},
): Promise<PublicDataSummary> {
  if (dataset.format !== PUBLIC_DATA_FORMAT || dataset.version !== 1) {
    throw new ValidationError(
      "This file is not a MemoryNet public pull request download",
    );
  }
  let nameIndex = 0;
  const people: Principal[] = [];
  const person = async (prefix?: string): Promise<Principal> => {
    const first = FIRST[nameIndex % FIRST.length] ?? "Alex";
    const last =
      LAST[Math.floor(nameIndex / FIRST.length) % LAST.length] ?? "Abbott";
    const round = Math.floor(nameIndex / (FIRST.length * LAST.length));
    nameIndex += 1;
    const principal = await createPrincipal(ctx, {
      kind: "human",
      displayName:
        prefix ?? `${first} ${last}${round > 0 ? ` ${round + 1}` : ""}`,
    });
    people.push(principal);
    return principal;
  };

  const owner = await person("Morgan Steward");
  const admin = await person("Ari Admin");
  const orgReader = await person("Robin Reader");
  const newcomer = await person("Casey Newcomer");
  const bot = await createPrincipal(ctx, {
    kind: "agent",
    displayName: "Triage Bot",
  });
  const label = dataset.organizations.join(" + ");
  const organization = await createOrganization(ctx, owner.id, {
    slug:
      options.slug ?? slugOf(`${dataset.organizations[0] ?? "public"}-public`),
    name: options.name ?? `${titleCase(label)} (public data)`,
  }).catch((error: unknown) => {
    if (error instanceof ConflictError) {
      throw new ConflictError("This public dataset is already loaded.");
    }
    throw error;
  });
  const orgScope: ScopeRef = { level: "organization", id: organization.id };
  const grant = (by: Principal, who: Principal, scope: ScopeRef, role: Role) =>
    assignRole(ctx, by.id, { principalId: who.id, scope, role });
  await grant(owner, admin, orgScope, "administrator");
  await grant(owner, orgReader, orgScope, "reader");

  const owners = new Set(
    dataset.repositories.map((repository) => repository.fullName.split("/")[0]),
  );
  const multipleOrgs =
    new Set(dataset.organizations).size > 1 || owners.size > 1;
  const groups = new Map<string, PublicRepository[]>();
  for (const repository of dataset.repositories) {
    if (repository.pullRequests.length === 0) continue;
    const group = groupOf(repository, multipleOrgs);
    groups.set(group, [...(groups.get(group) ?? []), repository]);
  }

  const summary: PublicDataSummary = {
    organizationId: organization.id,
    businessUnits: 0,
    projects: 0,
    people: 0,
    sources: 0,
    memories: 0,
    pending: 0,
    definitions: 0,
  };
  const define = async (
    by: Principal,
    reviewer: Principal,
    input: Parameters<typeof proposeDefinition>[2],
  ): Promise<Definition> => {
    const proposal = await proposeDefinition(ctx, by.id, input);
    summary.definitions += 1;
    return approveDefinitionProposal(ctx, reviewer.id, {
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
    });
  };

  const releaseNotes = await define(owner, admin, {
    scope: orgScope,
    kind: "rule",
    name: "Every pull request has a release note",
    purpose: "Users and operators learn about every change that affects them.",
    responsibilities: [
      "User-facing changes describe the change in a release note",
      "Changes with no user impact say NONE",
    ],
    appliesTo: "Every repository in the organization",
  });
  const ownersApprove = await define(owner, admin, {
    scope: orgScope,
    kind: "rule",
    name: "Changes need approval from an owner of the code",
    purpose:
      "Someone accountable for the code checks every change before it merges.",
    responsibilities: [
      "Every change is approved by an approver of the files it touches",
      "Authors never approve their own change",
    ],
    boundaries: ["Automated dependency bumps that pass every test"],
  });
  const noSecrets = await define(owner, admin, {
    scope: orgScope,
    kind: "rule",
    name: "Keep secrets out of pull requests",
    purpose:
      "Credentials must never leak through code, review text, or AI assistants.",
    responsibilities: [
      "Tokens and keys never appear in code or pull request text",
      "A leaked credential is rotated first, then reported",
    ],
  });
  const writeNote = await define(owner, admin, {
    scope: orgScope,
    kind: "skill",
    name: "Write a release note",
    purpose: "Turns a merged change into a short note for users.",
    responsibilities: [
      "Say what changed for users, in one or two sentences",
      "Name any action users must take",
    ],
    links: [{ relation: "follows", targetId: releaseNotes.id }],
  });
  const notesAssistant = await define(owner, admin, {
    scope: orgScope,
    kind: "agent",
    name: "Release notes assistant",
    purpose:
      "Drafts release notes from merged pull requests for a person to check.",
    responsibilities: [
      "Draft a release note for each merged user-facing change",
      "Ask the author when the impact is unclear",
    ],
    boundaries: ["Publishing release notes", "Approving pull requests"],
    links: [
      { relation: "uses", targetId: writeNote.id },
      { relation: "follows", targetId: releaseNotes.id },
      { relation: "follows", targetId: noSecrets.id },
    ],
  });

  let firstInstruction: Definition | null = null;
  let newcomerPlaced = false;
  const unitSlugs = new Set<string>();
  for (const [unitName, repositories] of [...groups].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const baseSlug = slugOf(unitName);
    let unitSlug = baseSlug;
    for (let copy = 2; unitSlugs.has(unitSlug); copy += 1) {
      unitSlug = `${baseSlug.slice(0, 56)}-${copy}`;
    }
    unitSlugs.add(unitSlug);
    const unit = await createBusinessUnit(ctx, owner.id, {
      organizationId: organization.id,
      slug: unitSlug,
      name: unitName,
    });
    summary.businessUnits += 1;
    const unitScope: ScopeRef = { level: "business_unit", id: unit.id };
    const chair = await person();
    const coChair = await person();
    await grant(owner, chair, unitScope, "administrator");
    await grant(owner, coChair, unitScope, "administrator");
    const unitMemories: Memory[] = [];

    for (const repository of repositories) {
      const project = await createProject(ctx, owner.id, {
        businessUnitId: unit.id,
        slug: slugOf(repository.fullName.replace("/", "-")),
        name: repository.fullName,
      });
      summary.projects += 1;
      const projectScope: ScopeRef = { level: "project", id: project.id };
      const externalRepositoryId = String(repository.id);
      await connectRepository(ctx, admin.id, {
        projectId: project.id,
        provider: "github",
        externalRepositoryId,
        fullName: repository.fullName,
      });
      const reviewers = [await person(), await person()];
      const contributors = [await person(), await person(), await person()];
      const readers = [await person()];
      for (const who of reviewers)
        await grant(chair, who, projectScope, "reviewer");
      for (const who of contributors)
        await grant(chair, who, projectScope, "contributor");
      for (const who of readers)
        await grant(chair, who, projectScope, "reader");
      const access = [
        owner,
        admin,
        orgReader,
        chair,
        coChair,
        ...reviewers,
        ...contributors,
        ...readers,
      ];
      if (!newcomerPlaced) {
        await grant(chair, newcomer, projectScope, "reader");
        access.push(newcomer);
        newcomerPlaced = true;
      }
      if (summary.projects <= 5) {
        await grant(chair, bot, projectScope, "contributor");
        access.push(bot);
      }
      for (const who of access) {
        await recordRepositoryAccess(ctx, {
          principalId: who.id,
          provider: "github",
          externalRepositoryId,
          canRead: true,
        });
      }

      const authors = [...contributors, ...reviewers];
      const projectMemories: Memory[] = [];
      let candidates = 0;
      for (const pull of repository.pullRequests) {
        const captured = await captureMergedPullRequest(ctx, {
          provider: "github",
          externalRepositoryId,
          pullRequestNumber: pull.number,
          url: pull.url,
          mergeCommitSha: pull.mergeCommitSha,
          title: pull.title,
          body: pull.body,
        }).catch(() => null);
        if (captured?.status !== "captured") continue;
        summary.sources += 1;
        const type = memoryTypeOf(pull);
        if (type === null) continue;
        candidates += 1;
        const author =
          authors[hash(pull.authorKey) % authors.length] ?? contributors[0];
        if (!author) continue;
        const reviewer =
          reviewers[0]?.id === author.id ? reviewers[1] : reviewers[0];
        try {
          const proposal = await proposeMemory(ctx, author.id, {
            projectId: project.id,
            type,
            title: memoryTitleOf(pull),
            content: summaryOf(pull),
            evidenceSourceIds: [captured.source.id],
          });
          if (candidates % 9 === 0 || !reviewer) {
            summary.pending += 1;
            continue;
          }
          const memory = await approveProposal(ctx, reviewer.id, {
            proposalId: proposal.id,
            expectedRevision: proposal.revision,
          });
          summary.memories += 1;
          if (candidates % 40 === 0) {
            await suspendMemory(ctx, reviewer.id, {
              memoryId: memory.id,
              expectedRevision: memory.revision,
              reason: "Disputed while the change is reviewed again",
            });
          } else {
            projectMemories.push(memory);
          }
        } catch (error) {
          if (
            !(
              error instanceof ValidationError || error instanceof ConflictError
            )
          ) {
            throw error;
          }
        }
      }
      unitMemories.push(...projectMemories);
      const lead = reviewers[0];
      if (lead && projectMemories.length >= 2) {
        await define(lead, chair, {
          scope: projectScope,
          kind: "skill",
          name: `Check changes against ${repository.name} decisions`,
          purpose: `Finds the approved decisions in ${repository.fullName} a change might break.`,
          responsibilities: [
            "Find approved memories related to the files in the change",
            "Quote each related memory with its ID and version",
          ],
          boundaries: [
            "Treating an empty result as proof that no decision exists",
          ],
          links: [
            { relation: "follows", targetId: ownersApprove.id },
            ...projectMemories
              .slice(0, 3)
              .map(
                (memory): DefinitionLink => ({
                  relation: "based_on",
                  targetId: memory.id,
                }),
              ),
          ],
        });
      }
    }

    const guidance = await define(chair, owner, {
      scope: unitScope,
      kind: "instruction",
      name: `${unitName} review guidance`,
      purpose: `How changes in ${unitName} are reviewed.`,
      responsibilities: [
        `Ask a ${unitName} approver to review changes in its repositories`,
        "Link the issue or design the change follows",
      ],
      links: [{ relation: "follows", targetId: ownersApprove.id }],
    });
    firstInstruction ??= guidance;
    await define(chair, owner, {
      scope: unitScope,
      kind: "agent",
      name: `${unitName} triage assistant`,
      purpose: `Sorts new issues and pull requests in ${unitName} for a person to check.`,
      responsibilities: [
        "Suggest labels and reviewers for new pull requests",
        "Point to related approved decisions",
      ],
      boundaries: ["Merging or approving anything", "Closing issues"],
      links: [
        { relation: "uses", targetId: writeNote.id },
        { relation: "follows", targetId: guidance.id },
        { relation: "follows", targetId: noSecrets.id },
        { relation: "hands_off_to", targetId: notesAssistant.id },
        ...unitMemories
          .slice(0, 2)
          .map(
            (memory): DefinitionLink => ({
              relation: "based_on",
              targetId: memory.id,
            }),
          ),
      ],
    });
  }

  if (firstInstruction) {
    const retire = await proposeDefinitionRetirement(ctx, admin.id, {
      definitionId: firstInstruction.id,
      baseRevision: firstInstruction.revision,
      reason: "Replaced by the organization-wide approval rule",
    });
    await approveDefinitionProposal(ctx, owner.id, {
      proposalId: retire.id,
      expectedRevision: retire.revision,
    });
  }
  summary.people = people.length + 1;
  return summary;
}
