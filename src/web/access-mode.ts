export type AccessMode = "local" | "sandbox" | "access-key" | "github";

/** Keep existing login gates on upgrade; new setup workspaces open as their local operator. */
export function resolveAccessMode(
  value: string | undefined,
  hasOperator: boolean,
  configured: { github?: boolean; accessKey?: boolean } = {},
): AccessMode {
  const mode = value?.trim() || (configured.github ? "github" : configured.accessKey ? "access-key" : hasOperator ? "local" : "sandbox");
  if (mode !== "local" && mode !== "sandbox" && mode !== "access-key" && mode !== "github") {
    throw new Error("MEMORYNET_AUTH_MODE must be local, sandbox, access-key, or github");
  }
  if (mode === "local" && !hasOperator) throw new Error("Local mode needs a configured operator. Run npm run setup and npm start, or select sandbox mode.");
  return mode;
}
