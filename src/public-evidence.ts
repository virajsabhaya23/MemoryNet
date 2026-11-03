/** Public GitHub evidence import. No invented people, definitions, or automatic approvals. */
import { z } from "zod";
import type { MemoryNetContext } from "./context.ts";
import { ConflictError } from "./errors.ts";
import { createPrincipal, assignRole } from "./members.ts";
import { createOrganization, createBusinessUnit, createProject } from "./organizations.ts";
import { connectRepository, recordRepositoryAccess } from "./repositories.ts";
import { recordSource, proposeMemory } from "./knowledge.ts";
import { removeSecrets } from "./content-checks.ts";
import { PUBLIC_DATA_FORMAT, memoryTypeOf, memoryTitleOf, summaryOf, scrubPublicText } from "./public-data.ts";

const projectSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,63).replace(/-$/,"");
const ownerName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
const pullSchema = z.object({
  number: z.number().int().positive(), title: z.string().min(1), body: z.string(),
  url: z.url(), mergeCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  mergedAt: z.iso.datetime(), authorKey: z.string(), labels: z.array(z.string()),
});
const schema = z.object({
  format: z.literal(PUBLIC_DATA_FORMAT), version: z.literal(1), downloadedAt: z.iso.datetime(),
  organizations: z.array(ownerName).length(1),
  repositories: z.array(z.object({
    id: z.number().int().positive(), name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    fullName: z.string(), url: z.url(), description: z.string(),
    pullRequests: z.array(pullSchema).max(200),
  })).min(1).max(100),
}).superRefine((data, ctx) => {
  const ids = new Set<number>(), names = new Set<string>(), slugs = new Set<string>();
  for (const repo of data.repositories) {
    if (repo.fullName !== `${data.organizations[0]}/${repo.name}` || repo.url !== `https://github.com/${repo.fullName}` || ids.has(repo.id) || names.has(repo.fullName) || !projectSlug(repo.name) || slugs.has(projectSlug(repo.name))) {
      ctx.addIssue({code:"custom",message:"Repositories must be unique and belong to the selected public organization"});
    }
    ids.add(repo.id); names.add(repo.fullName); slugs.add(projectSlug(repo.name));
    const numbers = new Set<number>();
    for (const pull of repo.pullRequests) {
      if (pull.url !== `https://github.com/${repo.fullName}/pull/${pull.number}` || numbers.has(pull.number)) ctx.addIssue({code:"custom",message:"Pull request URL or number does not match its repository"});
      numbers.add(pull.number);
    }
  }
});

export async function loadPublicEvidence(ctx: MemoryNetContext, input: unknown) {
  const data = schema.parse(input);
  const upstream = data.organizations[0]!;
  const slug = `${upstream.toLowerCase()}-evidence`;
  if ((await ctx.db.query("SELECT id FROM organizations WHERE slug=$1",[slug])).rows.length) {
    throw new ConflictError("This evidence snapshot is already loaded. Refresh into a new database to preserve reviews and source revisions.");
  }
  const owner = await createPrincipal(ctx,{kind:"human",displayName:`${upstream}: local workspace owner`});
  const reviewer = await createPrincipal(ctx,{kind:"human",displayName:`${upstream}: local evidence reviewer`});
  const importer = await createPrincipal(ctx,{kind:"agent",displayName:`${upstream}: public PR importer`});
  const organization = await createOrganization(ctx,owner.id,{slug,name:`${upstream} (public GitHub snapshot)`});
  const scope = {level:"organization" as const,id:organization.id};
  await assignRole(ctx,owner.id,{principalId:reviewer.id,scope,role:"reviewer"});
  await assignRole(ctx,owner.id,{principalId:importer.id,scope,role:"contributor"});
  const unit = await createBusinessUnit(ctx,owner.id,{organizationId:organization.id,slug:"public-repositories",name:"Public repository collection"});
  const projects=[];
  let sources=0, proposals=0;
  for (const repo of data.repositories) {
    const project=await createProject(ctx,owner.id,{businessUnitId:unit.id,slug:projectSlug(repo.name),name:repo.fullName});
    await connectRepository(ctx,owner.id,{projectId:project.id,provider:"github",externalRepositoryId:String(repo.id),fullName:repo.fullName});
    for(const who of [owner,reviewer,importer]) await recordRepositoryAccess(ctx,{principalId:who.id,provider:"github",externalRepositoryId:String(repo.id),canRead:true});
    let candidates=0;
    for(const pull of repo.pullRequests){
      const excerpt=removeSecrets(scrubPublicText(`${pull.title}\n\nMerged upstream: ${pull.mergedAt}\n\n${pull.body}`)).text.slice(0,4000);
      const source=await recordSource(ctx,owner.id,{projectId:project.id,provider:"github",externalRepositoryId:String(repo.id),reference:`pull/${pull.number}`,url:pull.url,revision:pull.mergeCommitSha,excerpt});
      sources++;
      const type=memoryTypeOf(pull) ?? (repo.name === "enhancements" ? "rationale" : null);
      if(type===null) continue;
      await proposeMemory(ctx,importer.id,{projectId:project.id,type,title:memoryTitleOf(pull),ownerId:owner.id,evidenceSourceIds:[source.id],content:removeSecrets(`Imported candidate from ${pull.url}\nMerge commit: ${pull.mergeCommitSha}\nMerged upstream: ${pull.mergedAt}\n\n${summaryOf(pull)}\n\nThis is an automatically selected public-source candidate. A local reviewer must establish its meaning and current applicability before approval. Upstream merge does not establish local approval.`).text});
      proposals++; candidates++;
    }
    projects.push({id:project.id,repository:repo.fullName,sources:repo.pullRequests.length,candidates});
  }
  return {organizationId:organization.id,ownerId:owner.id,reviewerId:reviewer.id,importerId:importer.id,projects,sources,proposals,approvedMemories:0,definitions:0,downloadedAt:data.downloadedAt,networkUrl:`/orgs/${organization.id}/network?evidence=all`,boundary:"Public GitHub snapshot; locally assigned roles; manual source capture; no upstream membership claim and no automatic approvals."};
}
