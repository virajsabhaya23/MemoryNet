/** Minimal flag parsing for the setup commands: --name value, repeated flags, and boolean switches. */
export function parseFlags(argv: readonly string[], spec: { values: readonly string[]; lists?: readonly string[]; switches?: readonly string[] }) {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (name !== null && spec.switches?.includes(name)) { switches.add(name); continue; }
    const value = argv[i + 1];
    if (name === null || value === undefined || value.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    if (spec.lists?.includes(name)) lists.set(name, [...(lists.get(name) ?? []), value]);
    else if (spec.values.includes(name)) values.set(name, value);
    else throw new Error(`Unknown option: --${name}`);
    i++;
  }
  return { value: (name: string) => values.get(name), list: (name: string) => lists.get(name) ?? [], has: (name: string) => switches.has(name) };
}
