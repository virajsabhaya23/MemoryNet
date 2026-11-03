import {lstat,readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {z} from "zod";
const schema=z.object({dataDir:z.string().min(1),principalId:z.uuid(),login:z.string().regex(/^[\w-]+$/),githubUserId:z.string().regex(/^\d+$/),accessKeyFile:z.string().startsWith("/"),checkoutManifestFile:z.string().startsWith("/")}).strict();
async function privateText(file:string){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error("Prototype credential files must be regular, owner-only files");return readFile(file,"utf8");}
export async function loadPrototypeConfig(file:string){
 const config=schema.parse(JSON.parse(await privateText(file)));
 const key=(await privateText(config.accessKeyFile)).trim();
 if(!/^[A-Za-z0-9_-]{43,128}$/.test(key))throw new Error("Invalid prototype access key");
 return {...config,accessKeyHash:createHash("sha256").update(key).digest("hex")};
}
