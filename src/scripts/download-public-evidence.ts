// Read-only public GitHub snapshot. Uses gh's existing login; never writes to GitHub.
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname} from "node:path";
import {PUBLIC_DATA_FORMAT,scrubPublicText,type PublicRepository} from "../public-data.ts";
const args=process.argv.slice(2);
const option=(name:string,fallback:string)=>{const at=args.indexOf(name);return at<0?fallback:args[at+1]??fallback;};
const owner=option("--owner","kubernetes");
const names=option("--repos","kubernetes,enhancements,community,client-go,apimachinery,api,kubectl,kubeadm,kubelet,sample-controller,sample-apiserver,metrics").split(",");
const limit=Number(option("--prs","100"));
if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)||!Number.isInteger(limit)||limit<1||limit>200||names.length>100||names.some(n=>!/^[-A-Za-z0-9_.]+$/.test(n)))throw new Error("Provide a valid owner, comma-separated repository names, and --prs from 1 to 200");
const out=option("--out",`.data/public/${owner}-evidence.json`);
function api(path:string):any {return JSON.parse(execFileSync("gh",["api",path],{encoding:"utf8",maxBuffer:32*1024*1024,stdio:["ignore","pipe","pipe"]}));}
const repositories:PublicRepository[]=[];
const notes:string[]=[];
for(const name of names){
 const repo=api(`/repos/${owner}/${name}`);
 if(repo.private!==false||repo.archived){notes.push(`${repo.full_name}: skipped; not an active public repository`);continue;}
 const found:any[]=[];
 try {for(let page=1;page<=4;page++){
   const batch=api(`/repos/${repo.full_name}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
   found.push(...batch.filter((p:any)=>p.merged_at&&p.merge_commit_sha));
   if(found.length>=limit||batch.length<100)break;
 }}catch(error){
   const stderr=String((error as {stderr?:unknown}).stderr??"");
   if(!stderr.includes("HTTP 404"))throw error;
   notes.push(`${repo.full_name}: pull requests unavailable; repository metadata retained`);
 }
 const pulls=found.slice(0,limit);
 repositories.push({id:repo.id,name:repo.name,fullName:repo.full_name,description:repo.description??"",url:repo.html_url,language:repo.language,topics:repo.topics??[],pullRequests:pulls.map((p:any)=>({number:p.number,title:scrubPublicText(p.title).slice(0,300),body:scrubPublicText(p.body??"").slice(0,3800),url:p.html_url,mergeCommitSha:p.merge_commit_sha,mergedAt:p.merged_at,authorKey:createHash("sha256").update(`memorynet:${p.user?.login??"unknown"}`).digest("hex").slice(0,12),labels:p.labels.map((l:any)=>l.name)}))});
 console.log(`${repo.full_name}: ${pulls.length} merged PRs`);
}
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,JSON.stringify({format:PUBLIC_DATA_FORMAT,version:1,downloadedAt:new Date().toISOString(),organizations:[owner],repositories,notes},null,2));
console.log(`Saved ${repositories.length} public repositories to ${out}`);
