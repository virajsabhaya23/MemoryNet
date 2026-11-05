import { resolve } from "node:path";
import { bindingCapabilities, readAgentBindingFile } from "../agent-context/binding.ts";
import { parseFlags } from "../cli-args.ts";
import { MCP_CLIENTS, codexSessionOption, mcpServerEntry, renderClientConfig, type McpClient } from "../client-config.ts";
import { previewWorkspace, selectedCheckout } from "../local-discovery.ts";
import { importLocalDocument, localProfilePath, registerLocalProject } from "../local-project.ts";
import { readWorkspaceProfile } from "../workspace.ts";

const usage = "workspace <preview|register|import|status|start|connect> --root DIR [--project PATH] [--at PREVIEW_SHA --fixture] [--document PATH] [--client NAME] [--sandbox]";
try {
  const [action, ...args] = process.argv.slice(2);
  const flags = parseFlags(args, { values: ["root", "project", "at", "document", "client", "port", "from"], switches: ["fixture", "sandbox", "share-public-source", "session-option"] });
  const root = flags.value("root");
  if (!root) throw new Error(usage);
  if (action === "preview") {
    console.log(JSON.stringify(await previewWorkspace(root), null, 2));
  } else {
    const project = flags.value("project");
    if (!project) throw new Error("Select a project by its exact preview path with --project");
    const { repository } = await selectedCheckout(root, project);
    const state = resolve(".local/memorynet/local-projects");
    const profilePath = localProfilePath(repository, state);
    let profile = await readWorkspaceProfile(profilePath);
    if (action === "register" || action === "import") {
      const at = flags.value("at");
      const sourceProject = flags.value("from");
      if (sourceProject && (action !== "import" || !flags.has("share-public-source"))) {
        throw new Error("Importing from another checkout requires --share-public-source. This declares source read access for the selected fixture project’s operator, reviewers and agent.");
      }
      if (!at || !flags.has("fixture") || (!sourceProject && at !== repository.commit)) throw new Error("Confirm public or synthetic data with --fixture and the previewed --at commit");
      if (action === "register") profile = await registerLocalProject(repository, state, at, Number(flags.value("port") ?? 3050));
      else {
        const doc = flags.value("document");
        if (!profile || !doc) throw new Error("Register the project first and select one --document from preview");
        const source = await importLocalDocument(root, project, at, doc, profile, sourceProject);
        console.log(`Evidence ${source.id} · ${source.reference} · ${source.url}\nAwaiting a proposal and exact-version review.`);
      }
    }
    if (!profile || profile.repository.id !== repository.id || profile.repository.branch !== repository.branch) throw new Error("Register the selected project and branch first");
    if (action === "start") {
      process.env.MEMORYNET_WORKSPACE_PROFILE = profilePath;
      process.env.MEMORYNET_DATA_DIR = profile.dataDir;
      process.env.MEMORYNET_AGENT_BINDING_FILE = profile.bindingFile;
      process.env.MEMORYNET_PROTOTYPE_CONFIG = "off";
      process.env.MEMORYNET_AUTH_MODE = flags.has("sandbox") ? "sandbox" : "local";
      delete process.env.MEMORYNET_GITHUB_CLIENT_ID;
      delete process.env.MODEL_API_KEY;
      await import("./start.ts");
    } else if (action === "connect") {
      const client = flags.value("client") as McpClient | undefined;
      if (!client || !MCP_CLIENTS.includes(client)) throw new Error("Choose --client " + MCP_CLIENTS.join("|"));
      if (flags.has("session-option") && client !== "codex") throw new Error("--session-option requires --client codex");
      const entry = mcpServerEntry(profile);
      console.log(flags.has("session-option") ? codexSessionOption(entry) : renderClientConfig(client, entry, null));
    } else if (action === "status" || action === "register") {
      const binding = await readAgentBindingFile(profile.bindingFile);
      console.log(JSON.stringify({ project, branch: repository.branch, repositoryId: repository.id, projectId: profile.projectId,
        appUrl: profile.appUrl, capabilities: bindingCapabilities(binding), expiresAt: binding.expiresAt, renewal: "Restart workspace start for this project and reload the client." }, null, 2));
    } else if (action !== "import") throw new Error(usage);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local workspace operation failed");
  process.exitCode = 1;
}
