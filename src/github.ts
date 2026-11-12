// GitHub OAuth device-flow sign-in and repository permission checks. Works with a GitHub App or an OAuth App that has
// device flow enabled; only the public client ID is configured, and access tokens are never written to disk.
import { z } from "zod";

const WEB = "https://github.com";
const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const CLIENT_ID = /^[A-Za-z0-9._-]{8,64}$/;

export interface GitHubClientOptions {
  clientId: string;
  /** OAuth App scopes, for example "repo" to check private repositories. GitHub Apps use installation permissions. */
  scope?: string;
  fetch?: typeof fetch;
}

export interface DeviceAuthorization { deviceCode: string; userCode: string; verificationUri: string; expiresInMs: number; intervalMs: number }
export type DevicePoll = { state: "pending"; intervalMs?: number } | { state: "denied" | "expired" } | { state: "authorized"; token: string };
export interface GitHubAccount { id: string; login: string; type: string }

/** GitHub no longer accepts the token: it expired, was revoked, or the app lost access. */
export class GitHubTokenRejected extends Error {}

export interface GitHubClient {
  startDeviceFlow(): Promise<DeviceAuthorization>;
  pollDeviceFlow(deviceCode: string): Promise<DevicePoll>;
  account(token: string): Promise<GitHubAccount>;
  /** Throws GitHubTokenRejected for a dead token, and a plain Error when GitHub cannot answer now. */
  repositoryAccess(token: string, repositoryId: string): Promise<"read" | "none">;
  lookupAccount(login: string): Promise<GitHubAccount>;
}

const ErrorSchema = z.object({ error: z.string(), error_description: z.string().optional(), interval: z.number().int().positive().optional() });
const DeviceCodeSchema = z.object({
  device_code: z.string().min(1), user_code: z.string().min(1).max(20),
  verification_uri: z.string().startsWith(`${WEB}/`), expires_in: z.number().int().positive(), interval: z.number().int().nonnegative(),
});
const AccountSchema = z.object({ id: z.number().int().positive(), login: z.string().min(1), type: z.string() });
const RepositorySchema = z.object({ id: z.number().int().positive(), permissions: z.object({ pull: z.boolean() }).partial().optional() });

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  if (!CLIENT_ID.test(options.clientId)) throw new Error("MEMORYNET_GITHUB_CLIENT_ID is not a GitHub client ID");
  const send = options.fetch ?? fetch;

  async function oauth(path: string, fields: Record<string, string>): Promise<unknown> {
    const response = await send(`${WEB}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "MemoryNet" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub sign-in is unavailable (HTTP ${response.status})`);
    return response.json();
  }

  function api(path: string, token?: string): Promise<Response> {
    return send(`${API}${path}`, {
      headers: {
        accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "MemoryNet",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async function readAccount(response: Response): Promise<GitHubAccount> {
    const account = AccountSchema.parse(await response.json());
    return { id: String(account.id), login: account.login, type: account.type };
  }

  return {
    async startDeviceFlow() {
      const body = await oauth("/login/device/code", { client_id: options.clientId, scope: options.scope ?? "" });
      const refused = ErrorSchema.safeParse(body);
      if (refused.success) throw new Error(`GitHub refused to start sign-in: ${refused.data.error_description ?? refused.data.error}`);
      const code = DeviceCodeSchema.parse(body);
      return {
        deviceCode: code.device_code, userCode: code.user_code, verificationUri: code.verification_uri,
        expiresInMs: code.expires_in * 1000, intervalMs: Math.max(5, code.interval) * 1000,
      };
    },

    async pollDeviceFlow(deviceCode) {
      const body = await oauth("/login/oauth/access_token", {
        client_id: options.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      const granted = z.object({ access_token: z.string().min(1) }).safeParse(body);
      if (granted.success) return { state: "authorized", token: granted.data.access_token };
      const error = ErrorSchema.parse(body);
      switch (error.error) {
        case "authorization_pending": return { state: "pending" };
        case "slow_down": return { state: "pending", intervalMs: (error.interval ?? 10) * 1000 };
        case "access_denied": return { state: "denied" };
        case "expired_token": return { state: "expired" };
        default: throw new Error(`GitHub sign-in failed: ${error.error_description ?? error.error}`);
      }
    },

    async account(token) {
      const response = await api("/user", token);
      if (response.status === 401) throw new GitHubTokenRejected("GitHub rejected the sign-in token");
      if (!response.ok) throw new Error(`GitHub did not return the signed-in account (HTTP ${response.status})`);
      return readAccount(response);
    },

    async repositoryAccess(token, repositoryId) {
      if (!/^[1-9][0-9]{0,18}$/.test(repositoryId)) throw new Error("Invalid GitHub repository ID");
      const response = await api(`/repositories/${repositoryId}`, token);
      if (response.status === 401) throw new GitHubTokenRejected("GitHub rejected the sign-in token");
      // A rate limit or outage is not an answer: leave the last observation to expire instead of recording one.
      const limited = response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
      if (response.status === 429 || response.status >= 500 || (response.status === 403 && limited)) {
        throw new Error(`GitHub could not check repository access now (HTTP ${response.status})`);
      }
      if (response.status === 403 || response.status === 404) return "none";
      if (!response.ok) throw new Error(`Unexpected GitHub response (HTTP ${response.status})`);
      const repository = RepositorySchema.parse(await response.json());
      return String(repository.id) === repositoryId && repository.permissions?.pull !== false ? "read" : "none";
    },

    async lookupAccount(login) {
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new Error("Invalid GitHub login");
      const response = await api(`/users/${login}`);
      if (response.status === 404) throw new Error(`No GitHub account is named ${login}`);
      if (!response.ok) throw new Error(`GitHub did not return the account (HTTP ${response.status})`);
      return readAccount(response);
    },
  };
}
