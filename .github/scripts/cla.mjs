// Pull-request CLA check. The CLA workflow runs this file from the trusted base branch under pull_request_target or
// issue_comment. It reads pull-request metadata through the GitHub API and never checks out or runs pull-request code.

export const CLA_VERSION = "1.0";
export const AGREEMENT = `I have read the MemoryNet CLA (version ${CLA_VERSION}) and I agree to its terms.`;
export const SIGNATURES_BRANCH = "cla-signatures";
export const SIGNATURES_PATH = `signatures/cla-v${CLA_VERSION}.json`;
export const STATUS_CONTEXT = "cla";
export const MARKER = "<!-- memorynet-cla -->";
const BOT_LOGIN = "github-actions[bot]";
const MAX_PAGES = 10;

const normalize = (text) => text.trim().replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();

/** True when a comment is the agreement sentence, ignoring case, spacing and a final period. */
export function isAgreement(body) {
  return typeof body === "string" && normalize(body) === normalize(AGREEMENT);
}

/** Lower-case maintainer logins from .github/TEAM_MEMBERS; "#" starts a comment. */
export function parseTeamMembers(text) {
  return new Set(text.split(/\r?\n/).map((line) => line.replace(/#.*/, "").trim().toLowerCase()).filter(Boolean));
}

const isBot = (user) => user.type === "Bot" || user.login.endsWith("[bot]");

/**
 * The pull-request author and every human commit author must agree. Commit authorship comes from unverified commit
 * e-mail, so the pull-request author is always required and cannot hide behind a maintainer's address.
 */
export function requiredSigners(pullAuthor, commits, maintainers) {
  const signers = new Map();
  const unlinked = [];
  const add = (user) => {
    if (!isBot(user) && !maintainers.has(user.login.toLowerCase())) signers.set(user.id, user.login);
  };
  add(pullAuthor);
  for (const commit of commits) {
    if (commit.author) add(commit.author);
    else unlinked.push(commit.sha.slice(0, 7));
  }
  return { signers, unlinked };
}

/** Records for required signers whose agreement comment is not stored yet. Every run rescans, so none is lost. */
export function newSignatures(signers, comments, recorded, pullRequest) {
  const known = new Set(recorded.map((signature) => signature.id));
  const added = [];
  for (const comment of comments) {
    const user = comment.user;
    if (!user || !signers.has(user.id) || known.has(user.id) || !isAgreement(comment.body)) continue;
    known.add(user.id);
    added.push({ id: user.id, login: user.login, claVersion: CLA_VERSION, signedAt: comment.created_at, pullRequest, commentUrl: comment.html_url });
  }
  return added;
}

export function evaluate(signers, unlinked, signatures) {
  const signed = new Set(signatures.map((signature) => signature.id));
  const missing = [...signers].filter(([id]) => !signed.has(id)).map(([, login]) => login).sort();
  return { ok: missing.length === 0 && unlinked.length === 0, missing, unlinked: [...unlinked] };
}

export function renderComment(result, claUrl) {
  if (result.ok) return `${MARKER}\nEveryone who authored this pull request has agreed to the [MemoryNet CLA](${claUrl}). Thank you.`;
  const lines = [
    MARKER,
    `Thank you for contributing. Before this pull request can be merged, its authors must agree to the [MemoryNet Contributor License Agreement](${claUrl}). You keep your copyright; the agreement lets the maintainer license MemoryNet under other terms later.`,
  ];
  if (result.missing.length) {
    lines.push("", `Still needed from: ${result.missing.map((login) => `@${login}`).join(", ")}`, "", "Each of you, please read the CLA and reply with this comment:", "", "```text", AGREEMENT, "```");
  }
  if (result.unlinked.length) {
    lines.push("", `Commits ${result.unlinked.map((sha) => `\`${sha}\``).join(", ")} use an e-mail address that is not linked to a GitHub account. Add that address to your GitHub account, or amend the commits with a linked address, so the author can be checked.`);
  }
  return lines.join("\n");
}

function statusDescription(result) {
  if (result.ok) return "All authors agreed to the MemoryNet CLA";
  const parts = [];
  if (result.missing.length) parts.push(`${result.missing.length} author(s) must agree to the CLA`);
  if (result.unlinked.length) parts.push(`${result.unlinked.length} commit(s) have no linked GitHub account`);
  return parts.join("; ").slice(0, 140);
}

const hasStatus = (error, ...statuses) => statuses.includes(error?.status);

async function pages(github, route, parameters) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await github.request(route, { ...parameters, per_page: 100, page });
    items.push(...data);
    if (data.length < 100) break;
  }
  return items;
}

async function readFile(github, repository, path, ref) {
  try {
    const { data } = await github.request("GET /repos/{owner}/{repo}/contents/{path}", { ...repository, path, ref });
    return { text: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
  } catch (error) {
    if (hasStatus(error, 404)) return null;
    throw error;
  }
}

async function readSignatures(github, repository) {
  const file = await readFile(github, repository, SIGNATURES_PATH, SIGNATURES_BRANCH);
  return { signatures: file ? JSON.parse(file.text).signatures : [], sha: file?.sha };
}

async function ensureSignaturesBranch(github, repository, defaultBranch) {
  try {
    await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { ...repository, ref: `heads/${SIGNATURES_BRANCH}` });
    return;
  } catch (error) {
    if (!hasStatus(error, 404)) throw error;
  }
  const { data } = await github.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { ...repository, ref: `heads/${defaultBranch}` });
  try {
    await github.request("POST /repos/{owner}/{repo}/git/refs", { ...repository, ref: `refs/heads/${SIGNATURES_BRANCH}`, sha: data.object.sha });
  } catch (error) {
    if (!hasStatus(error, 422)) throw error; // Another run created it first.
  }
}

/** Appends records with optimistic concurrency: a write that conflicts with another run is re-read and merged. */
async function recordSignatures(github, repository, defaultBranch, additions) {
  await ensureSignaturesBranch(github, repository, defaultBranch);
  for (let attempt = 1; ; attempt++) {
    const current = await readSignatures(github, repository);
    const known = new Set(current.signatures.map((signature) => signature.id));
    const fresh = additions.filter((signature) => !known.has(signature.id));
    if (!fresh.length) return current.signatures;
    const signatures = [...current.signatures, ...fresh];
    try {
      await github.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        ...repository,
        path: SIGNATURES_PATH,
        branch: SIGNATURES_BRANCH,
        message: `Record CLA ${CLA_VERSION} agreement: ${fresh.map((signature) => signature.login).join(", ")}`,
        content: Buffer.from(JSON.stringify({ claVersion: CLA_VERSION, signatures }, null, 2) + "\n").toString("base64"),
        ...(current.sha ? { sha: current.sha } : {}),
      });
      return signatures;
    } catch (error) {
      if (attempt >= 3 || !hasStatus(error, 409, 422)) throw error;
    }
  }
}

export async function run({ github, context }) {
  const repository = { owner: context.repo.owner, repo: context.repo.repo };
  const { pull_request: pullEvent, issue } = context.payload;
  const number = pullEvent?.number ?? (issue?.pull_request ? issue.number : undefined);
  if (!number) return { skipped: "not a pull request" };
  const { data: pull } = await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...repository, pull_number: number });
  if (pull.state !== "open") return { skipped: "pull request is closed" };

  const maintainers = parseTeamMembers((await readFile(github, repository, ".github/TEAM_MEMBERS", pull.base.ref))?.text ?? "");
  const commits = await pages(github, "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", { ...repository, pull_number: number });
  const { signers, unlinked } = requiredSigners(pull.user, commits, maintainers);
  const comments = await pages(github, "GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repository, issue_number: number });
  let { signatures } = await readSignatures(github, repository);
  const additions = newSignatures(signers, comments, signatures, number);
  if (additions.length) signatures = await recordSignatures(github, repository, pull.base.repo.default_branch, additions);

  const result = evaluate(signers, unlinked, signatures);
  const claUrl = `${context.serverUrl}/${repository.owner}/${repository.repo}/blob/${pull.base.ref}/CLA.md`;
  await github.request("POST /repos/{owner}/{repo}/statuses/{sha}", {
    ...repository, sha: pull.head.sha, state: result.ok ? "success" : "failure", context: STATUS_CONTEXT, description: statusDescription(result), target_url: claUrl,
  });
  const body = renderComment(result, claUrl);
  const existing = comments.find((comment) => comment.user?.login === BOT_LOGIN && typeof comment.body === "string" && comment.body.startsWith(MARKER));
  if (existing) {
    if (existing.body !== body) await github.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", { ...repository, comment_id: existing.id, body });
  } else if (!result.ok) {
    await github.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...repository, issue_number: number, body });
  }
  return result;
}
