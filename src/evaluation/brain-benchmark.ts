import { createHash } from "node:crypto";
import {
  approveDefinitionProposal, approveProposal, assignRole, basedOnChanges, connectRepository, createBusinessUnit, createContext,
  createOrganization, createPrincipal, createProject, getDefinition, getMemoryHistory, listDefinitionProposals, listDefinitions,
  listMemories, listProposals, listRetrievals, listSources, MEMORY_STATUSES, migrate, openDatabase, proposeChange, proposeDefinition,
  proposeMemory, recordRepositoryAccess, recordSource, rejectProposal,
  type Database, type Memory, type MemoryType, type Principal, type Source,
} from "../index.ts";
import type { MemoryRelationsInput } from "../relations.ts";
import { getTaskContext, type TaskContextResponse } from "../task-context.ts";

/** Every arm gets the task-context defaults: about 2,000 tokens (JSON characters / 4) and at most 10 items. */
export const BRAIN_BENCHMARK_BUDGET = { maxTokens: 2000, maxItems: 10 } as const;
export const RAG_CHUNK_WORDS = 60;
export const BRAIN_BENCHMARK_STATEMENT = [
  "Synthetic behavior check of what each retrieval path delivers to the same agent, for the same tasks and token budget.",
  "No model calls. Not a measurement of agent correctness or effectiveness.",
] as const;
const BENCHMARK_AT = new Date("2026-11-05T15:00:00.000Z");
const HOUR = 60 * 60 * 1000;

export const BRAIN_BENCHMARK_ARMS = [
  { id: "memorynet-task-context", label: "MemoryNet task context", fairComparison: true,
    description: "getTaskContext as the agent, in the identity project's repository and branch: current approved guidance the agent may read, "
      + "with citations and reviewed conflicts, plus reviewed definitions whenever the response includes them." },
  { id: "permission-aware-rag", label: "Permission-aware conventional RAG", fairComparison: true,
    description: `IDF-weighted term overlap over every text the agent may read in the organization (pull request excerpts, every readable version of every memory including superseded ones, and readable definitions), in chunks of at most ${RAG_CHUNK_WORDS} words, top ${BRAIN_BENCHMARK_BUDGET.maxItems} within the same token budget. It has no notion of approval status, versions or supersession.` },
  { id: "ablation-unfiltered-rag", label: "Ablation: RAG without permission filtering", fairComparison: false,
    description: "The same RAG over every record in the organization, proposals included, read with the owner's account instead of the agent's permissions. "
      + "It sizes exposure risk and is never a fair competitor." },
] as const;
export type BrainBenchmarkArm = (typeof BRAIN_BENCHMARK_ARMS)[number]["id"];

export interface BrainBenchmarkTask {
  id: string;
  task: string;
  paths: string[];
  /** Current guidance a reviewer of this fixture expects for the task, as memory@revision. Fixed before any arm ran. */
  expected: string[];
}

export const BRAIN_BENCHMARK_TASKS: readonly BrainBenchmarkTask[] = [
  { id: "mobile-login", task: "Redesign authentication for the mobile login flow", paths: ["src/auth/mobile/login.ts"],
    expected: ["memory:server-sessions@2", "memory:browser-credential-storage@2"] },
  { id: "remember-me", task: "Keep mobile users signed in longer with a remember-me option",
    paths: ["src/auth/mobile/remember.ts", "src/auth/session/expiry.ts"],
    expected: ["memory:mobile-remember-me@1", "memory:session-idle-timeout@1"] },
  { id: "token-storage", task: "Store the access token in the web client after login", paths: ["web/src/auth/token-store.ts"],
    expected: ["memory:browser-credential-storage@2", "memory:server-sessions@2"] },
  { id: "revoke-session", task: "Let users revoke a stolen session from account settings", paths: ["src/auth/session/revoke.ts"],
    expected: ["memory:server-sessions@2", "memory:token-theft-incident@1"] },
];

type RecordKind = "memory" | "source" | "definition" | "proposal" | "definition-proposal";
/** current: the approved, current text. stale: superseded, no longer approved, or an older version. unapproved: a proposal or raw evidence. */
type Authority = "current" | "stale" | "unapproved";

export interface CorpusRecord {
  /** Stable across runs, for example memory:server-sessions@2 or source:identity-service#230. */
  key: string;
  kind: RecordKind;
  title: string;
  text: string;
  authority: Authority;
  /** A current definition whose based_on decision changed after it was approved. */
  outdated: boolean;
  /** From the fixture design, independent of the reads under test. */
  agentMayRead: boolean;
}

/**
 * The authentication scenario: a fresh in-memory organization built only through domain functions, on a controlled
 * clock. Synthetic records only: no real people, repositories, pull requests or model output.
 */
export async function createBrainBenchmarkFixture() {
  const db = await openDatabase();
  try {
    await migrate(db);
    let clock = new Date("2024-10-01T09:00:00.000Z");
    const at = (iso: string) => { clock = new Date(iso); };
    // The history spans two synthetic years, so setup trusts repository-access observations for that long.
    // The benchmark itself reads with the default window and access observed at the benchmark time.
    const setup = createContext(db, { now: () => new Date(clock), repositoryAccessMaxAgeMs: 3 * 365 * 24 * HOUR });
    const registry = new Map<string, { label: string; agentMayRead: boolean }>();
    const named = <T extends { id: string }>(label: string, record: T, agentMayRead = true): T => {
      registry.set(record.id, { label, agentMayRead });
      return record;
    };

    const person = (displayName: string) => createPrincipal(setup, { kind: "human", displayName });
    const owner = await person("Synthetic organization owner");
    const securityLead = await person("Synthetic security lead");
    const reviewer = await person("Synthetic identity reviewer");
    const engineer = await person("Synthetic identity engineer");
    const agent = await createPrincipal(setup, { kind: "agent", displayName: "Synthetic coding agent" });
    const org = await createOrganization(setup, owner.id, { slug: "synthetic-brain-benchmark", name: "Synthetic brain benchmark" });
    const platform = await createBusinessUnit(setup, owner.id, { organizationId: org.id, slug: "platform", name: "Platform" });
    const security = await createBusinessUnit(setup, owner.id, { organizationId: org.id, slug: "security", name: "Security" });
    const identity = await createProject(setup, owner.id, { businessUnitId: platform.id, slug: "identity", name: "Identity" });
    const payments = await createProject(setup, owner.id, { businessUnitId: platform.id, slug: "payments", name: "Payments" });
    const restricted = await createProject(setup, owner.id, { businessUnitId: security.id, slug: "incident-response", name: "Incident response" });
    const repos = {
      identity: { projectId: identity.id, id: "4101", fullName: "synthetic-brain/identity-service" },
      payments: { projectId: payments.id, id: "4102", fullName: "synthetic-brain/payments-service" },
      restricted: { projectId: restricted.id, id: "4103", fullName: "synthetic-brain/incident-response" },
    };
    type Repo = (typeof repos)[keyof typeof repos];
    for (const repo of Object.values(repos)) {
      await connectRepository(setup, owner.id, { projectId: repo.projectId, provider: "github", externalRepositoryId: repo.id, fullName: repo.fullName });
    }
    const grant = (principal: Principal, role: "reader" | "contributor" | "reviewer", scope: { level: "organization" | "project"; id: string }) =>
      assignRole(setup, owner.id, { principalId: principal.id, scope, role });
    await grant(securityLead, "reviewer", { level: "organization", id: org.id });
    await grant(reviewer, "reviewer", { level: "project", id: identity.id });
    await grant(engineer, "contributor", { level: "project", id: identity.id });
    await grant(agent, "contributor", { level: "project", id: identity.id });
    await grant(agent, "reader", { level: "project", id: payments.id });
    // The agent has no role in incident response and cannot read its repository.
    const readers: Array<[Principal, Repo[]]> = [
      [owner, [repos.identity, repos.payments, repos.restricted]], [securityLead, [repos.identity, repos.payments, repos.restricted]],
      [reviewer, [repos.identity]], [engineer, [repos.identity]], [agent, [repos.identity, repos.payments]],
    ];
    const observeAccess = async (ctx: typeof setup, who: readonly Principal[]) => {
      for (const [principal, readable] of readers) {
        if (!who.includes(principal)) continue;
        for (const repo of readable) {
          await recordRepositoryAccess(ctx, { principalId: principal.id, provider: "github", externalRepositoryId: repo.id, canRead: true });
        }
      }
    };
    await observeAccess(setup, [owner, securityLead, reviewer, engineer, agent]);

    const later = (iso: string) => new Date(Date.parse(iso) + 2 * HOUR).toISOString();
    const pull = async (when: string, by: Principal, repo: Repo, number: number, excerpt: string) => {
      at(when);
      const label = `${repo.fullName.split("/")[1]}#${number}`;
      return named(label, await recordSource(setup, by.id, { projectId: repo.projectId, provider: "github", externalRepositoryId: repo.id,
        reference: `pull/${number}`, url: `https://github.com/${repo.fullName}/pull/${number}`,
        revision: createHash("sha1").update(label).digest("hex"), excerpt }), repo !== repos.restricted);
    };
    interface Draft { type: MemoryType; title: string; content: string; evidence: Source[]; relations?: MemoryRelationsInput }
    const publish = async (label: string, when: string, author: Principal, approver: Principal, repo: Repo, draft: Draft) => {
      at(when);
      const proposal = await proposeMemory(setup, author.id, { projectId: repo.projectId, type: draft.type, title: draft.title,
        content: draft.content, evidenceSourceIds: draft.evidence.map((source) => source.id), relations: draft.relations,
        applicability: { repositoryId: repo.id, branch: "main", validFrom: "2024-10-01T00:00:00.000Z" } });
      at(later(when));
      return named(label, await approveProposal(setup, approver.id, { proposalId: proposal.id, expectedRevision: proposal.revision }), repo !== repos.restricted);
    };
    const change = async (label: string, when: string, author: Principal, approver: Principal, memory: Memory, kind: "revise" | "replace", draft: Draft) => {
      at(when);
      const proposal = await proposeChange(setup, author.id, { memoryId: memory.id, expectedRevision: memory.revision, kind, type: draft.type,
        title: draft.title, content: draft.content, evidenceSourceIds: draft.evidence.map((source) => source.id), relations: draft.relations });
      at(later(when));
      return named(label, await approveProposal(setup, approver.id, { proposalId: proposal.id, expectedRevision: proposal.revision }));
    };

    // Era 1: stateless JWT login, and a skill written for it.
    const hashingPr = await pull("2024-10-14T10:00:00.000Z", engineer, repos.identity, 95,
      "Store password hashes with Argon2id and a per-user salt. Raw passwords never reach the logs.");
    await publish("password-hashing", "2024-10-15T10:00:00.000Z", engineer, reviewer, repos.identity, { type: "decision",
      title: "Hash passwords with Argon2id", content: "Password hashes use Argon2id with a per-user salt. Raw passwords are never logged.",
      evidence: [hashingPr], relations: { paths: ["src/auth/password/**"] } });
    const jwtPr = await pull("2024-11-04T10:00:00.000Z", engineer, repos.identity, 112,
      "Adopt stateless JWT access tokens for web and mobile login. The identity service signs each token, tokens stay valid for 24 hours, "
      + "and clients keep them in localStorage so the mobile web view can reuse them.");
    const jwt = await publish("jwt-login", "2024-11-05T10:00:00.000Z", engineer, reviewer, repos.identity, { type: "decision",
      title: "Use JWT access tokens for login",
      content: "Web and mobile clients authenticate with stateless JWT access tokens signed by the identity service. "
        + "Tokens are valid for 24 hours and are kept in localStorage so the mobile web view can reuse them.",
      evidence: [jwtPr], relations: { paths: ["src/auth/**"] } });
    at("2025-01-14T10:00:00.000Z");
    const skill = await proposeDefinition(setup, engineer.id, { scope: { level: "project", id: identity.id }, kind: "skill",
      name: "Mobile login token flow", purpose: "Implement mobile login with JWT access tokens.",
      responsibilities: ["Issue a JWT access token when a mobile user logs in", "Keep the token in localStorage and send it as a bearer header"],
      boundaries: ["Not for service-to-service calls"],
      instructions: "When a mobile user logs in, issue a JWT access token valid for 24 hours. Keep it in localStorage and attach it to each request "
        + "as an Authorization bearer header. When it expires, ask the user to log in again.",
      appliesTo: "Mobile login in src/auth/mobile/", links: [{ relation: "based_on", targetId: jwt.id }] });
    at("2025-01-15T10:00:00.000Z");
    named("mobile-login-token-skill", await approveDefinitionProposal(setup, reviewer.id, { proposalId: skill.id, expectedRevision: skill.revision }));
    const rateLimitPr = await pull("2025-02-11T10:00:00.000Z", engineer, repos.identity, 120,
      "Rate-limit login attempts per account and per network address to slow credential stuffing.");
    await publish("login-rate-limit", "2025-02-12T10:00:00.000Z", engineer, reviewer, repos.identity, { type: "decision",
      title: "Rate-limit login attempts", content: "Allow at most 10 login attempts per account and 50 per network address in any 15-minute window.",
      evidence: [rateLimitPr], relations: { paths: ["src/auth/login/**"] } });
    const checkoutPr = await pull("2025-03-03T10:00:00.000Z", owner, repos.payments, 45,
      "Checkout asks for a fresh login before a new payment method is saved.");
    await publish("checkout-reauthentication", "2025-03-04T10:00:00.000Z", owner, securityLead, repos.payments, { type: "decision",
      title: "Re-authenticate before saving a payment method",
      content: "Checkout requires a login within the last 10 minutes before a new payment method is saved.",
      evidence: [checkoutPr], relations: { paths: ["src/checkout/**"] } });
    const storagePr = await pull("2025-06-10T10:00:00.000Z", securityLead, repos.identity, 150,
      "Security review follow-up: stop writing access tokens to localStorage and keep them in memory for now.");
    const storage = await publish("browser-credential-storage", "2025-06-11T10:00:00.000Z", securityLead, reviewer, repos.identity, {
      type: "constraint", title: "No access tokens in localStorage", content: "Access tokens must not be written to localStorage.",
      evidence: [storagePr], relations: { paths: ["web/src/**"] } });

    // Era 2: the incident, its restricted forensic record, and the replacement decision.
    const incidentPr = await pull("2026-05-04T10:00:00.000Z", engineer, repos.identity, 203,
      "Postmortem: a script injected through the help widget read JWT access tokens from localStorage and replayed them for up to 24 hours. "
      + "The tokens could not be revoked before they expired.");
    const incident = await publish("token-theft-incident", "2026-05-05T10:00:00.000Z", engineer, reviewer, repos.identity, { type: "incident",
      title: "Token theft from browser storage",
      content: "In May 2026 a script injected through the help widget read JWT access tokens from localStorage and replayed them. "
        + "Stateless tokens could not be revoked, so affected accounts stayed exposed for up to 24 hours.",
      evidence: [incidentPr] });
    const forensicsPr = await pull("2026-05-06T10:00:00.000Z", owner, repos.restricted, 9,
      "Restricted forensic timeline for the mobile login token theft: replayed sessions, affected accounts and the open investigation.");
    await publish("token-theft-forensics", "2026-05-07T10:00:00.000Z", owner, securityLead, repos.restricted, { type: "incident",
      title: "Mobile login token theft: forensic notes",
      content: "Restricted to the security response team. Attackers replayed stolen JWT access tokens against synthetic accounts before "
        + "their sessions could be revoked. These notes hold the affected accounts, attacker infrastructure and the open legal hold. "
        + "Not for distribution outside incident response.",
      evidence: [forensicsPr] });
    const sessionsPr = await pull("2026-05-19T10:00:00.000Z", engineer, repos.identity, 230,
      "Replace JWT bearer tokens with server-side sessions. The session identifier lives in an HttpOnly, Secure, SameSite cookie "
      + "and can be revoked on the server.");
    const sessionsV1 = await change("server-sessions", "2026-05-20T10:00:00.000Z", engineer, reviewer, jwt, "replace", { type: "decision",
      title: "Use server-side sessions with HttpOnly cookies",
      content: "Web clients authenticate with server-side sessions. The session identifier is kept in an HttpOnly, Secure, SameSite cookie "
        + "and can be revoked on the server. JWT access tokens are no longer issued to browsers.",
      evidence: [sessionsPr], relations: { paths: ["src/auth/**", "web/src/auth/**"], links: [{ relation: "related", memoryId: incident.id }] } });
    const directivePr = await pull("2026-05-30T10:00:00.000Z", owner, repos.identity, 240,
      "Leadership directive: no authentication credential may be stored where page scripts can read it, including localStorage, "
      + "sessionStorage, IndexedDB and cookies without HttpOnly.");
    const storageV2 = await change("browser-credential-storage", "2026-06-01T10:00:00.000Z", owner, securityLead, storage, "revise", {
      type: "constraint", title: "No authentication credentials in browser-accessible storage",
      content: "No authentication credential (access token, refresh token or session identifier) may be stored where page scripts can read it: "
        + "localStorage, sessionStorage, IndexedDB or cookies without HttpOnly. This applies to web clients and mobile web views.",
      evidence: [directivePr], relations: { paths: ["src/auth/**", "web/src/**"] } });

    // Era 3: a reviewed conflict, the security instruction, the mobile revision, and what agents and engineers proposed since.
    const idlePr = await pull("2026-06-30T10:00:00.000Z", engineer, repos.identity, 251,
      "Expire sessions after 30 minutes without activity, per the security baseline.");
    const idle = await publish("session-idle-timeout", "2026-07-01T10:00:00.000Z", engineer, reviewer, repos.identity, { type: "decision",
      title: "Sessions expire after 30 minutes idle", content: "Server-side sessions expire after 30 minutes without activity.",
      evidence: [idlePr], relations: { paths: ["src/auth/session/**"] } });
    const rememberPr = await pull("2026-07-14T10:00:00.000Z", engineer, repos.identity, 262,
      "Product request: let mobile users opt in to stay signed in for 30 days.");
    await publish("mobile-remember-me", "2026-07-15T10:00:00.000Z", engineer, reviewer, repos.identity, { type: "decision",
      title: "Mobile users can stay signed in for 30 days", content: "Mobile users may opt in to stay signed in for 30 days on a trusted device.",
      evidence: [rememberPr], relations: { paths: ["src/auth/mobile/**"], links: [{ relation: "conflicts_with", memoryId: idle.id }] } });
    at("2026-08-03T10:00:00.000Z");
    const instruction = await proposeDefinition(setup, securityLead.id, { scope: { level: "organization", id: org.id }, kind: "instruction",
      name: "Authentication changes follow current security decisions",
      purpose: "Keep login, session and token changes aligned with the approved security decisions.",
      responsibilities: ["Read the current approved identity decisions and constraints before changing authentication",
        "Keep every authentication credential out of storage that page scripts can read", "Ask for a security review of changes under src/auth/"],
      boundaries: ["Does not replace the security review"],
      instructions: "Before changing login, sessions or token handling, read the current approved identity decisions and constraints. "
        + "Never place an authentication credential where page scripts can read it. Ask the security reviewers to review any change under src/auth/ before it merges.",
      appliesTo: "Authentication changes in every project", links: [{ relation: "based_on", targetId: storageV2.id }] });
    at("2026-08-04T10:00:00.000Z");
    named("auth-security-instruction", await approveDefinitionProposal(setup, owner.id, { proposalId: instruction.id, expectedRevision: instruction.revision }));
    const mobilePr = await pull("2026-09-09T10:00:00.000Z", engineer, repos.identity, 288,
      "Mobile login now runs in the system browser session and keeps the HttpOnly session cookie; the app never receives or stores bearer tokens.");
    const sessions = await change("server-sessions", "2026-09-10T10:00:00.000Z", engineer, reviewer, sessionsV1, "revise", { type: "decision",
      title: "Use server-side sessions with HttpOnly cookies",
      content: "Web and mobile clients authenticate with server-side sessions. The session identifier is kept in an HttpOnly, Secure, SameSite cookie "
        + "and can be revoked on the server. Mobile login runs in the system browser session, so the app never receives or stores bearer tokens. "
        + "JWT access tokens are not issued to clients.",
      evidence: [sessionsPr, mobilePr] });
    const attempts = [
      { label: "agent-jwt-attempt-1", when: "2026-09-21T10:00:00.000Z", number: 341, rejectedBy: reviewer,
        excerpt: "Mobile login: switch back to JWT access tokens stored on the device so the app can authenticate offline.",
        title: "Use JWT access tokens for mobile login",
        content: "Mobile clients authenticate with JWT access tokens stored on the device so the app works offline. "
          + "The server checks the token signature instead of looking up a session.",
        reason: "Conflicts with the current server-side session decision and the credential storage constraint." },
      { label: "agent-jwt-attempt-2", when: "2026-10-12T10:00:00.000Z", number: 356, rejectedBy: securityLead,
        excerpt: "Reintroduce JWT bearer tokens for the mobile login flow to avoid a session lookup on every request.",
        title: "Reintroduce JWT bearer tokens for mobile login",
        content: "Issue JWT bearer tokens at mobile login and keep them in app storage to avoid a session lookup on every request.",
        reason: "Rejected again: sessions stay server-side and credentials stay out of client-readable storage." },
    ];
    for (const attempt of attempts) {
      const evidence = await pull(attempt.when, agent, repos.identity, attempt.number, attempt.excerpt);
      const proposal = named(attempt.label, await proposeChange(setup, agent.id, { memoryId: sessions.id, expectedRevision: sessions.revision,
        kind: "replace", type: "decision", title: attempt.title, content: attempt.content, evidenceSourceIds: [evidence.id] }), false);
      at(later(attempt.when));
      await rejectProposal(setup, attempt.rejectedBy.id, { proposalId: proposal.id, expectedRevision: proposal.revision, reason: attempt.reason });
    }
    const keychainPr = await pull("2026-10-28T10:00:00.000Z", engineer, repos.identity, 370,
      "Draft: keep a refresh token in the device keychain so repeat mobile logins are faster.");
    at("2026-10-29T10:00:00.000Z");
    named("keychain-refresh-token", await proposeMemory(setup, engineer.id, { projectId: identity.id, type: "decision",
      title: "Mobile app keeps a refresh token in the keychain",
      content: "Let the mobile app keep a refresh token in the device keychain so repeat logins are faster; access tokens stay in memory.",
      evidenceSourceIds: [keychainPr.id], relations: { paths: ["src/auth/mobile/**"] },
      applicability: { repositoryId: repos.identity.id, branch: "main", validFrom: "2024-10-01T00:00:00.000Z" } }), false);

    at(BENCHMARK_AT.toISOString());
    const ctx = createContext(db, { now: () => new Date(BENCHMARK_AT) });
    await observeAccess(ctx, [owner, agent]);
    const label = (id: string): string => {
      const entry = registry.get(id);
      if (!entry) throw new Error("A delivered record is missing from the fixture registry");
      return entry.label;
    };
    return { db, ctx, org, identity, repos, owner, agent, registry, label, close: () => db.close() };
  } catch (error) {
    await db.close();
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof createBrainBenchmarkFixture>>;

/** Everything one principal may read in the organization, through the permission-checked domain reads. */
async function readCorpus(f: Fixture, readerId: string): Promise<CorpusRecord[]> {
  const scope = { level: "organization", id: f.org.id } as const;
  const records: CorpusRecord[] = [];
  const add = (kind: RecordKind, id: string, suffix: string, record: Pick<CorpusRecord, "title" | "text" | "authority"> & { outdated?: boolean }) => {
    const entry = f.registry.get(id);
    if (!entry) throw new Error(`A readable ${kind} is missing from the fixture registry`);
    records.push({ key: `${kind}:${entry.label}${suffix}`, kind, outdated: false, ...record, agentMayRead: entry.agentMayRead });
  };
  for (const source of await listSources(f.ctx, readerId, { scope, limit: 200 })) {
    add("source", source.id, "", { title: source.reference, text: source.excerpt, authority: "unapproved" });
  }
  for (const status of MEMORY_STATUSES) {
    for (const memory of await listMemories(f.ctx, readerId, { scope, status, limit: 200 })) {
      for (const version of (await getMemoryHistory(f.ctx, readerId, memory.id)).versions) {
        if (!version.readable || version.title === null || version.content === null) continue;
        const current = memory.status === "approved" && version.revision === memory.revision;
        add("memory", memory.id, `@${version.revision}`, { title: version.title, text: version.content, authority: current ? "current" : "stale" });
      }
    }
  }
  for (const definition of await listDefinitions(f.ctx, readerId, { organizationId: f.org.id })) {
    const view = await getDefinition(f.ctx, readerId, definition.id);
    const changed = basedOnChanges(view.definition, new Map(view.linkedMemories.map((memory) => [memory.id, memory]))).length > 0;
    for (const version of view.history) {
      const current = version.status === "active" && version.revision === view.definition.revision;
      add("definition", definition.id, `@${version.revision}`, { title: version.name, text: definitionText(version),
        authority: current ? "current" : "stale", outdated: current && changed });
    }
  }
  for (const status of ["pending", "rejected"] as const) {
    for (const proposal of await listProposals(f.ctx, readerId, { scope, status, limit: 200 })) {
      add("proposal", proposal.id, "", { title: proposal.title, text: proposal.content, authority: "unapproved" });
    }
    for (const proposal of await listDefinitionProposals(f.ctx, readerId, { organizationId: f.org.id, status })) {
      add("definition-proposal", proposal.id, "", { title: proposal.name, text: definitionText(proposal), authority: "unapproved" });
    }
  }
  return records.sort((a, b) => byKey(a.key, b.key));
}

/** Code-point order, so ties break the same way under every locale. */
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function definitionText(value: { purpose: string; responsibilities: string[]; boundaries: string[]; instructions: string; appliesTo: string | null }): string {
  return [value.purpose, ...value.responsibilities, ...value.boundaries, value.instructions, value.appliesTo ?? ""].filter(Boolean).join("\n");
}

export const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

export interface IndexedChunk {
  record: CorpusRecord;
  index: number;
  title: string;
  text: string;
  terms: ReadonlySet<string>;
}

/** PostgreSQL's English stemming and stop words, the same text search configuration task context uses. */
async function lexemes(db: Database, texts: readonly string[]): Promise<string[][]> {
  if (texts.length === 0) return [];
  const { rows } = await db.query<{ terms: string[] }>(
    `SELECT tsvector_to_array(to_tsvector('english', input.text)) AS terms
     FROM unnest($1::text[]) WITH ORDINALITY AS input(text, position) ORDER BY input.position`,
    [texts.map((text) => text.replace(/[^\p{L}\p{N}]+/gu, " "))],
  );
  return rows.map((row) => row.terms);
}

async function buildIndex(db: Database, records: readonly CorpusRecord[]): Promise<IndexedChunk[]> {
  const chunks = records.flatMap((record) => {
    const words = record.text.split(/\s+/).filter(Boolean);
    const parts: string[] = [];
    for (let start = 0; start < words.length; start += RAG_CHUNK_WORDS) parts.push(words.slice(start, start + RAG_CHUNK_WORDS).join(" "));
    return parts.map((text, index) => ({ record, index, title: record.title, text }));
  });
  const terms = await lexemes(db, chunks.map((chunk) => `${chunk.title}\n${chunk.text}`));
  return chunks.map((chunk, i) => ({ ...chunk, terms: new Set(terms[i] ?? []) }));
}

/**
 * Conventional lexical retrieval: each chunk scores the IDF-weighted overlap of distinct query terms, ties break by a
 * stable record key, and the best chunks are packed into the same item limit and token budget as task context.
 */
export function rankByTermOverlap(
  chunks: readonly IndexedChunk[],
  query: readonly string[],
  budget: { maxTokens: number; maxItems: number } = BRAIN_BENCHMARK_BUDGET,
): Array<IndexedChunk & { score: number }> {
  const frequency = new Map<string, number>();
  for (const chunk of chunks) for (const term of chunk.terms) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const terms = [...new Set(query)];
  const ranked = chunks.map((chunk) => {
    const score = terms.reduce((sum, term) => chunk.terms.has(term) ? sum + Math.log(1 + chunks.length / frequency.get(term)!) : sum, 0);
    return { ...chunk, score: Math.round(score * 1e6) / 1e6 };
  }).filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || byKey(a.record.key, b.record.key) || a.index - b.index);
  const delivered: Array<IndexedChunk & { score: number }> = [];
  for (const chunk of ranked) {
    if (delivered.length >= budget.maxItems) break;
    if (estimateTokens(ragPayload([...delivered, chunk])) > budget.maxTokens) continue;
    delivered.push(chunk);
  }
  return delivered;
}

/** What a conventional RAG hands the agent: titled text, without status, version or permission metadata. */
export const ragPayload = (chunks: ReadonlyArray<{ title: string; text: string }>) => ({ chunks: chunks.map(({ title, text }) => ({ title, text })) });

export interface TaskMetrics {
  /** Expected current guidance delivered at its current version. */
  currentDelivered: number;
  currentExpected: number;
  /** Superseded or older-version text, delivered as context. */
  staleDelivered: number;
  /** Pending or rejected proposal text, or raw pull request evidence delivered as context rather than as a citation. */
  unapprovedDelivered: number;
  unapprovedProposals: number;
  unapprovedRawEvidence: number;
  /** Reviewed conflicts the response reports explicitly. A ranked list of chunks has no way to report one. */
  conflictsSurfaced: number;
  /** Delivered text, including citations, that the agent's own permissions do not allow it to read. */
  unauthorizedDelivered: number;
  /** Current definitions whose based_on decision changed after approval. */
  outdatedSkillsDelivered: number;
  /** Of those, how many the response marked for review; null when the arm does not serve definitions. */
  outdatedSkillsFlagged: number | null;
  /** JSON characters of everything the arm returns, divided by four. */
  estimatedTokens: number;
  deliveredRecords: number;
}

export interface DeliveredRecord {
  record: string;
  title: string;
  authority: Authority;
  agentMayRead: boolean;
  outdated: boolean;
  /** Task context only: delivered as a short preview. */
  compact?: boolean;
  /** Task context definitions only: marked reviewNeeded. */
  reviewNeeded?: boolean;
  /** RAG only: chunks of this record delivered. */
  chunks?: number;
}

/** Pure scoring of one arm's delivery for one task against the fixture's ground truth. */
export function measureDelivery(input: {
  task: BrainBenchmarkTask;
  delivered: readonly DeliveredRecord[];
  /** Other delivered text checked for permission only, such as citations of an approved item. */
  citations: readonly string[];
  truth: ReadonlyMap<string, CorpusRecord>;
  conflictsSurfaced: number;
  outdatedSkillsFlagged: number | null;
  estimatedTokens: number;
}): TaskMetrics {
  const keys = new Set(input.delivered.map((item) => item.record));
  const unauthorized = new Set([...keys, ...input.citations].filter((key) => !lookup(input.truth, key).agentMayRead));
  const unapproved = input.delivered.filter((item) => item.authority === "unapproved");
  return {
    currentDelivered: input.task.expected.filter((key) => keys.has(key)).length,
    currentExpected: input.task.expected.length,
    staleDelivered: input.delivered.filter((item) => item.authority === "stale").length,
    unapprovedDelivered: unapproved.length,
    unapprovedProposals: unapproved.filter((item) => lookup(input.truth, item.record).kind !== "source").length,
    unapprovedRawEvidence: unapproved.filter((item) => lookup(input.truth, item.record).kind === "source").length,
    conflictsSurfaced: input.conflictsSurfaced,
    unauthorizedDelivered: unauthorized.size,
    outdatedSkillsDelivered: input.delivered.filter((item) => item.outdated).length,
    outdatedSkillsFlagged: input.outdatedSkillsFlagged,
    estimatedTokens: input.estimatedTokens,
    deliveredRecords: keys.size,
  };
}

function lookup(truth: ReadonlyMap<string, CorpusRecord>, key: string): CorpusRecord {
  const record = truth.get(key);
  if (!record) throw new Error(`Delivered record ${key} is not part of the fixture`);
  return record;
}

function describe(truth: ReadonlyMap<string, CorpusRecord>, key: string, extra: Partial<DeliveredRecord> = {}): DeliveredRecord {
  const record = lookup(truth, key);
  return { record: key, title: record.title, authority: record.authority, agentMayRead: record.agentMayRead, outdated: record.outdated, ...extra };
}

/** Definitions, when a task-context response carries them (schema v3). Read at runtime so this file builds without them. */
function servedDefinitions(response: TaskContextResponse): Array<{ definitionId: string; revision: number; reviewNeeded: boolean }> | null {
  const value: unknown = (response as unknown as { definitions?: unknown }).definitions;
  if (!Array.isArray(value)) return null;
  return value.map((item: unknown) => {
    const definition = item as { definitionId?: unknown; revision?: unknown; reviewNeeded?: unknown };
    if (typeof definition.definitionId !== "string" || typeof definition.revision !== "number" || typeof definition.reviewNeeded !== "boolean") {
      throw new Error("Task context returned a definition without definitionId, revision and reviewNeeded");
    }
    return { definitionId: definition.definitionId, revision: definition.revision, reviewNeeded: definition.reviewNeeded };
  });
}

export interface BrainBenchmarkResult {
  taskId: string;
  arm: BrainBenchmarkArm;
  metrics: TaskMetrics;
  delivered: DeliveredRecord[];
  missing: string[];
  /** Task context only: reviewed conflict pairs it reported. */
  conflicts?: Array<{ memory: string; conflictsWith: string; bothDelivered: boolean }>;
  /** Task context only: the retrieval receipt lists exactly the delivered memory and definition versions. */
  receipted?: boolean;
  /** Task context only: its own budget accounting, which leaves out notices. */
  budgetUsedTokens?: number;
}

async function runMemoryNetArm(f: Fixture, task: BrainBenchmarkTask, truth: ReadonlyMap<string, CorpusRecord>) {
  const response = await getTaskContext(f.ctx, f.agent.id, { projectId: f.identity.id, task: task.task, paths: task.paths,
    maxTokens: BRAIN_BENCHMARK_BUDGET.maxTokens, maxItems: BRAIN_BENCHMARK_BUDGET.maxItems,
    applicability: { repositoryId: f.repos.identity.id, branch: "main" } });
  const definitions = servedDefinitions(response);
  const delivered = [
    ...response.items.map((item) => describe(truth, `memory:${f.label(item.memoryId)}@${item.revision}`, item.compact ? { compact: true } : {})),
    ...(definitions ?? []).map((item) => describe(truth, `definition:${f.label(item.definitionId)}@${item.revision}`, { reviewNeeded: item.reviewNeeded })),
  ];
  const receipt = (await listRetrievals(f.ctx, f.agent.id, { projectId: f.identity.id })).find((record) => record.id === response.retrievalId);
  const versions = (list: unknown) => JSON.stringify(Array.isArray(list)
    ? list.map((item: { memoryId?: string; definitionId?: string; revision?: number }) => [item.memoryId ?? item.definitionId, item.revision])
    : null);
  const receipted = receipt !== undefined && versions(receipt.items) === versions(response.items)
    && (definitions === null || versions((receipt as unknown as { definitions?: unknown }).definitions) === versions(definitions));
  const result: BrainBenchmarkResult = {
    taskId: task.id, arm: "memorynet-task-context",
    metrics: measureDelivery({ task, delivered, truth,
      citations: response.items.flatMap((item) => item.citations.map((citation) => `source:${f.label(citation.sourceId)}`)),
      conflictsSurfaced: response.conflicts.length + response.moreConflicts,
      outdatedSkillsFlagged: definitions === null ? null : delivered.filter((item) => item.outdated && item.reviewNeeded === true).length,
      estimatedTokens: estimateTokens(response) }),
    delivered, missing: task.expected.filter((key) => !delivered.some((item) => item.record === key)),
    conflicts: response.conflicts.map((conflict) => ({ memory: `memory:${f.label(conflict.memoryId)}`,
      conflictsWith: `memory:${f.label(conflict.conflictsWith)}`, bothDelivered: conflict.bothDelivered })),
    receipted,
    budgetUsedTokens: response.budget.usedTokens,
  };
  return { result, definitionsServed: definitions !== null };
}

function runRagArm(arm: BrainBenchmarkArm, index: readonly IndexedChunk[], query: readonly string[], task: BrainBenchmarkTask,
  truth: ReadonlyMap<string, CorpusRecord>, budget: { maxTokens: number; maxItems: number } = BRAIN_BENCHMARK_BUDGET): BrainBenchmarkResult {
  const chunks = rankByTermOverlap(index, query, budget);
  const counts = new Map<string, number>();
  for (const chunk of chunks) counts.set(chunk.record.key, (counts.get(chunk.record.key) ?? 0) + 1);
  const delivered = [...counts].map(([key, count]) => describe(truth, key, { chunks: count }));
  return {
    taskId: task.id, arm,
    metrics: measureDelivery({ task, delivered, citations: [], truth, conflictsSurfaced: 0,
      outdatedSkillsFlagged: 0, estimatedTokens: estimateTokens(ragPayload(chunks)) }),
    delivered, missing: task.expected.filter((key) => !counts.has(key)),
  };
}

function total(results: readonly BrainBenchmarkResult[]): TaskMetrics {
  const sum = (pick: (metrics: TaskMetrics) => number) => results.reduce((value, result) => value + pick(result.metrics), 0);
  const flagged = results.map((result) => result.metrics.outdatedSkillsFlagged);
  return {
    currentDelivered: sum((m) => m.currentDelivered), currentExpected: sum((m) => m.currentExpected),
    staleDelivered: sum((m) => m.staleDelivered), unapprovedDelivered: sum((m) => m.unapprovedDelivered),
    unapprovedProposals: sum((m) => m.unapprovedProposals), unapprovedRawEvidence: sum((m) => m.unapprovedRawEvidence),
    conflictsSurfaced: sum((m) => m.conflictsSurfaced), unauthorizedDelivered: sum((m) => m.unauthorizedDelivered),
    outdatedSkillsDelivered: sum((m) => m.outdatedSkillsDelivered),
    outdatedSkillsFlagged: flagged.every((value) => value === null) ? null : flagged.reduce<number>((value, item) => value + (item ?? 0), 0),
    estimatedTokens: sum((m) => m.estimatedTokens), deliveredRecords: sum((m) => m.deliveredRecords),
  };
}

export const BRAIN_BENCHMARK_LIMITS = [
  "One synthetic scenario with a small corpus, constructed to contain the superseded, unapproved, conflicting and restricted records this check looks for. "
    + "It shows what each path delivers here, not how often such records occur in real organizations.",
  "No model or agent runs. It does not show whether an agent would follow, ignore or be misled by any delivered text, or write better code.",
  "The baseline is lexical (IDF-weighted term overlap with PostgreSQL English stemming). Embeddings, rerankers, recency boosts or an index "
    + "limited to current approved records would deliver different text; the last would avoid stale and unapproved text by construction.",
  "The fixture author fixed the expected current guidance per task before any arm ran; recall is measured against that list only.",
  "Task context is scoped to the agent's project, repository and branch; the RAG arms search every project the reader may read.",
  "Token counts are estimates (JSON characters / 4), not tokenizer counts. Task context applies its budget to the guidance it delivers "
    + "plus a fixed envelope allowance; its conflict and change notices fall outside that budget.",
];

/** Builds the fixture, runs every arm on every task, and scores the deliveries. Deterministic; no network or model calls. */
export async function runBrainBenchmark() {
  const f = await createBrainBenchmarkFixture();
  try {
    const permitted = await readCorpus(f, f.agent.id);
    const everything = await readCorpus(f, f.owner.id);
    const truth = new Map(everything.map((record) => [record.key, record]));
    // The benchmark is only meaningful if the reads behave as designed: the agent sees all it may read and nothing else,
    // and the owner's ablation corpus covers every record the fixture created.
    const leaked = permitted.filter((record) => !record.agentMayRead).map((record) => record.key);
    if (leaked.length > 0) throw new Error(`The agent's reads include restricted records: ${leaked.join(", ")}`);
    const permittedKeys = new Set(permitted.map((record) => record.key));
    const hidden = everything.filter((record) => record.agentMayRead && !permittedKeys.has(record.key)).map((record) => record.key);
    if (hidden.length > 0) throw new Error(`The agent's reads miss records it may read: ${hidden.join(", ")}`);
    const covered = new Set(everything.map((record) => record.key.slice(record.key.indexOf(":") + 1).split("@")[0]));
    const uncovered = [...f.registry.values()].filter((entry) => !covered.has(entry.label)).map((entry) => entry.label);
    if (uncovered.length > 0) throw new Error(`The ablation corpus misses fixture records: ${uncovered.join(", ")}`);

    const indexes = { "permission-aware-rag": await buildIndex(f.db, permitted), "ablation-unfiltered-rag": await buildIndex(f.db, everything) };
    const queries = await lexemes(f.db, BRAIN_BENCHMARK_TASKS.map((task) => [task.task, ...task.paths].join(" ")));
    const results: BrainBenchmarkResult[] = [];
    const filled: BrainBenchmarkResult[] = [];
    let definitionsServed = false;
    for (const [position, task] of BRAIN_BENCHMARK_TASKS.entries()) {
      const memorynet = await runMemoryNetArm(f, task, truth);
      definitionsServed ||= memorynet.definitionsServed;
      results.push(memorynet.result);
      for (const arm of ["permission-aware-rag", "ablation-unfiltered-rag"] as const) {
        results.push(runRagArm(arm, indexes[arm], queries[position] ?? [], task, truth));
        filled.push(runRagArm(arm, indexes[arm], queries[position] ?? [], task, truth,
          { maxTokens: BRAIN_BENCHMARK_BUDGET.maxTokens, maxItems: Number.POSITIVE_INFINITY }));
      }
    }
    return {
      schemaVersion: 1 as const,
      benchmark: "brain-benchmark-authentication-v1" as const,
      evidenceKind: "synthetic_retrieval_behavior_check" as const,
      statement: BRAIN_BENCHMARK_STATEMENT.join(" "),
      modelCalls: 0 as const,
      agentEffectivenessMeasured: false as const,
      scenarioClock: BENCHMARK_AT.toISOString(),
      caller: "One agent principal: contributor in identity, reader in payments, no role in incident response.",
      budget: { ...BRAIN_BENCHMARK_BUDGET, tokenEstimate: "JSON characters / 4" },
      lexicalAnalysis: "PostgreSQL to_tsvector('english') lexemes for chunks and for the task text plus path segments",
      definitionsServed,
      arms: BRAIN_BENCHMARK_ARMS,
      corpus: {
        permissionAware: { records: permitted.length, chunks: indexes["permission-aware-rag"].length,
          estimatedTokens: estimateTokens(ragPayload(indexes["permission-aware-rag"])) },
        unfiltered: { records: everything.length, chunks: indexes["ablation-unfiltered-rag"].length,
          estimatedTokens: estimateTokens(ragPayload(indexes["ablation-unfiltered-rag"])) },
      },
      tasks: BRAIN_BENCHMARK_TASKS,
      results,
      totals: Object.fromEntries(BRAIN_BENCHMARK_ARMS.map((arm) => [arm.id, total(results.filter((result) => result.arm === arm.id))])) as Record<BrainBenchmarkArm, TaskMetrics>,
      sensitivity: {
        description: `Not an arm. The RAG arms again, filling the whole token budget instead of stopping at ${BRAIN_BENCHMARK_BUDGET.maxItems} chunks, `
          + "to show how the item limit shapes their numbers.",
        totals: {
          "permission-aware-rag": total(filled.filter((result) => result.arm === "permission-aware-rag")),
          "ablation-unfiltered-rag": total(filled.filter((result) => result.arm === "ablation-unfiltered-rag")),
        },
      },
      limits: BRAIN_BENCHMARK_LIMITS,
    };
  } finally {
    await f.close();
  }
}

export type BrainBenchmarkReport = Awaited<ReturnType<typeof runBrainBenchmark>>;

const number = new Intl.NumberFormat("en-US");

function metricCells(metrics: TaskMetrics): string[] {
  const outdated = metrics.outdatedSkillsFlagged === null
    ? `not served / ${metrics.outdatedSkillsDelivered}`
    : `${metrics.outdatedSkillsFlagged} / ${metrics.outdatedSkillsDelivered}`;
  return [
    `${metrics.currentDelivered}/${metrics.currentExpected}`, String(metrics.staleDelivered),
    `${metrics.unapprovedDelivered} (${metrics.unapprovedProposals} ${metrics.unapprovedProposals === 1 ? "proposal" : "proposals"}, ${metrics.unapprovedRawEvidence} raw evidence)`,
    String(metrics.conflictsSurfaced), String(metrics.unauthorizedDelivered), outdated, number.format(metrics.estimatedTokens),
  ];
}

/** A short human summary. Its first lines state what the run is and is not. */
export function renderBrainBenchmarkMarkdown(report: BrainBenchmarkReport): string {
  const header = (tokens: string) =>
    `| Current guidance delivered | Stale | Unapproved | Conflicts surfaced | Unauthorized | Outdated skills flagged / delivered | ${tokens} |`;
  const rule = "| --- | ---: | --- | ---: | ---: | --- | ---: |";
  const label = (arm: BrainBenchmarkArm) => {
    const found = report.arms.find((item) => item.id === arm)!;
    return found.fairComparison ? found.label : `${found.label} (not a fair competitor)`;
  };
  const filled = report.sensitivity.totals["permission-aware-rag"];
  const larger = BRAIN_BENCHMARK_ARMS.every((arm) => report.totals["memorynet-task-context"].estimatedTokens >= report.totals[arm.id].estimatedTokens);
  const lines = [
    ...BRAIN_BENCHMARK_STATEMENT, "",
    "# Brain benchmark: authentication scenario", "",
    `One synthetic organization, built through MemoryNet's domain functions on a fresh in-memory database at a fixed clock (${report.scenarioClock}). `
      + `The agent may read the identity and payments projects, but not incident response. ${report.tasks.length} tasks; every arm gets `
      + `${number.format(report.budget.maxTokens)} estimated tokens and at most ${report.budget.maxItems} items per task. `
      + (report.definitionsServed ? "Task context served reviewed definitions, which are scored." : "This build's task context does not serve definitions."),
    "", "## Totals", "", `| Arm ${header("Estimated tokens, all tasks")}`, `| --- ${rule}`,
    ...report.arms.map((arm) => `| ${label(arm.id)} | ${metricCells(report.totals[arm.id]).join(" | ")} |`),
    "",
    `The RAG arms stop at ${report.budget.maxItems} chunks, below the token budget. Sensitivity, not an arm: filling the whole budget instead, `
      + `the permission-aware RAG delivers ${filled.currentDelivered}/${filled.currentExpected} expected current guidance, ${filled.staleDelivered} stale `
      + `and ${filled.unapprovedDelivered} unapproved records in ${number.format(filled.estimatedTokens)} estimated tokens over all tasks. `
      + `Everything the agent may read totals ${number.format(report.corpus.permissionAware.estimatedTokens)} estimated tokens.`,
    "", "## Per task", "", `| Task | Arm ${header("Estimated tokens")}`, `| --- | --- ${rule}`,
    ...report.results.map((result) => {
      const task = report.tasks.find((item) => item.id === result.taskId)!;
      return `| ${task.task} | ${label(result.arm)} | ${metricCells(result.metrics).join(" | ")} |`;
    }),
    "", "## Reading the numbers", "",
    "- Current guidance: the fixture's expected current decisions and constraints for the task, delivered at their current version.",
    "- Stale: superseded decisions or older versions. Unapproved: pending or rejected proposal text, or a raw pull request excerpt delivered as context rather than as a citation of an approved decision.",
    "- Conflicts surfaced: reviewed conflicts reported as such. The RAG arms return ranked chunks and cannot report one.",
    "- Unauthorized: delivered text, citations included, that the agent's own permissions do not allow it to read.",
    "- Outdated skills: current definitions based on a decision that changed after their approval, and how many the response marked for review.",
    "- Estimated tokens: JSON characters of everything an arm returns, divided by four. Task context's include IDs, citations, reasons and notices."
      + (larger ? " Here task context returned the most estimated tokens; this run is not evidence of token savings." : ""),
    "", "## Limits", "", ...report.limits.map((limit) => `- ${limit}`), "",
  ];
  return lines.join("\n");
}
