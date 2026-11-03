import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { AgentContextSchema, AgentQuerySchema } from "../agent-context/contract.ts";

const folder = new URL("../../docs/contracts/", import.meta.url);
await mkdir(folder, { recursive: true });
for (const [name, schema] of [["agent-query-v1", AgentQuerySchema], ["agent-context-v1", AgentContextSchema]] as const) {
  await writeFile(new URL(`${name}.schema.json`, folder), `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`);
}
