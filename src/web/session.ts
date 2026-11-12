import { randomBytes } from "node:crypto";
import type { Session } from "./kit.ts";

export const SESSION_COOKIE = "mn_session";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Sessions live in memory only, so restarting the app signs everyone out. */
export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Always issues a new token, so an old or planted one can never become signed in. */
  create(principalId: string, github?: Session["github"]): Session {
    const session: Session = {
      token: newToken(),
      principalId,
      csrfToken: newToken(),
      createdAt: this.#now(),
      ...(github ? { github } : {}),
    };
    this.#sessions.set(session.token, session);
    return session;
  }

  find(token: string | undefined): Session | null {
    if (token === undefined) return null;
    const session = this.#sessions.get(token);
    if (!session) return null;
    if (this.#now() - session.createdAt > SESSION_MAX_AGE_MS) {
      this.#sessions.delete(token);
      return null;
    }
    return session;
  }

  /** Sessions that have not expired, dropping expired ones. */
  active(): Session[] {
    return [...this.#sessions.keys()].map((token) => this.find(token)).filter((session) => session !== null);
  }

  delete(token: string): void {
    this.#sessions.delete(token);
  }
}

export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
