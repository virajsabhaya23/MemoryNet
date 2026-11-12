// Synthetic example organizations for the local test app. Every name, ID, and text is made up.
import type { Principal, ScopeRef } from "./access.ts";
import type { MemoryNetContext } from "./context.ts";
import {
  approveDefinitionProposal,
  proposeDefinition,
  proposeDefinitionChange,
  proposeDefinitionRetirement,
  type Definition,
} from "./definitions.ts";
import { ConflictError } from "./errors.ts";
import {
  approveProposal,
  proposeMemory,
  recordSource,
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

/** A repository the synthetic GitHub App can see but no project has connected yet. */
export const UNCONNECTED_EXAMPLE_REPOSITORY = {
  externalRepositoryId: "1004",
  fullName: "acme-synthetic/shared-docs",
} as const;

export interface ExampleDataSummary {
  people: number;
  agents: number;
  organizations: number;
  projects: number;
}

let loading = false;

function scope(level: ScopeRef["level"], id: string): ScopeRef {
  return { level, id };
}

/** Fills an empty database with two synthetic organizations, their people, repositories, and knowledge. */
export async function loadExampleData(
  ctx: MemoryNetContext,
): Promise<ExampleDataSummary> {
  const { rows } = await ctx.db.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM principals",
  );
  if (loading || (rows[0]?.count ?? 0) > 0) {
    throw new ConflictError(
      "Example data can only be loaded into an empty database. Stop the app, run npm run app:reset, and start it again.",
    );
  }
  loading = true;
  try {
    return await load(ctx);
  } finally {
    loading = false;
  }
}

async function load(ctx: MemoryNetContext): Promise<ExampleDataSummary> {
  const person = (displayName: string, githubUserId: string) =>
    createPrincipal(ctx, { kind: "human", displayName, githubUserId });
  const olivia = await person("Olivia Owner", "910001");
  const adam = await person("Adam Admin", "910002");
  const pat = await person("Pat Platform", "910003");
  const rhea = await person("Rhea Reviewer", "910004");
  const cody = await person("Cody Contributor", "910005");
  const rudy = await person("Rudy Reader", "910006");
  const oscar = await person("Oscar Outsider", "910007");
  const gina = await person("Gina Globex", "910010");
  const glen = await person("Glen Globex", "910011");
  const agent = await createPrincipal(ctx, {
    kind: "agent",
    displayName: "Coding Agent",
  });

  const grant = (by: Principal, who: Principal, at: ScopeRef, role: Role) =>
    assignRole(ctx, by.id, { principalId: who.id, scope: at, role });

  const acme = await createOrganization(ctx, olivia.id, {
    slug: "acme-synthetic",
    name: "Acme (synthetic)",
  });
  const platform = await createBusinessUnit(ctx, olivia.id, {
    organizationId: acme.id,
    slug: "platform",
    name: "Platform",
  });
  const support = await createBusinessUnit(ctx, olivia.id, {
    organizationId: acme.id,
    slug: "support-tools",
    name: "Support Tools",
  });
  const checkout = await createProject(ctx, olivia.id, {
    businessUnitId: platform.id,
    slug: "checkout",
    name: "Checkout",
  });
  const payments = await createProject(ctx, olivia.id, {
    businessUnitId: platform.id,
    slug: "payments",
    name: "Payments",
  });
  const helpdesk = await createProject(ctx, olivia.id, {
    businessUnitId: support.id,
    slug: "helpdesk",
    name: "Helpdesk",
  });
  await grant(olivia, adam, scope("organization", acme.id), "administrator");
  await grant(
    olivia,
    pat,
    scope("business_unit", platform.id),
    "administrator",
  );
  await grant(adam, rhea, scope("project", checkout.id), "reviewer");
  await grant(adam, cody, scope("project", checkout.id), "contributor");
  await grant(adam, rudy, scope("project", checkout.id), "reader");
  await grant(adam, agent, scope("project", checkout.id), "contributor");

  const globex = await createOrganization(ctx, gina.id, {
    slug: "globex-synthetic",
    name: "Globex (synthetic)",
  });
  const core = await createBusinessUnit(ctx, gina.id, {
    organizationId: globex.id,
    slug: "core",
    name: "Core",
  });
  const ledger = await createProject(ctx, gina.id, {
    businessUnitId: core.id,
    slug: "ledger",
    name: "Ledger",
  });
  await grant(gina, glen, scope("project", ledger.id), "reviewer");

  const repositories = [
    [checkout.id, "1001", "acme-synthetic/checkout-service", adam],
    [payments.id, "1002", "acme-synthetic/payments-service", adam],
    [helpdesk.id, "1003", "acme-synthetic/helpdesk-app", adam],
    [ledger.id, "2001", "globex-synthetic/ledger-service", gina],
  ] as const;
  for (const [projectId, externalRepositoryId, fullName, by] of repositories) {
    await connectRepository(ctx, by.id, {
      projectId,
      provider: "github",
      externalRepositoryId,
      fullName,
    });
  }

  const readers: ReadonlyArray<readonly [string, Principal[]]> = [
    ["1001", [olivia, adam, pat, rhea, cody, rudy, agent, oscar]],
    ["1002", [olivia, adam, pat]],
    ["1003", [olivia, adam]],
    [
      UNCONNECTED_EXAMPLE_REPOSITORY.externalRepositoryId,
      [olivia, adam, pat, rhea, cody, rudy],
    ],
    ["2001", [gina, glen]],
  ];
  for (const [externalRepositoryId, principals] of readers) {
    for (const principal of principals) {
      await recordRepositoryAccess(ctx, {
        principalId: principal.id,
        provider: "github",
        externalRepositoryId,
        canRead: true,
      });
    }
  }

  const source = (
    by: Principal,
    projectId: string,
    externalRepositoryId: string,
    fullName: string,
    pull: number,
    revision: string,
    excerpt: string,
  ) =>
    recordSource(ctx, by.id, {
      projectId,
      provider: "github",
      externalRepositoryId,
      reference: `pull/${pull}`,
      url: `https://github.com/${fullName}/pull/${pull}`,
      revision,
      excerpt,
    });
  const retries = await source(
    cody,
    checkout.id,
    "1001",
    "acme-synthetic/checkout-service",
    11,
    "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "Synthetic PR discussion: card authorization now retries at most 3 times with exponential backoff. In the load test, unbounded retries filled the payment queue and slowed every checkout.",
  );
  const cache = await source(
    cody,
    checkout.id,
    "1001",
    "acme-synthetic/checkout-service",
    12,
    "b2c3d4e5f60718293a4b5c6d7e8f901234567890",
    "Synthetic PR discussion: we tried removing the session cache, but checkout latency doubled in staging, so the cache stays. Calls to the payment provider now time out after 10 seconds.",
  );
  const sdk = await source(
    olivia,
    payments.id,
    "1002",
    "acme-synthetic/payments-service",
    21,
    "c3d4e5f60718293a4b5c6d7e8f90123456789012",
    "Synthetic PR discussion: pin the card SDK to version 4.2 until the vendor fixes the rounding bug in 4.3.",
  );
  const nightlyExports = await source(
    gina,
    ledger.id,
    "2001",
    "globex-synthetic/ledger-service",
    31,
    "d4e5f60718293a4b5c6d7e8f9012345678901234",
    "Synthetic PR discussion: keep nightly ledger exports for 30 days so auditors can compare balances.",
  );

  const propose = (
    by: Principal,
    projectId: string,
    type: MemoryType,
    title: string,
    content: string,
    sourceId: string,
    ownerId?: string,
  ) =>
    proposeMemory(ctx, by.id, {
      projectId,
      type,
      title,
      content,
      evidenceSourceIds: [sourceId],
      ...(ownerId === undefined ? {} : { ownerId }),
    });
  const approved: ReadonlyArray<
    readonly [Principal, string, MemoryType, string, string, string, Principal]
  > = [
    [
      cody,
      checkout.id,
      "decision",
      "Retry card authorization at most 3 times",
      "Card authorization retries at most 3 times, with exponential backoff between attempts.",
      retries.id,
      rhea,
    ],
    [
      cody,
      checkout.id,
      "failed_approach",
      "Unbounded retries overloaded the payment queue",
      "Retrying card authorization without a limit filled the payment queue during the load test and slowed every checkout. Do not remove the retry limit.",
      retries.id,
      rhea,
    ],
    [
      olivia,
      payments.id,
      "constraint",
      "Payments pins the card SDK to version 4.2",
      "Keep the card SDK at version 4.2 until the vendor fixes the rounding bug in 4.3.",
      sdk.id,
      adam,
    ],
    [
      gina,
      ledger.id,
      "decision",
      "Ledger keeps nightly exports for 30 days",
      "Nightly ledger exports are kept for 30 days so auditors can compare balances.",
      nightlyExports.id,
      glen,
    ],
  ];
  const memoryIds = new Map<string, string>();
  for (const [
    by,
    projectId,
    type,
    title,
    content,
    sourceId,
    reviewer,
  ] of approved) {
    const proposal = await propose(
      by,
      projectId,
      type,
      title,
      content,
      sourceId,
    );
    const memory = await approveProposal(ctx, reviewer.id, {
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
    });
    memoryIds.set(title, memory.id);
  }
  await propose(
    cody,
    checkout.id,
    "decision",
    "Keep the session cache in checkout",
    "Keep the session cache: removing it doubled checkout latency in staging.",
    cache.id,
  );
  await propose(
    agent,
    checkout.id,
    "constraint",
    "Payment provider calls time out after 10 seconds",
    "Checkout stops waiting for the payment provider after 10 seconds.",
    cache.id,
    cody.id,
  );

  await loadExampleDefinitions(ctx, {
    people: { olivia, adam, pat, rhea, cody, gina, glen, agent },
    scopes: {
      acme: scope("organization", acme.id),
      platform: scope("business_unit", platform.id),
      checkout: scope("project", checkout.id),
      payments: scope("project", payments.id),
      helpdesk: scope("project", helpdesk.id),
      ledger: scope("project", ledger.id),
    },
    memory: (title) => {
      const id = memoryIds.get(title);
      if (id === undefined)
        throw new Error(`No example memory titled ${title}`);
      return id;
    },
  });

  return { people: 9, agents: 1, organizations: 2, projects: 4 };
}

interface ExampleWorld {
  people: Record<
    "olivia" | "adam" | "pat" | "rhea" | "cody" | "gina" | "glen" | "agent",
    Principal
  >;
  scopes: Record<
    "acme" | "platform" | "checkout" | "payments" | "helpdesk" | "ledger",
    ScopeRef
  >;
  memory: (title: string) => string;
}

/** Agents, skills, instructions, and rules for the example organizations, linked to their knowledge. */
async function loadExampleDefinitions(
  ctx: MemoryNetContext,
  world: ExampleWorld,
): Promise<void> {
  const { olivia, adam, pat, rhea, cody, gina, glen, agent } = world.people;
  const { acme, platform, checkout, payments, helpdesk, ledger } = world.scopes;
  const define = async (
    by: Principal,
    reviewer: Principal,
    input: Parameters<typeof proposeDefinition>[2],
  ): Promise<Definition> => {
    const proposal = await proposeDefinition(ctx, by.id, input);
    return approveDefinitionProposal(ctx, reviewer.id, {
      proposalId: proposal.id,
      expectedRevision: proposal.revision,
    });
  };
  const noSecrets = await define(olivia, adam, {
    scope: acme,
    kind: "rule",
    name: "Keep secrets out of code, pull requests, and AI chats",
    purpose:
      "Credentials must never leak through code, review text, or AI assistants.",
    responsibilities: [
      "Passwords, tokens, and keys never appear in code, pull request text, or AI chats",
      "Credentials live only in the team's secret store",
      "If a secret leaks, rotate it first, then report it",
    ],
    boundaries: ["Personal data, which has its own privacy rules"],
    appliesTo: "Every repository and AI tool used at Acme",
    instructions:
      "Before sharing code or text with an AI assistant, remove credentials.\nMemoryNet refuses text that looks like a secret; do not work around it.",
  });
  const recordDecisions = await define(olivia, adam, {
    scope: acme,
    kind: "instruction",
    name: "Record decisions as memories",
    purpose:
      "Decisions made in pull requests should outlive the people and tools that made them.",
    responsibilities: [
      "After a merged pull request changes behavior, propose a memory that cites it",
      "Name the person who will keep the memory correct",
      "Write what was chosen and why, not how the code works",
    ],
    boundaries: ["Code walkthroughs and routine refactors"],
    links: [{ relation: "follows", targetId: noSecrets.id }],
  });
  const summarize = await define(olivia, adam, {
    scope: acme,
    kind: "skill",
    name: "Summarize a merged pull request",
    purpose:
      "Turns a merged pull request into a memory proposal a reviewer can check quickly.",
    responsibilities: [
      "Read the pull request title, description, and discussion",
      "Draft a memory proposal with its type, title, and evidence",
      "Point out anything flagged as possible personal data",
    ],
    boundaries: ["Approving its own proposal", "Storing raw chat transcripts"],
    instructions:
      "1. Read the merged pull request and its review comments.\n2. Pick the memory type that fits: decision, rationale, constraint, lesson, failed approach, or incident.\n3. Cite the pull request as evidence and propose it for review.",
    links: [
      { relation: "follows", targetId: recordDecisions.id },
      { relation: "follows", targetId: noSecrets.id },
    ],
  });
  const librarian = await define(olivia, adam, {
    scope: acme,
    kind: "agent",
    name: "Knowledge librarian",
    purpose:
      "Keeps approved knowledge tidy so people and AI tools can trust it.",
    responsibilities: [
      "Find memories that repeat or contradict each other",
      "Propose fixes as normal proposals for a person to review",
      "Point owners to guidance that may be out of date",
    ],
    boundaries: [
      "Approving, editing, or deleting knowledge directly",
      "Reading projects its account has no role in",
    ],
    links: [
      { relation: "uses", targetId: summarize.id },
      { relation: "follows", targetId: noSecrets.id },
    ],
  });
  const boundedCalls = await define(pat, adam, {
    scope: platform,
    kind: "rule",
    name: "Payment calls are bounded",
    purpose:
      "A slow or failing payment provider must never take checkout down with it.",
    responsibilities: [
      "Every call to a payment provider has a timeout",
      "Retries have a fixed limit and back off between attempts",
      "A failed payment call never blocks the checkout page",
    ],
    boundaries: ["Batch jobs that run outside checkout"],
    appliesTo: "Every Platform service that calls a payment provider",
    links: [
      {
        relation: "based_on",
        targetId: world.memory("Retry card authorization at most 3 times"),
      },
      {
        relation: "based_on",
        targetId: world.memory(
          "Unbounded retries overloaded the payment queue",
        ),
      },
    ],
  });
  const retryForever = await define(cody, rhea, {
    scope: checkout,
    kind: "instruction",
    name: "Retry payment calls until they succeed",
    purpose: "Early checkout guidance for flaky payment providers.",
    responsibilities: ["Retry a failed card authorization until it succeeds"],
  });
  const retire = await proposeDefinitionRetirement(ctx, cody.id, {
    definitionId: retryForever.id,
    baseRevision: retryForever.revision,
    reason:
      "Unbounded retries overloaded the payment queue; replaced by the rule Payment calls are bounded",
  });
  await approveDefinitionProposal(ctx, rhea.id, {
    proposalId: retire.id,
    expectedRevision: retire.revision,
  });
  const checkChange = await define(cody, rhea, {
    scope: checkout,
    kind: "skill",
    name: "Check a change against team decisions",
    purpose:
      "Finds the approved decisions a pull request might break, with their IDs.",
    responsibilities: [
      "Find approved memories related to the files and topics in the change",
      "Quote each related memory with its ID and version",
      "Say clearly when nothing related was found",
    ],
    boundaries: ["Treating an empty result as proof that no decision exists"],
    links: [
      { relation: "follows", targetId: noSecrets.id },
      {
        relation: "based_on",
        targetId: world.memory("Retry card authorization at most 3 times"),
      },
    ],
  });
  await define(cody, rhea, {
    scope: checkout,
    kind: "agent",
    name: "Checkout review assistant",
    purpose:
      "Reviews checkout pull requests against approved decisions before a person approves them.",
    responsibilities: [
      "Check each pull request against checkout's approved memories",
      "Warn when a change removes the retry limit or the provider timeout",
      "Propose new memories from merged pull requests with the summary skill",
    ],
    boundaries: [
      "Approving pull requests or memories",
      "Seeing pending proposals",
      "Changing code",
    ],
    appliesTo: "Pull requests in acme-synthetic/checkout-service",
    instructions:
      "Start every review by running the skill Check a change against team decisions.\nQuote memory IDs and versions in your comments.\nWhen knowledge looks outdated, hand it to the Knowledge librarian instead of guessing.",
    runsAs: agent.id,
    ownerId: rhea.id,
    links: [
      { relation: "uses", targetId: checkChange.id },
      { relation: "uses", targetId: summarize.id },
      { relation: "follows", targetId: boundedCalls.id },
      { relation: "follows", targetId: noSecrets.id },
      { relation: "hands_off_to", targetId: librarian.id },
      {
        relation: "based_on",
        targetId: world.memory("Retry card authorization at most 3 times"),
      },
      {
        relation: "based_on",
        targetId: world.memory(
          "Unbounded retries overloaded the payment queue",
        ),
      },
    ],
  });
  await define(pat, adam, {
    scope: payments,
    kind: "agent",
    name: "Payments SDK guard",
    purpose:
      "Stops accidental upgrades of the card SDK while version 4.3 has a rounding bug.",
    responsibilities: [
      "Flag any change that moves the card SDK past version 4.2",
      "Link the pinned-version memory in its warning",
      "Tell the memory owner when the vendor ships a fix",
    ],
    boundaries: ["Upgrading or downgrading dependencies itself"],
    ownerId: adam.id,
    links: [
      { relation: "uses", targetId: summarize.id },
      { relation: "follows", targetId: boundedCalls.id },
      {
        relation: "based_on",
        targetId: world.memory("Payments pins the card SDK to version 4.2"),
      },
    ],
  });
  await define(adam, olivia, {
    scope: helpdesk,
    kind: "instruction",
    name: "Answer support questions from approved knowledge",
    purpose:
      "Support answers should rest on reviewed knowledge, not on memory or guesswork.",
    responsibilities: [
      "Link the memory ID in every answer that relies on it",
      "Say when no approved knowledge covers the question",
      "Send gaps to the owner of the closest memory",
    ],
    boundaries: ["Guessing an answer that no memory supports"],
    links: [{ relation: "follows", targetId: noSecrets.id }],
  });
  await define(gina, glen, {
    scope: ledger,
    kind: "rule",
    name: "Keep audit exports for 30 days",
    purpose: "Auditors must be able to compare balances for a month back.",
    responsibilities: ["Nightly ledger exports stay available for 30 days"],
    links: [
      {
        relation: "based_on",
        targetId: world.memory("Ledger keeps nightly exports for 30 days"),
      },
    ],
  });

  await proposeDefinitionChange(ctx, cody.id, {
    definitionId: checkChange.id,
    baseRevision: checkChange.revision,
    name: checkChange.name,
    purpose: checkChange.purpose,
    responsibilities: [
      ...checkChange.responsibilities,
      "Check the change against Platform rules too",
    ],
    boundaries: checkChange.boundaries,
    links: [
      ...checkChange.links,
      { relation: "follows", targetId: boundedCalls.id },
    ],
    changeNote: "Platform rules apply to checkout as well",
  });
  await proposeDefinition(ctx, agent.id, {
    scope: checkout,
    kind: "skill",
    name: "Draft release notes from merged pull requests",
    purpose: "Collects what changed for users since the last release.",
    responsibilities: [
      "List merged pull requests since the last release",
      "Group them by user impact",
    ],
    boundaries: ["Publishing the notes"],
    ownerId: cody.id,
    links: [{ relation: "follows", targetId: noSecrets.id }],
  });
}
