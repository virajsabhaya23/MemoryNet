import { readFile } from "node:fs/promises";
import { createContext } from "../context.ts";
import { migrate, openDatabase } from "../db.ts";
import { loadPublicEvidence } from "../public-evidence.ts";
const file=process.argv[2];
if(!file) throw new Error("Usage: npm run data:import:evidence -- dataset.json (set MEMORYNET_DATA_DIR to a separate local directory)");
if(!process.env.MEMORYNET_DATA_DIR) throw new Error("Set MEMORYNET_DATA_DIR explicitly; this import must not replace your default workspace.");
const input=JSON.parse(await readFile(file,"utf8"));
const db=await openDatabase(process.env.MEMORYNET_DATA_DIR);
try {await migrate(db); const summary=await loadPublicEvidence(createContext(db,{repositoryAccessMaxAgeMs:30*24*60*60*1000}),input);await db.exec("ANALYZE");console.log(JSON.stringify(summary,null,2));}finally{await db.close();}
