import {test} from "node:test";
import assert from "node:assert/strict";
import {useTestDatabase} from "./helpers.ts";
import {loadPublicEvidence} from "../src/public-evidence.ts";
import {getNetwork} from "../src/network.ts";
import {listProposals, listMemories} from "../src/knowledge.ts";
import {recordRepositoryAccess} from "../src/repositories.ts";
import {PUBLIC_DATA_FORMAT} from "../src/public-data.ts";
const env=useTestDatabase();
const dataset=()=>({format:PUBLIC_DATA_FORMAT,version:1,downloadedAt:"2026-11-02T12:00:00Z",organizations:["example-public"],repositories:[{id:9876,name:"engine",fullName:"example-public/engine",url:"https://github.com/example-public/engine",description:"Test public export",pullRequests:[{number:1,title:"fix: preserve the request key",body:"Preserve the original key when retrying the request.",url:"https://github.com/example-public/engine/pull/1",mergeCommitSha:"a".repeat(40),mergedAt:"2026-11-01T12:00:00Z",authorKey:"one",labels:["bug"]}]}]});

test("public evidence uses manual capture and pending proposals without fabricated approvals or definitions",async()=>{
 const summary=await loadPublicEvidence(env.ctx,dataset());
 assert.equal(summary.sources,1);assert.equal(summary.proposals,1);assert.equal(summary.approvedMemories,0);
 const project=summary.projects[0]!;
 assert.equal((await listMemories(env.ctx,summary.ownerId,{scope:{level:"project",id:project.id}})).length,0);
 assert.equal((await listProposals(env.ctx,summary.reviewerId,{status:"pending"})).length,1);
 assert.equal((await env.db.query("SELECT id FROM definitions")).rows.length,0);
 const original=await getNetwork(env.ctx,summary.ownerId,summary.organizationId);
 assert.equal(original.nodes.length,0,"uncited source evidence is opt-in");
 const graph=await getNetwork(env.ctx,summary.ownerId,summary.organizationId,{includeUncitedSources:true});
 assert.equal(graph.nodes.length,1);assert.equal(graph.nodes[0]!.kind,"source");
 assert.equal((graph.nodes[0]!.details as {captureMethod:string}).captureMethod,"manual");
 assert.equal(graph.edges.length,0,"a merge is not a manufactured decision relationship");
 await recordRepositoryAccess(env.ctx,{principalId:summary.reviewerId,provider:"github",externalRepositoryId:"9876",canRead:false});
 assert.equal((await getNetwork(env.ctx,summary.reviewerId,summary.organizationId,{includeUncitedSources:true})).nodes.length,0,"unreadable evidence is absent from the graph");
 const count=(await env.db.query("SELECT id FROM principals")).rows.length;
 await assert.rejects(loadPublicEvidence(env.ctx,dataset()),/already loaded/);
 assert.equal((await env.db.query("SELECT id FROM principals")).rows.length,count,"duplicate import creates no extra identities");
});

test("a cross-repository source URL is refused before the import writes anything",async()=>{
 const input=dataset();input.repositories[0]!.pullRequests[0]!.url="https://github.com/somewhere/else/pull/1";
 await assert.rejects(loadPublicEvidence(env.ctx,input),/does not match/);
 assert.equal((await env.db.query("SELECT id FROM organizations")).rows.length,0);
 assert.equal((await env.db.query("SELECT id FROM principals")).rows.length,0);
});

test("repository names with dots retain their GitHub identity and use valid local slugs",async()=>{
 const input=dataset();const repo=input.repositories[0]!;
 repo.name="next.js";repo.fullName="example-public/next.js";repo.url="https://github.com/example-public/next.js";
 repo.pullRequests[0]!.url="https://github.com/example-public/next.js/pull/1";
 const result=await loadPublicEvidence(env.ctx,input);
 const project=(await env.db.query<{slug:string;name:string}>("SELECT slug,name FROM projects WHERE id=$1",[result.projects[0]!.id])).rows[0]!;
 assert.equal(project.slug,"next-js");assert.equal(project.name,"example-public/next.js");
});
