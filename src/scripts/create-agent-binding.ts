import { writeAgentBindingFile } from "../agent-context/binding.ts";

const [path, principalId, projectId, repositoryId, branch, ...extra] = process.argv.slice(2);
if (!path || !principalId || !projectId || !repositoryId || !branch || extra.length) {
  console.error("Usage: node src/scripts/create-agent-binding.ts <new-private-file> <agentUUID> <projectUUID> <numericGitHubRepoID> <exactBranch>");
  process.exitCode = 2;
} else {
  try {
    await writeAgentBindingFile(path, { principalId, projectId, repositoryId, branch });
    console.error("Created owner-only 24-hour local binding. No database role or repository access was granted. Keep the file private; never paste its contents.");
  } catch { console.error("Could not create local binding. Validate arguments and choose a new private file path."); process.exitCode = 1; }
}
