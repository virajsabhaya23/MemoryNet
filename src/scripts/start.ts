import { repositoryProvider } from "../repository-identity.ts";
// Starts the app for the workspace created by `npm run setup`, renewing its agent binding and local access first.
import { bindingCapabilities, bindingOwner, readAgentBindingFile, rotateAgentBindingFile, writeAgentBindingFile } from "../agent-context/binding.ts";
import { createContext } from "../context.ts";
import { openMigratedDatabase } from "../database-upgrade.ts";
import { LOCAL_ACCESS_MAX_AGE_MS, renewLocalAccess } from "../setup.ts";
import { readWorkspaceProfile } from "../workspace.ts";
import { resolveAccessMode } from "../web/access-mode.ts";

const RENEW_BEFORE_MS = 2 * 60 * 60 * 1000;
const profile = await readWorkspaceProfile();
if (!profile) {
  console.error("No workspace yet. Run npm run setup -- --repo owner/name first, or use npm run app for the sandbox.");
  process.exit(1);
}
// An empty value, as left by a copied .env.example, counts as unset.
process.env.MEMORYNET_PROTOTYPE_CONFIG ||= "off";
process.env.MEMORYNET_DATA_DIR ||= profile.dataDir;
process.env.MEMORYNET_AGENT_BINDING_FILE ||= profile.bindingFile;
const scope = { principalId: profile.agentId, projectId: profile.projectId, repositoryId: profile.repository.id, branch: profile.repository.branch };
try {
  const current = await readAgentBindingFile(profile.bindingFile);
  if (Date.parse(current.expiresAt) - Date.now() < RENEW_BEFORE_MS) {
    await rotateAgentBindingFile(profile.bindingFile, { ...scope, capabilities: bindingCapabilities(current), ownerId: bindingOwner(current) });
    console.log("Agent binding renewed for 24 hours. Restart your coding client's MemoryNet server to pick it up.");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  await writeAgentBindingFile(profile.bindingFile, { ...scope, capabilities: repositoryProvider(profile.repository.id) === "local" ? ["context"] : ["context", "propose", "report"], ownerId: profile.operatorId });
  console.log("Agent binding recreated.");
}
const { db } = await openMigratedDatabase(profile.dataDir);
try {
  if (resolveAccessMode(process.env.MEMORYNET_AUTH_MODE, true, { github: !!process.env.MEMORYNET_GITHUB_CLIENT_ID?.trim() }) === "github") {
    console.log("GitHub sign-in is configured: repository access is checked with GitHub when people sign in, not declared locally.");
  } else {
    const renewed = await renewLocalAccess(createContext(db, { repositoryAccessMaxAgeMs: LOCAL_ACCESS_MAX_AGE_MS }), profile);
    console.log(`Local repository access declarations renewed for ${renewed} principals (local trial; not verified with GitHub).`);
  }
} finally {
  await db.close();
}
await import("../web/server.ts");
