import type { MemoryNetContext } from "./context.ts";
import { ValidationError } from "./errors.ts";
import type { ProposalStatus } from "./knowledge.ts";
import { PROVIDERS, type Provider } from "./repositories.ts";
import {
  requireGithubId,
  requireOneOf,
  requirePositiveInteger,
} from "./validation.ts";

/** What the GitHub App would show as a check run on a pull request. */
export interface CheckSummary {
  name: string;
  /** Always neutral: memory review never blocks a merge. */
  conclusion: "neutral";
  title: string;
  /** Markdown with counts, versions, and review links only. */
  summary: string;
  detailsUrl: string;
}

export const CHECK_NAME = "MemoryNet review";

function requireBaseUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("reviewBaseUrl must be text");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("reviewBaseUrl must be a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("reviewBaseUrl must use http or https");
  }
  return url.origin;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Trusted system entry point for the GitHub App. Never expose to user or agent credentials.
 * Summarizes the memory proposals that cite a pull request, linking each to the review screen.
 * Everyone who can read the pull request sees a check run, so it holds no titles or content.
 * Returns null when no project uses the repository.
 */
export async function buildCheckSummary(
  ctx: MemoryNetContext,
  input: {
    provider: Provider;
    externalRepositoryId: string;
    pullRequestNumber: number;
    reviewBaseUrl: string;
  },
): Promise<CheckSummary | null> {
  const provider = requireOneOf(input.provider, PROVIDERS, "provider");
  const externalRepositoryId = requireGithubId(
    input.externalRepositoryId,
    "externalRepositoryId",
  );
  const pull = requirePositiveInteger(
    input.pullRequestNumber,
    "pullRequestNumber",
  );
  const base = requireBaseUrl(input.reviewBaseUrl);
  const connection = await ctx.db.query<{ project_id: string }>(
    `SELECT project_id FROM repository_connections
     WHERE provider = $1 AND external_repository_id = $2 AND disconnected_at IS NULL`,
    [provider, externalRepositoryId],
  );
  const projectId = connection.rows[0]?.project_id;
  if (projectId === undefined) return null;
  const { rows } = await ctx.db.query<{
    id: string;
    status: ProposalStatus;
    revision: number;
  }>(
    `SELECT mp.id, mp.status, mp.revision
     FROM memory_proposals mp
     WHERE mp.project_id = $1
       AND EXISTS (SELECT 1 FROM proposal_evidence pe JOIN sources s ON s.id = pe.source_id
                   WHERE pe.proposal_id = mp.id AND s.provider = $2
                     AND s.external_repository_id = $3 AND s.reference = $4)
     ORDER BY mp.proposed_at, mp.id`,
    [projectId, provider, externalRepositoryId, `pull/${pull}`],
  );
  const pending = rows.filter((row) => row.status === "pending");
  const link = (id: string) => `${base}/proposals/${id}`;
  const title =
    pending.length > 0
      ? `${plural(pending.length, "memory proposal")} waiting for review`
      : rows.length > 0
        ? "No memory proposals waiting for review"
        : "No memory proposals cite this pull request yet";
  const lines = rows.map(
    (row) =>
      `- Proposal \`${row.id.slice(0, 8)}\`, version ${row.revision}: ${row.status}. [Open the review screen](${link(row.id)})`,
  );
  const summary = [
    ...(lines.length > 0
      ? lines
      : ["Nothing to review for this pull request."]),
    "",
    "Titles and content stay in MemoryNet, where its access rules apply. Memory review never blocks a merge.",
  ].join("\n");
  return {
    name: CHECK_NAME,
    conclusion: "neutral",
    title,
    summary,
    detailsUrl: pending[0] ? link(pending[0].id) : `${base}/review`,
  };
}
