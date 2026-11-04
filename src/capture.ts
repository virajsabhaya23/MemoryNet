import { recordAudit } from "./audit.ts";
import {
  flagDetails,
  mayContainInstructions,
  mayContainPersonalData,
  removeSecrets,
  type ContentFlag,
} from "./content-checks.ts";
import type { MemoryNetContext } from "./context.ts";
import { firstRow } from "./db.ts";
import { ValidationError } from "./errors.ts";
import {
  EXCERPT_MAX_LENGTH,
  mapSource,
  SOURCE_COLUMNS,
  type Source,
  type SourceRow,
} from "./knowledge.ts";
import { PROVIDERS, type Provider } from "./repositories.ts";
import {
  isPullRequestUrl,
  requireCommitSha,
  requireGithubId,
  requireHttpsUrl,
  requireOneOf,
  requirePositiveInteger,
} from "./validation.ts";

/** A merged pull request, as reported by a verified GitHub App event. */
export interface MergedPullRequestEvent {
  provider: Provider;
  externalRepositoryId: string;
  pullRequestNumber: number;
  url: string;
  mergeCommitSha: string;
  title: string;
  /** The pull request description, if it has one. */
  body?: string | null;
}

/**
 * captured: stored as a new source. duplicate: captured before, and the stored evidence was left as it was.
 * ignored: no project uses the repository, so nothing was stored.
 */
export type CaptureResult =
  | { status: "captured"; source: Source }
  | { status: "duplicate"; sourceId: string }
  | { status: "ignored"; reason: "repository_not_connected" };

// Only EXCERPT_MAX_LENGTH characters are kept, so scanning stops here.
const MAX_SCANNED_LENGTH = 100_000;
const UNSUPPORTED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// Binds $1 provider, $2 repository, $3 reference.
const CAPTURED_SOURCE_SQL = `
  SELECT id FROM sources
  WHERE capture_method = 'github_app' AND provider = $1
    AND external_repository_id = $2 AND reference = $3`;

/** Unifies line breaks and drops control characters that cannot be stored. */
function cleanText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be text`);
  }
  return value.replace(/\r\n?/g, "\n").replace(UNSUPPORTED_CONTROL, "").trim();
}

/** Cuts text to the limit without splitting a character stored as two UTF-16 units. */
function cutToLength(
  text: string,
  max: number,
): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return { text: text.slice(0, end).trimEnd(), cut: true };
}

/**
 * Trusted system entry point for verified GitHub App events. Never expose to user or agent credentials.
 * Stores a merged pull request's title and description as one source in the project its repository
 * is connected to. Later events for the same pull request, including redeliveries and edits after
 * the merge, never change the stored evidence. Likely secrets are removed before storing.
 */
export async function captureMergedPullRequest(
  ctx: MemoryNetContext,
  event: MergedPullRequestEvent,
): Promise<CaptureResult> {
  const provider = requireOneOf(event.provider, PROVIDERS, "provider");
  const externalRepositoryId = requireGithubId(
    event.externalRepositoryId,
    "externalRepositoryId",
  );
  const pullNumber = requirePositiveInteger(
    event.pullRequestNumber,
    "pullRequestNumber",
  );
  const reference = `pull/${pullNumber}`;
  const url = requireHttpsUrl(event.url, "url");
  if (!isPullRequestUrl(url, pullNumber, null)) {
    throw new ValidationError(`url must link to ${reference} on github.com`);
  }
  const revision = requireCommitSha(event.mergeCommitSha, "mergeCommitSha");
  const title = cleanText(event.title, "title").replace(/\s+/g, " ");
  if (title === "") throw new ValidationError("title is required");
  const body =
    event.body === undefined || event.body === null
      ? ""
      : cleanText(event.body, "body");
  const text = (body === "" ? title : `${title}\n\n${body}`).slice(
    0,
    MAX_SCANNED_LENGTH,
  );
  // Secrets go first, so cutting the text cannot leave part of one behind.
  const withoutSecrets = removeSecrets(text);
  const excerpt = cutToLength(withoutSecrets.text, EXCERPT_MAX_LENGTH);
  const flags: ContentFlag[] = [];
  if (withoutSecrets.removed) flags.push("secret_removed");
  if (mayContainPersonalData(excerpt.text)) flags.push("personal_data");
  if (excerpt.cut) flags.push("truncated");
  if (mayContainInstructions(excerpt.text)) flags.push("instruction_like");

  return ctx.db.transaction(async (tx): Promise<CaptureResult> => {
    const connected = await tx.query<{
      project_id: string;
      organization_id: string;
      full_name: string;
    }>(
      `SELECT rc.project_id, p.organization_id, rc.full_name
       FROM repository_connections rc JOIN projects p ON p.id = rc.project_id
       WHERE rc.provider = $1 AND rc.external_repository_id = $2
         AND rc.disconnected_at IS NULL`,
      [provider, externalRepositoryId],
    );
    const connection = connected.rows[0];
    if (!connection) {
      return { status: "ignored", reason: "repository_not_connected" };
    }
    // Bind the citation to the configured repository, including on duplicate deliveries.
    // The numeric repository ID alone cannot establish that a supplied URL belongs to it.
    if (!isPullRequestUrl(url, pullNumber, connection.full_name)) {
      throw new ValidationError(
        `url must link to ${reference} of ${connection.full_name} on github.com`,
      );
    }
    const earlier = await tx.query<{ id: string }>(CAPTURED_SOURCE_SQL, [
      provider,
      externalRepositoryId,
      reference,
    ]);
    if (earlier.rows[0]) {
      return { status: "duplicate", sourceId: earlier.rows[0].id };
    }
    const now = ctx.now();
    const { rows } = await tx.query<SourceRow>(
      `INSERT INTO sources (project_id, provider, external_repository_id, reference, url,
                            revision, excerpt, captured_by, captured_at, capture_method,
                            content_flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, 'github_app', $9::text[])
       ON CONFLICT (provider, external_repository_id, reference)
         WHERE capture_method = 'github_app' DO NOTHING
       RETURNING ${SOURCE_COLUMNS}`,
      [
        connection.project_id,
        provider,
        externalRepositoryId,
        reference,
        url,
        revision,
        excerpt.text,
        now,
        flags,
      ],
    );
    const inserted = rows[0];
    if (!inserted) {
      // Another delivery of the same event stored it first.
      const winner = await tx.query<{ id: string }>(CAPTURED_SOURCE_SQL, [
        provider,
        externalRepositoryId,
        reference,
      ]);
      return { status: "duplicate", sourceId: firstRow(winner.rows).id };
    }
    const source = mapSource(inserted);
    await recordAudit(tx, {
      occurredAt: now,
      actorId: null,
      action: "source.captured",
      organizationId: connection.organization_id,
      projectId: connection.project_id,
      targetType: "source",
      targetId: source.id,
      details: { reference, ...flagDetails(flags) },
    });
    return { status: "captured", source };
  });
}
