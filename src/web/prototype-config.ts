import {lstat,readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {isAbsolute} from "node:path";
import {z} from "zod";
const absolute=z.string().refine(isAbsolute,"Use an absolute path");
const schema=z.object({dataDir:z.string().min(1),principalId:z.uuid(),login:z.string().regex(/^[\w-]+$/),githubUserId:z.string().regex(/^\d+$/),accessKeyFile:absolute.optional(),checkoutManifestFile:absolute}).strict();
// Windows has no POSIX mode bits; files under the user's profile rely on its owner-only ACLs, as for agent bindings.
async function privateText(file:string){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||(process.platform!=="win32"&&(info.mode&0o077)!==0))throw new Error("Prototype credential files must be regular, owner-only files");return readFile(file,"utf8");}
export async function loadPrototypeConfig(file:string, requireAccessKey=true){
 const config=schema.parse(JSON.parse(await privateText(file)));
 if(!requireAccessKey)return {...config,accessKeyHash:undefined};
 if(!config.accessKeyFile)throw new Error("Access-key sign-in requires an accessKeyFile in the prototype configuration");
 const key=(await privateText(config.accessKeyFile)).trim();
 if(!/^[A-Za-z0-9_-]{43,128}$/.test(key))throw new Error("Invalid prototype access key");
 return {...config,accessKeyHash:createHash("sha256").update(key).digest("hex")};
}
