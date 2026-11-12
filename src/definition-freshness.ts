import type { DefinitionLink } from "./definitions.ts";
import type { Memory, MemoryStatus } from "./knowledge.ts";

/** A decision a definition version is based on that changed after that version was approved. */
export interface BasedOnChange {
  memoryId: string;
  title: string;
  status: MemoryStatus;
  /** The memory's current revision. */
  revision: number;
  /** revised: a newer version was approved; otherwise the memory's new status. */
  change: "revised" | Exclude<MemoryStatus, "approved">;
  /** When it changed: the newer version's approval or the status change. */
  changedAt: Date | null;
  /** The memory that replaced it, when it was superseded. */
  replacedBy: string | null;
}

/**
 * Which `based_on` decisions changed after a definition version was approved. Pure: pass only memories the caller
 * may already read, so an unreadable link is skipped rather than revealed. Approval refuses links to knowledge that
 * is not current, so any status other than approved means the decision changed after the definition did.
 */
export function basedOnChanges(
  definition: { links: readonly DefinitionLink[]; approvedAt: Date },
  readable: ReadonlyMap<string, Memory>,
): BasedOnChange[] {
  const changes: BasedOnChange[] = [];
  const seen = new Set<string>();
  for (const link of definition.links) {
    if (link.relation !== "based_on" || seen.has(link.targetId)) continue;
    seen.add(link.targetId);
    const memory = readable.get(link.targetId);
    if (!memory) continue;
    if (memory.status !== "approved") {
      changes.push({
        memoryId: memory.id,
        title: memory.title,
        status: memory.status,
        revision: memory.revision,
        change: memory.status,
        changedAt: memory.statusChangedAt,
        replacedBy: memory.supersededBy,
      });
    } else if (memory.approvedAt.getTime() > definition.approvedAt.getTime()) {
      changes.push({
        memoryId: memory.id,
        title: memory.title,
        status: memory.status,
        revision: memory.revision,
        change: "revised",
        changedAt: memory.approvedAt,
        replacedBy: null,
      });
    }
  }
  return changes;
}
