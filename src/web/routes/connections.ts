import { html } from "../html.ts";
import { csrfField, page, type RequestContext, type WebResponse } from "../kit.ts";

export async function connectionsPage(rc: RequestContext): Promise<WebResponse> {
  const account = rc.session?.github;
  return page(rc, {
    title: "Connections",
    body: html`<section class="prototype-login">
      <h2>GitHub</h2>
      <p>Your local workspace works without a GitHub connection.</p>
      ${account
        ? html`<p>Connected as <strong>@${account.login}</strong>.</p>
            <form method="post" action="/connections/github/disconnect">
              ${csrfField(rc)}<button type="submit" class="secondary">Disconnect GitHub</button>
            </form>`
        : rc.github
          ? html`<p>Optionally verify the GitHub account linked to your local operator.</p>
              <form method="post" action="/connections/github">
                ${csrfField(rc)}<button type="submit">Connect GitHub</button>
              </form>`
          : html`<p>GitHub is not configured. To enable account connection, link your operator with
              <code>npm run github:link -- --login YOUR_LOGIN</code>, set
              <code>MEMORYNET_AUTH_MODE=local</code> and <code>MEMORYNET_GITHUB_CLIENT_ID</code>,
              and restart the app. The mode matters: a client ID on its own selects full
              GitHub sign-in instead of this optional connection.</p>`}
      <p class="hint">This optional connection verifies your GitHub account. Local roles and repository
        access remain configured in this workspace. Tokens stay in server memory and are cleared on
        disconnect or restart.</p>
      <p><a href="/">Back to workspace</a></p>
    </section>`,
  });
}
