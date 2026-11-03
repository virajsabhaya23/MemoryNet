import { randomBytes } from "node:crypto";
import { captureMergedPullRequest } from "../../capture.ts";
import type { ContentFlag } from "../../content-checks.ts";
import { ValidationError } from "../../errors.ts";
import { html, table, type SafeHtml } from "../html.ts";
import {
  formValue,
  redirect,
  type RequestContext,
  type Route,
  type WebResponse,
} from "../kit.ts";
import {
  knownRepositories,
  repositoryOptions,
  stamp,
  systemForm,
  systemPath,
  type KnownRepository,
} from "../system-kit.ts";
import { flagBadges } from "../views.ts";

const RESULT_NOTICE = {
  captured: "pr-captured",
  duplicate: "pr-duplicate",
  ignored: "pr-ignored",
} as const;

/** The merged pull request event form, standing in for the GitHub App's event; `back` is the System tab to return to. */
export function captureForm(
  rc: RequestContext,
  repositories: readonly KnownRepository[],
  back: string,
  compact = false,
): SafeHtml {
  return systemForm(
    rc,
    "/system/merged-pull-request",
    html`<input type="hidden" name="back" value="${back}" />
      <div class="field-grid">
        <label
          >Repository
          <select name="externalRepositoryId" required>
            ${repositoryOptions(repositories)}
          </select></label
        >
        <label
          >Pull request number
          <input
            name="pullRequest"
            required
            inputmode="numeric"
            pattern="[1-9][0-9]*"
            placeholder="42"
        /></label>
      </div>
      <label
        >Title
        <input
          name="title"
          required
          maxlength="500"
          placeholder="What changed, as the pull request says it"
      /></label>
      ${
        compact
          ? html``
          : html`<label
              >Description (optional)
              <textarea name="body" maxlength="100000"></textarea>
            </label>`
      }
      <label
        >Merge commit SHA
        <input
          name="mergeCommitSha"
          required
          pattern="[0-9a-f]{7,64}"
          value="${randomBytes(20).toString("hex")}"
      /></label>`,
    "Send merged event",
  );
}

/** The latest pull requests the stand-in GitHub App captured. */
export async function capturedList(
  rc: RequestContext,
  limit: number,
): Promise<SafeHtml> {
  const { rows } = await rc.ctx.db.query<{
    reference: string;
    external_repository_id: string;
    project_name: string;
    content_flags: ContentFlag[];
    captured_at: Date;
  }>(
    `SELECT s.reference, s.external_repository_id, p.name AS project_name,
            s.content_flags, s.captured_at
     FROM sources s JOIN projects p ON p.id = s.project_id
     WHERE s.capture_method = 'github_app'
     ORDER BY s.captured_at DESC, s.id
     LIMIT $1`,
    [limit],
  );
  return html`<h3>Captured by the GitHub App</h3>
    ${table(
      ["Pull request", "Repository", "Project", "Flags", "Captured"],
      rows.map((row) => [
        html`${row.reference}`,
        html`<code>${row.external_repository_id}</code>`,
        html`${row.project_name}`,
        flagBadges(row.content_flags),
        html`<time>${stamp(row.captured_at)}</time>`,
      ]),
      "Nothing captured yet.",
    )}`;
}

async function mergedPullRequestAction(
  rc: RequestContext,
): Promise<WebResponse> {
  const pull = formValue(rc, "pullRequest")?.trim() ?? "";
  if (!/^[1-9][0-9]{0,9}$/.test(pull)) {
    throw new ValidationError(
      "Pull request number must be a whole number, such as 42",
    );
  }
  const externalRepositoryId = formValue(rc, "externalRepositoryId") ?? "";
  const repository = (await knownRepositories(rc)).find(
    (item) => item.externalRepositoryId === externalRepositoryId,
  );
  if (!repository?.fullName) {
    throw new ValidationError("Choose a repository from the list");
  }
  const result = await captureMergedPullRequest(rc.ctx, {
    provider: "github",
    externalRepositoryId,
    pullRequestNumber: Number(pull),
    url: `https://github.com/${repository.fullName}/pull/${pull}`,
    mergeCommitSha: formValue(rc, "mergeCommitSha") ?? "",
    title: rc.form.get("title") ?? "",
    body: rc.form.get("body"),
  });
  return redirect(systemPath(rc), RESULT_NOTICE[result.status]);
}

export const captureRoutes: readonly Route[] = [
  {
    method: "POST",
    pattern: /^\/system\/merged-pull-request$/,
    access: "system",
    handle: mergedPullRequestAction,
  },
];
