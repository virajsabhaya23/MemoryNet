import { ValidationError } from "../errors.ts";
import { getMemory, listMemories, type Memory } from "../knowledge.ts";
import { MEMORY_RELATIONS, NO_RELATIONS, type MemoryRelation, type MemoryRelations, type MemoryRelationsInput } from "../relations.ts";
import { NotFoundError } from "../errors.ts";
import { badge, html, type SafeHtml } from "./html.ts";
import { requireUser, type RequestContext } from "./kit.ts";
import { memoryStatusBadge } from "./views.ts";

export const RELATION_LABELS: Readonly<Record<MemoryRelation, string>> = {
  depends_on: "depends on",
  refines: "refines",
  conflicts_with: "conflicts with",
  related: "related to",
};
const LIST_LIMIT = 100;

async function linkedMemories(rc: RequestContext, relations: MemoryRelations): Promise<Map<string, Memory>> {
  const user = requireUser(rc);
  const found = new Map<string, Memory>();
  for (const link of relations.links) {
    const memory = await getMemory(rc.ctx, user.id, link.memoryId).catch((error: unknown) => {
      if (error instanceof NotFoundError) return null;
      throw error;
    });
    if (memory) found.set(memory.id, memory);
  }
  return found;
}

/** The reviewed relations form block. Links you cannot see are not listed and are kept when you save. */
export async function relationFields(
  rc: RequestContext,
  projectId: string,
  value: MemoryRelations = NO_RELATIONS,
  exclude: string | null = null,
): Promise<SafeHtml> {
  const user = requireUser(rc);
  const current = await listMemories(rc.ctx, user.id, { scope: { level: "project", id: projectId }, limit: LIST_LIMIT });
  const linked = await linkedMemories(rc, value);
  const relationOf = new Map(value.links.map((link) => [link.memoryId, link.relation]));
  const choices = [...new Map([...linked.values(), ...current].map((memory) => [memory.id, memory])).values()]
    .filter((memory) => memory.id !== exclude);
  const select = (memory: Memory) => html`<select name="link:${memory.id}" aria-label="Relation to ${memory.title}">
    <option value="">no link</option>
    ${MEMORY_RELATIONS.map((relation) => html`<option value="${relation}" ${relationOf.get(memory.id) === relation ? "selected" : ""}>${RELATION_LABELS[relation]}</option>`)}
  </select>`;
  return html`<fieldset>
    <legend>Relations (optional, reviewed with this version)</legend>
    <input type="hidden" name="relationsForm" value="1" />
    <label>Paths this guidance governs, one per line
      <textarea name="paths" rows="3" maxlength="4200" placeholder="src/api/**&#10;docs/api.md">${value.paths.join("\n")}</textarea></label>
    <p class="hint">Relative repository paths or globs: <code>**</code> spans folders, <code>*</code> stays within one name.
      Agents asking about a matching file receive this guidance first.</p>
    ${choices.length === 0 ? "" : html`<details ${value.links.length > 0 ? "open" : ""}>
      <summary>Link to other memories (${value.links.length} linked)</summary>
      <ul class="relation-choices">
        ${choices.map((memory) => html`<li>${select(memory)} <span>${memory.title}</span> ${memory.status === "approved" ? "" : memoryStatusBadge(memory.status)}</li>`)}
      </ul>
      <p class="hint">New links must point to current memories. Links to memories you cannot read stay as they are.</p>
    </details>`}
  </fieldset>`;
}

/** Undefined when the form had no relations block, so the stored relations stay unchanged. */
export function relationsFromForm(rc: RequestContext): MemoryRelationsInput | undefined {
  if (rc.form.get("relationsForm") !== "1") return undefined;
  const paths = (rc.form.get("paths") ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const links: Array<{ relation: string; memoryId: string }> = [];
  for (const [name, relation] of rc.form) {
    if (!name.startsWith("link:") || relation === "") continue;
    const memoryId = name.slice(5);
    if (!(MEMORY_RELATIONS as readonly string[]).includes(relation)) throw new ValidationError("Choose a listed relation");
    links.push({ relation, memoryId });
  }
  return { paths, links };
}

/** Paths and readable links, with each linked memory's current status. */
export async function relationsView(rc: RequestContext, relations: MemoryRelations, heading = "Relations"): Promise<SafeHtml> {
  if (relations.paths.length === 0 && relations.links.length === 0) return html``;
  const linked = await linkedMemories(rc, relations);
  return html`<section aria-label="${heading}">
    <h3>${heading}</h3>
    ${relations.paths.length === 0 ? "" : html`<p>Governs ${relations.paths.map((path, index) => html`${index > 0 ? ", " : ""}<code>${path}</code>`)}</p>`}
    ${relations.links.length === 0 ? "" : html`<ul class="relations">
      ${relations.links.map((link) => {
        const memory = linked.get(link.memoryId);
        return html`<li>${badge(RELATION_LABELS[link.relation], link.relation === "conflicts_with" ? "warn" : "type")}
          ${memory ? html`<a href="/memories/${memory.id}">${memory.title}</a> ${memoryStatusBadge(memory.status)}` : html`<span class="muted">a memory you cannot read</span>`}</li>`;
      })}
    </ul>`}
  </section>`;
}
