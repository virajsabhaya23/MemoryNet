import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile,realpath} from "node:fs/promises";
import {isAbsolute,posix} from "node:path";
import {z} from "zod";
const exec=promisify(execFile);
const entry=z.object({repository:z.string().regex(/^[\w.-]+\/[\w.-]+$/),path:z.string().refine(isAbsolute,"Use an absolute checkout path"),head:z.string().regex(/^[a-f0-9]{40}$/),origin:z.string(),files:z.number().int().nonnegative(),worktreeComplete:z.literal(true)});
export type Checkout=z.infer<typeof entry>;
export type CheckoutCatalog=ReadonlyMap<string,Checkout>;
const git=async(path:string,...args:string[])=>(await exec("git",["--no-replace-objects","-c","core.hooksPath=/dev/null","-C",path,...args],{encoding:"utf8",maxBuffer:4*1024*1024,timeout:15000})).stdout;
export async function loadCheckoutCatalog(file:string):Promise<CheckoutCatalog>{
 const entries=z.array(entry).parse(JSON.parse(await readFile(file,"utf8")));
 const catalog=new Map<string,Checkout>();
 for(const item of entries){
  const path=await realpath(item.path);
  const origin=(await git(path,"remote","get-url","origin")).trim();
  const head=(await git(path,"rev-parse","HEAD")).trim();
  if(origin!==`https://github.com/${item.repository}.git`||origin!==item.origin||head!==item.head)throw new Error(`Repository identity mismatch: ${item.repository}`);
  if(catalog.has(item.repository))throw new Error("Duplicate repository in checkout catalog");
  catalog.set(item.repository,{...item,path});
 }
 return catalog;
}
export function validateRepositoryPath(path:string):string{
 if(path.length>1024||/[\u0000-\u001f\\:]/.test(path)||path.startsWith("/")||path.split("/").some(part=>part===".."||part==="."))throw new Error("Invalid repository path");
 return path.replace(/\/$/,"");
}
export async function readCheckout(checkout:Checkout,input:string,page=0){
 const path=validateRepositoryPath(input);
 if(!Number.isInteger(page)||page<0||page>10000)throw new Error("Invalid repository page");
 const tree=path?`${checkout.head}:${path}`:checkout.head;
 const type=(await git(checkout.path,"cat-file","-t",tree)).trim();
 if(type==="commit"||type==="tree"){
  const records=(await git(checkout.path,"ls-tree","-z",tree)).split("\0").filter(Boolean).map(line=>{
   const [metadata,name]=line.split("\t");const [mode,kind,sha]=metadata!.split(" ");
   return {name:name!,path:path?`${path}/${name}`:name!,kind:kind!,mode:mode!,sha:sha!};
  }).sort((a,b)=>Number(b.kind==="tree")-Number(a.kind==="tree")||a.name.localeCompare(b.name));
  return {kind:"tree" as const,path,entries:records.slice(page*200,(page+1)*200),total:records.length,page};
 }
 if(type!=="blob")throw new Error("This entry is a Git submodule, not a file");
 const size=Number((await git(checkout.path,"cat-file","-s",tree)).trim());
 if(size>1024*1024)return {kind:"blob" as const,path,size,content:null,note:"File is larger than the 1 MB preview limit. Open it in the local checkout."};
 const content=await git(checkout.path,"cat-file","blob",tree);
 const mode=(await git(checkout.path,"ls-tree",checkout.head,"--",path)).split(" ")[0];
 let linkTarget:string|null=null;
 if(mode==="120000"){
   try{if(!content.trim().startsWith("/"))linkTarget=validateRepositoryPath(posix.normalize(posix.join(posix.dirname(path),content.trim())));}catch{}
 }
 return {kind:"blob" as const,path,size,content:content.includes("\0")?null:content,linkTarget,note:mode==="120000"?`Symbolic link to ${content.trim()}`:content.includes("\0")?"Binary file; open it in the local checkout.":null};
}
