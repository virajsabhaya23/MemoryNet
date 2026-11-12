// Links an existing person to their GitHub account so they can use "Sign in with GitHub". Run with the app stopped.
import { parseFlags } from "../cli-args.ts";
import { createContext } from "../context.ts";
import { openMigratedDatabase } from "../database-upgrade.ts";
import { createGitHubClient } from "../github.ts";
import { linkGitHubAccount } from "../members.ts";
import { readWorkspaceProfile } from "../workspace.ts";

try {
  const flags = parseFlags(process.argv.slice(2), { values: ["login", "person"] });
  const login = flags.value("login");
  if (!login) throw new Error("Usage: npm run github:link -- --login <github-login> [--person <principal-id>]");
  const profile = await readWorkspaceProfile();
  const personId = flags.value("person") ?? profile?.operatorId;
  if (!personId) throw new Error("Give --person <principal-id>; there is no workspace from npm run setup to default to.");
  const dataDir = process.env.MEMORYNET_DATA_DIR ?? profile?.dataDir ?? ".data/memorynet";
  // Looking up a public account needs no credentials; the client ID only satisfies the shared client.
  const account = await createGitHubClient({ clientId: process.env.MEMORYNET_GITHUB_CLIENT_ID?.trim() || "lookup-only" }).lookupAccount(login);
  if (account.type !== "User") throw new Error(`@${account.login} is a ${account.type} account, not a person`);
  const { db } = await openMigratedDatabase(dataDir);
  try {
    const { changed } = await linkGitHubAccount(createContext(db), { principalId: personId, githubUserId: account.id });
    console.log(`${changed ? "Linked" : "Already linked"}: @${account.login} (GitHub ID ${account.id}) in ${dataDir}`);
  } finally {
    await db.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Linking failed");
  process.exitCode = 1;
}
