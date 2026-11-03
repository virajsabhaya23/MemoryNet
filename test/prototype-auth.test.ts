import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {useTestDatabase} from "./helpers.ts";
import {createPrincipal} from "../src/members.ts";
import {createApp} from "../src/web/app.ts";
const env=useTestDatabase();
const key="a".repeat(43);
const get=(path:string,cookie?:string)=>({method:"GET",path,query:new URLSearchParams(),headers:{host:"localhost:3050",cookie},body:""});
const post=(body:Record<string,string>,origin="http://localhost:3050")=>({method:"POST",path:"/sign-in",query:new URLSearchParams(),headers:{host:"localhost:3050",origin},body:new URLSearchParams(body).toString()});
test("secured prototype hides identity selection and rejects forged sign-in and fixture endpoints",async()=>{
 const user=await createPrincipal(env.ctx,{kind:"human",displayName:"Actual Operator"});
 const app=createApp(env.ctx,{port:3050,prototype:{principalId:user.id,login:"actual-operator",accessKeyHash:createHash("sha256").update(key).digest("hex")}});
 const login=await app(get("/"));assert.ok(!login.body.includes('name="principalId"'));assert.ok(login.body.includes('name="accessKey"'));
 const nonce=/name="_login" value="([^"]+)"/.exec(login.body)![1]!;
 assert.equal((await app(post({principalId:user.id}))).status,403);
 assert.equal((await app(post({_login:nonce,accessKey:key},"https://attacker.invalid"))).status,403);
 assert.equal((await app(get("/system"))).status,404);
 assert.equal((await app({...post({}),path:"/system/example-data"})).status,404);
 const reply=await app(post({_login:nonce,accessKey:key,principalId:"forged-identity"}));assert.equal(reply.status,303);
 const cookie=reply.headers["Set-Cookie"]!.split(";")[0]!;
 const home=await app(get("/",cookie));assert.equal(home.status,200);assert.ok(home.body.includes("Actual Operator"));assert.ok(!home.body.includes('href="/system"'));assert.ok(!home.body.includes("Switch person"));
});
test("prototype sign-in throttles repeated bad credentials",async()=>{
 const user=await createPrincipal(env.ctx,{kind:"human",displayName:"Operator"});
 const app=createApp(env.ctx,{port:3050,prototype:{principalId:user.id,login:"operator",accessKeyHash:createHash("sha256").update(key).digest("hex")}});
 for(let i=0;i<5;i++)assert.equal((await app(post({accessKey:"wrong"}))).status,403);
 assert.equal((await app(post({accessKey:"wrong"}))).status,429);
});

test("prototype configuration refuses credentials readable by other users",async()=>{
 const {mkdtemp,writeFile,chmod,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");const {loadPrototypeConfig}=await import("../src/web/prototype-config.ts");
 const dir=await mkdtemp(join(tmpdir(),"memorynet-auth-"));
 try{
  const accessKeyFile=join(dir,"key.txt"),file=join(dir,"config.json");await writeFile(accessKeyFile,key,{mode:0o600});
  await writeFile(file,JSON.stringify({dataDir:dir,principalId:"00000000-0000-4000-8000-000000000001",login:"operator",githubUserId:"123",accessKeyFile,checkoutManifestFile:join(dir,"catalog.json")}),{mode:0o600});
  assert.equal((await loadPrototypeConfig(file)).accessKeyHash,createHash("sha256").update(key).digest("hex"));
  await chmod(accessKeyFile,0o644);await assert.rejects(loadPrototypeConfig(file),/owner-only/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
