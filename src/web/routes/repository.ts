import {hasFreshRepositoryAccess} from "../../access.ts";
import {accessFreshSince} from "../../context.ts";
import {NotFoundError} from "../../errors.ts";
import {readCheckout} from "../../repository-checkouts.ts";
import {html,externalLink} from "../html.ts";
import {page,requireUser,type Route} from "../kit.ts";
import {loadProject,projectCrumbs} from "../views.ts";
export const repositoryRoutes:readonly Route[]=[{
 method:"GET",pattern:/^\/projects\/(?<id>[^/]+)\/repository$/,access:"user",
 async handle(rc){
  const user=requireUser(rc);const view=await loadProject(rc,rc.params.id);
  const rows=await rc.ctx.db.query<{full_name:string;external_repository_id:string}>("SELECT full_name,external_repository_id FROM repository_connections WHERE project_id=$1 AND disconnected_at IS NULL",[view.project.id]);
  const repo=rows.rows[0];const checkout=repo?rc.checkouts?.get(repo.full_name):null;
  if(!repo||!checkout||!await hasFreshRepositoryAccess(rc.ctx.db,user.id,"github",repo.external_repository_id,accessFreshSince(rc.ctx)))throw new NotFoundError("Repository checkout not available");
  let data;
  try{data=await readCheckout(checkout,rc.req.query.get("path")??"",Number(rc.req.query.get("page")??0));}catch{throw new NotFoundError("Repository path not found");}
  const base=`/projects/${view.project.id}/repository`;
  const parent=data.path.split("/").slice(0,-1).join("/");
  return page(rc,{title:repo.full_name,crumbs:projectCrumbs(view),body:html`
   <section class="repository-provenance"><h2>Original repository</h2><p>${externalLink(`https://github.com/${repo.full_name}`,repo.full_name)}</p><dl class="facts"><div><dt>Verified origin</dt><dd><code>${checkout.origin}</code></dd></div><div><dt>Pinned commit</dt><dd>${externalLink(`https://github.com/${repo.full_name}/commit/${checkout.head}`,checkout.head)}</dd></div><div><dt>Source checkout</dt><dd>${checkout.files} tracked files. Complete working tree at this commit.</dd></div></dl><p class="hint">Read-only source browser. Files come from Git objects at the pinned commit. No repository code is executed.</p></section>
   <section><div class="section-heading"><h2>${data.path||"Repository files"}</h2>${data.path?html`<a href="${base}?path=${encodeURIComponent(parent)}">Parent directory</a>`:""}</div>
   ${data.kind==="tree"?html`<ul class="repository-files">${data.entries.map(item=>html`<li><a href="${base}?path=${encodeURIComponent(item.path)}"><span>${item.kind==="tree"?"Directory":item.mode==="120000"?"Symbolic link":"File"}</span><strong>${item.name}</strong></a></li>`)}</ul><p class="hint">${data.total} entries.</p>${data.page>0?html`<a href="${base}?path=${encodeURIComponent(data.path)}&page=${data.page-1}">Previous</a>`:""}${(data.page+1)*200<data.total?html`<a href="${base}?path=${encodeURIComponent(data.path)}&page=${data.page+1}">Next</a>`:""}`:html`<p class="hint">${data.size} bytes. ${data.note??""}</p>${"linkTarget" in data && data.linkTarget?html`<p><a href="${base}?path=${encodeURIComponent(data.linkTarget)}">Open linked source file</a></p>`:""}${data.content===null?"":html`<pre class="repository-code"><code>${data.content}</code></pre>`}`}
   </section>`});
 }
}];
