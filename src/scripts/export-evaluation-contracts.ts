import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { AGENT_CONTRACT_SCHEMAS } from "../agent-context/contract.ts";

const folder = new URL("../../docs/contracts/", import.meta.url);
await mkdir(folder, { recursive: true });
for (const [name, schema] of AGENT_CONTRACT_SCHEMAS) {
  await writeFile(new URL(`${name}.schema.json`, folder), `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`);
}
