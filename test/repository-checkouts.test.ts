import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,mkdir,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {readCheckout,validateRepositoryPath,loadCheckoutCatalog} from "../src/repository-checkouts.ts";
test("source browser reads pinned Git objects and rejects traversal and origin changes",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"memorynet-checkout-"));
 try{
  const git=(...args:string[])=>execFileSync("git",["-C",dir,...args],{encoding:"utf8"}).trim();
  git("init","-q");await mkdir(join(dir,"src"));await writeFile(join(dir,"README.md"),"Original source\n");await writeFile(join(dir,"src/app.ts"),"export const html = '<script>never execute</script>';\n");
  await symlink("README.md",join(dir,"README.link"));
  git("add",".");git("-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","Fixture source");
  git("remote","add","origin","https://github.com/example-public/source.git");const head=git("rev-parse","HEAD");
  const checkout={repository:"example-public/source",path:dir,head,origin:"https://github.com/example-public/source.git",files:3,worktreeComplete:true as const};
  const file=join(dir,"../",`${head}.json`);await writeFile(file,JSON.stringify([checkout]));
  try{const catalog=await loadCheckoutCatalog(file);assert.equal(catalog.size,1);}finally{await rm(file)}
  const root=await readCheckout(checkout,"");assert.equal(root.kind,"tree");if(root.kind==="tree")assert.deepEqual(root.entries.map(e=>e.name),["src","README.link","README.md"]);
  const link=await readCheckout(checkout,"README.link");if(link.kind==="blob"){assert.equal(link.content,"README.md");assert.equal("linkTarget" in link?link.linkTarget:null,"README.md");}
  const source=await readCheckout(checkout,"src/app.ts");assert.equal(source.kind,"blob");if(source.kind==="blob")assert.match(source.content??"",/never execute/);
  await writeFile(join(dir,"src/app.ts"),"Working copy changed");const pinned=await readCheckout(checkout,"src/app.ts");if(pinned.kind==="blob")assert.match(pinned.content??"",/never execute/,"reads the pinned blob, not changed working files");
  for(const path of ["../secret","src/../../secret","/etc/passwd","src\\secret","HEAD:secret","bad\0file"])assert.throws(()=>validateRepositoryPath(path));
 }finally{await rm(dir,{recursive:true,force:true});}
});
