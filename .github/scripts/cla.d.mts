export const CLA_VERSION: string;
export const AGREEMENT: string;
export const SIGNATURES_BRANCH: string;
export const SIGNATURES_PATH: string;
export const STATUS_CONTEXT: string;
export const MARKER: string;

export interface GitHubUser { id: number; login: string; type?: string }
export interface PullCommit { sha: string; author: GitHubUser | null }
export interface IssueComment { id: number; body?: string | null; user: GitHubUser | null; created_at: string; html_url: string }
export interface Signature { id: number; login: string; claVersion: string; signedAt: string; pullRequest: number; commentUrl: string }
export interface ClaResult { ok: boolean; missing: string[]; unlinked: string[] }
export interface GitHubClient { request(route: string, parameters?: Record<string, unknown>): Promise<{ data: any }> }
export interface ClaContext { repo: { owner: string; repo: string }; serverUrl: string; payload: Record<string, any> }

export function isAgreement(body: unknown): boolean;
export function parseTeamMembers(text: string): Set<string>;
export function requiredSigners(pullAuthor: GitHubUser, commits: readonly PullCommit[], maintainers: ReadonlySet<string>): { signers: Map<number, string>; unlinked: string[] };
export function newSignatures(signers: ReadonlyMap<number, string>, comments: readonly IssueComment[], recorded: readonly Signature[], pullRequest: number): Signature[];
export function evaluate(signers: ReadonlyMap<number, string>, unlinked: readonly string[], signatures: readonly Signature[]): ClaResult;
export function renderComment(result: ClaResult, claUrl: string): string;
export function run(input: { github: GitHubClient; context: ClaContext }): Promise<ClaResult | { skipped: string }>;
