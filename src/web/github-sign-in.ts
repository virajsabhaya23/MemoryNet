// "Sign in with GitHub" for the local app: OAuth device flow, a session bound to the verified GitHub account, and
// repository access that GitHub confirms at sign-in and again every few minutes. Tokens stay in server memory.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { bindingOwner, type AgentBinding } from "../agent-context/binding.ts";
import type { MemoryNetContext } from "../context.ts";
import { GitHubTokenRejected, type GitHubClient } from "../github.ts";
import { recordRepositoryAccess } from "../repositories.ts";
import { html } from "./html.ts";
import { errorPage, page, redirect, type RequestContext, type Session, type WebResponse } from "./kit.ts";
import { clearedSessionCookie, readCookie, SESSION_COOKIE, sessionCookie, type SessionStore } from "./session.ts";

export const GITHUB_REFRESH_MS = 5 * 60 * 1000;
const MAX_PENDING = 32;
const MAX_REPOSITORIES = 500;
const CONCURRENCY = 6;

export interface GitHubSignInOptions {
  client: GitHubClient;
  /** Background re-verification period. 0 turns it off; tests call refresh() themselves. */
  refreshIntervalMs?: number;
}

interface PendingSignIn { deviceCode: string; userCode: string; verificationUri: string; expiresAt: number; intervalMs: number; nextPollAt: number }
interface AgentDelegation { agentId: string; repositoryId: string }

const withCookie = (response: WebResponse, cookie: string): WebResponse => ({ ...response, headers: { ...response.headers, "Set-Cookie": cookie } });

function sameToken(given: string | null, expected: string): boolean {
  if (given === null || expected === "") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Asks GitHub which connected repositories this person can read now and records each answer. Agents bound to this
 * person receive the same answer for their bound repository: they can read only what their signed-in owner can.
 * Repositories GitHub cannot answer for (outage, rate limit) are left to expire, which hides them.
 */
export async function verifyRepositoryAccess(
  ctx: MemoryNetContext, client: GitHubClient, principalId: string, token: string, delegations: readonly AgentDelegation[] = [],
): Promise<{ checked: number; readable: number }> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT DISTINCT external_repository_id AS id FROM repository_connections
     WHERE provider = 'github' AND disconnected_at IS NULL ORDER BY 1 LIMIT ${MAX_REPOSITORIES}`,
  );
  const queue = [...new Set([...rows.map((row) => row.id), ...delegations.map((d) => d.repositoryId)])];
  const answers = new Map<string, boolean>();
  let rejected: unknown = null;
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined && rejected === null; id = queue.shift()) {
      try {
        answers.set(id, (await client.repositoryAccess(token, id)) === "read");
      } catch (error) {
        if (error instanceof GitHubTokenRejected) rejected = error;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (rejected) throw rejected;
  const observedAt = ctx.now();
  const record = (who: string, id: string, canRead: boolean) =>
    recordRepositoryAccess(ctx, { principalId: who, provider: "github", externalRepositoryId: id, canRead, observedAt });
  for (const [id, canRead] of answers) await record(principalId, id, canRead);
  for (const { agentId, repositoryId } of delegations) {
    const canRead = answers.get(repositoryId);
    if (canRead !== undefined) await record(agentId, repositoryId, canRead);
  }
  return { checked: answers.size, readable: [...answers.values()].filter(Boolean).length };
}

export function createGitHubSignIn(
  ctx: MemoryNetContext, sessions: SessionStore, systemToken: string, options: GitHubSignInOptions,
  loadBinding?: () => Promise<AgentBinding>,
  localPrincipalId?: string,
) {
  const { client } = options;
  const pending = new Map<string, PendingSignIn>();
  const now = () => ctx.now().getTime();
  const flowPath = localPrincipalId ? "/connections/github" : "/sign-in/github";
  const homePath = localPrincipalId ? "/connections" : "/";
  const failure = (rc: RequestContext, message: string) => localPrincipalId
    ? errorPage(rc, 403, message)
    : withCookie(errorPage(rc, 403, message), clearedSessionCookie());

  async function delegationsFor(principalId: string): Promise<AgentDelegation[]> {
    const binding = await loadBinding?.().catch(() => null);
    return binding && bindingOwner(binding) === principalId ? [{ agentId: binding.principalId, repositoryId: binding.repositoryId }] : [];
  }

  async function verify(session: Session): Promise<void> {
    if (localPrincipalId) {
      const account = await client.account(session.github!.token);
      if (account.id !== session.github!.userId) throw new GitHubTokenRejected("GitHub account changed");
      return;
    }
    await verifyRepositoryAccess(ctx, client, session.principalId, session.github!.token, await delegationsFor(session.principalId));
  }

  /** Re-verifies each signed-in person once. A token GitHub rejects ends its session. */
  async function refresh(): Promise<void> {
    const verified = new Set<string>();
    for (const session of sessions.active()) {
      if (!session.github || verified.has(session.principalId)) continue;
      try {
        await verify(session);
        verified.add(session.principalId);
      } catch (error) {
        if (error instanceof GitHubTokenRejected) {
          if (localPrincipalId) delete session.github;
          else sessions.delete(session.token);
        }
        else console.warn(`GitHub access check failed; access expires unless the next check succeeds: ${(error as Error).message}`);
      }
    }
  }

  function waiting(rc: RequestContext, flow: PendingSignIn): WebResponse {
    const seconds = Math.ceil(flow.intervalMs / 1000);
    const response = page(rc, {
      title: localPrincipalId ? "Connect GitHub" : "Sign in with GitHub",
      body: html`<section class="prototype-login">
        <h2>Approve MemoryNet on GitHub</h2>
        <p>Open <a href="${flow.verificationUri}" target="_blank" rel="noopener noreferrer">${flow.verificationUri}</a> and enter this code:</p>
        <p class="device-code"><strong>${flow.userCode}</strong></p>
        <p class="hint">This page checks with GitHub every ${seconds} seconds and continues after you approve. The code expires in ${Math.max(1, Math.round((flow.expiresAt - now()) / 60_000))} minutes.</p>
        <p><a href="${flowPath}">Check now</a></p>
        ${localPrincipalId ? html`<p><a href="/">Continue using your workspace</a></p>` : ""}
      </section>`,
    });
    return { ...response, headers: { ...response.headers, Refresh: `${seconds}; url=${flowPath}` } };
  }

  async function complete(rc: RequestContext, token: string): Promise<WebResponse> {
    let account;
    try { account = await client.account(token); }
    catch (error) {
      if (error instanceof GitHubTokenRejected) return failure(rc, "GitHub rejected the connection. Try again.");
      throw error;
    }
    const { rows } = await ctx.db.query<{ id: string }>(
      "SELECT id FROM principals WHERE github_user_id = $1 AND kind = 'human'", [account.id],
    );
    const principal = rows[0];
    if (!principal || (localPrincipalId && principal.id !== localPrincipalId)) {
      return failure(rc, `The GitHub account @${account.login} is not linked to ${localPrincipalId ? "your local operator" : "anyone in this workspace"}. An administrator can link it with npm run github:link.`);
    }
    const session = sessions.create(principal.id, { token, login: account.login, userId: account.id });
    try {
      await verify(session);
    } catch (error) {
      if (error instanceof GitHubTokenRejected) {
        sessions.delete(session.token);
        return failure(rc, "GitHub rejected the new connection. Try again.");
      }
      console.warn(`GitHub access check failed at sign-in: ${(error as Error).message}`);
    }
    if (rc.session) sessions.delete(rc.session.token);
    return withCookie(redirect(homePath, localPrincipalId ? undefined : "signed-in"), sessionCookie(session.token));
  }

  return {
    refresh,

    async disconnect(rc: RequestContext): Promise<WebResponse> {
      if (!localPrincipalId || !rc.session) return errorPage(rc, 403, "No local connection is available.");
      pending.delete(rc.session.token);
      sessions.delete(rc.session.token);
      return withCookie(redirect(homePath), sessionCookie(sessions.create(localPrincipalId).token));
    },

    /** POST /sign-in/github. Until GitHub approves, the session cookie names this pending sign-in, not a session. */
    async start(rc: RequestContext): Promise<WebResponse> {
      if (localPrincipalId
        ? rc.session?.principalId !== localPrincipalId || !sameToken(rc.form.get("_csrf"), rc.session.csrfToken)
        : !sameToken(rc.form.get("_login"), systemToken)) return errorPage(rc, 403, "This connection form has expired. Reload the page and try again.");
      for (const [key, flow] of pending) if (now() >= flow.expiresAt) pending.delete(key);
      if (pending.size >= MAX_PENDING) return errorPage(rc, 429, "Too many sign-ins are waiting for GitHub. Try again in a few minutes.");
      const device = await client.startDeviceFlow();
      const key = localPrincipalId ? rc.session!.token : randomBytes(32).toString("base64url");
      pending.set(key, { ...device, expiresAt: now() + device.expiresInMs, nextPollAt: now() + device.intervalMs });
      if (localPrincipalId) return redirect(flowPath);
      if (rc.session) sessions.delete(rc.session.token);
      return withCookie(redirect(flowPath), sessionCookie(key));
    },

    /** GET /sign-in/github. Polls GitHub no faster than it allows, then binds a new session to the verified account. */
    async poll(rc: RequestContext): Promise<WebResponse> {
      const key = localPrincipalId ? rc.session?.token : readCookie(rc.req.headers.cookie, SESSION_COOKIE);
      const flow = key ? pending.get(key) : undefined;
      if (!key || !flow) return redirect(homePath);
      if (now() >= flow.expiresAt) {
        pending.delete(key);
        return failure(rc, "The GitHub code expired. Start the connection again.");
      }
      if (now() >= flow.nextPollAt) {
        const result = await client.pollDeviceFlow(flow.deviceCode);
        if (result.state === "pending") {
          flow.intervalMs = result.intervalMs ?? flow.intervalMs;
          flow.nextPollAt = now() + flow.intervalMs;
        } else {
          pending.delete(key);
          if (result.state === "authorized") return complete(rc, result.token);
          return failure(rc, result.state === "denied" ? "GitHub connection was cancelled." : "The GitHub code expired. Start the connection again.");
        }
      }
      return waiting(rc, flow);
    },
  };
}
