import { createHash } from "node:crypto";
import { requireCaller, requireRole, resolveScope } from "./access.ts";
import type { MemoryNetContext } from "./context.ts";
import type { Queryable } from "./db.ts";
import { ValidationError } from "./errors.ts";
import { MINIMUM_ROLE } from "./roles.ts";
import { requireId } from "./validation.ts";

export const GENESIS_HASH = "0".repeat(64);
/** Chain for audit events that belong to no organization, such as creating a principal. */
export const SYSTEM_CHAIN_ID = "00000000-0000-0000-0000-000000000000";
const PAGE = 1000;
const MAX_PROBLEMS = 20;

// These expressions mirror migrations 012, 020 and 021 on purpose. Verification recomputes payloads from the
// source rows with SQL owned by this file instead of trusting functions stored in the database.
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const AUDIT_PAYLOAD_SQL = `jsonb_build_array('audit_event', e.id, ${utc("e.occurred_at")}, e.actor_id, e.action,
  e.organization_id, e.project_id, e.target_type, e.target_id, e.reason, e.details)::text`;
// Delivered definitions add one trailing element only when there are any, so earlier payloads keep their bytes.
const RETRIEVAL_PAYLOAD_SQL = `(jsonb_build_array('retrieval', r.id, r.project_id, r.caller_id, r.search_terms, r.outcome,
  ${utc("r.retrieved_at")}, r.applicability,
  COALESCE((SELECT jsonb_agg(jsonb_build_array(ri.position, ri.memory_id, ri.revision, ri.status) || CASE WHEN NOT ri.generation_sealed OR ri.status_generation IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(ri.status_generation) END ORDER BY ri.position)
            FROM retrieval_items ri WHERE ri.retrieval_id = r.id), '[]'::jsonb))
  || COALESCE((SELECT jsonb_build_array(jsonb_build_object('definitions', jsonb_agg(jsonb_build_array(rd.position, rd.definition_id, rd.revision) ORDER BY rd.position)))
               FROM retrieval_definitions rd WHERE rd.retrieval_id = r.id HAVING count(*) > 0), '[]'::jsonb))::text`;
const AUDIT_CHAIN_SQL = `COALESCE(e.organization_id, (SELECT organization_id FROM projects WHERE id = e.project_id), '${SYSTEM_CHAIN_ID}'::uuid)`;

export type LedgerEntryType = "audit_event" | "retrieval";

export interface LedgerCheckpoint {
  chainId: string;
  seq: number;
  hash: string;
}

export interface LedgerChainReport {
  chainId: string;
  entries: number;
  head: LedgerCheckpoint;
  ok: boolean;
  /** At most 20, oldest first. Identifiers only, never content. */
  problems: string[];
}

export interface LedgerReport {
  ok: boolean;
  chains: LedgerChainReport[];
  /** Problems outside a single chain: records that were never chained and unmatched checkpoints. */
  problems: string[];
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function ledgerEntryHash(prevHash: string, seq: number, type: LedgerEntryType, ref: string, payloadHash: string): string {
  return sha256Hex(`${prevHash}:${seq}:${type}:${ref}:${payloadHash}`);
}

const CHECKPOINT = /^mnl1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(0|[1-9][0-9]{0,15})\.([a-f0-9]{64})$/;

/** A compact head to store outside MemoryNet, for example in a ticket, commit or signed message. */
export function formatCheckpoint(checkpoint: LedgerCheckpoint): string {
  return `mnl1.${checkpoint.chainId}.${checkpoint.seq}.${checkpoint.hash}`;
}

export function parseCheckpoint(value: string): LedgerCheckpoint {
  const match = CHECKPOINT.exec(value.trim());
  if (!match) throw new ValidationError("A ledger checkpoint looks like mnl1.<chain UUID>.<sequence>.<64 hex characters>");
  return { chainId: match[1]!, seq: Number(match[2]), hash: match[3]! };
}

/** Current heads, one per chain. Pass chain IDs to limit them. */
export async function ledgerCheckpoints(q: Queryable, chainIds?: readonly string[]): Promise<LedgerCheckpoint[]> {
  const { rows } = await q.query<{ chain_id: string; seq: string; head_hash: string }>(
    `SELECT chain_id, seq::text AS seq, head_hash FROM ledger_heads
     WHERE $1::uuid[] IS NULL OR chain_id = ANY($1::uuid[]) ORDER BY chain_id`,
    [chainIds === undefined ? null : [...chainIds]],
  );
  return rows.map((row) => ({ chainId: row.chain_id, seq: Number(row.seq), hash: row.head_hash }));
}

interface EntryRow {
  seq: string;
  entry_type: LedgerEntryType;
  entry_ref: string;
  payload_hash: string;
  prev_hash: string;
  entry_hash: string;
  payload: string | null;
  source_chain: string | null;
}

async function verifyChain(q: Queryable, head: LedgerCheckpoint, checkpoints: readonly LedgerCheckpoint[]): Promise<LedgerChainReport> {
  const problems: string[] = [];
  const note = (problem: string) => { if (problems.length < MAX_PROBLEMS) problems.push(problem); };
  const wanted = new Map(checkpoints.map((c) => [c.seq, c.hash]));
  let expectedSeq = 1;
  let previousHash = GENESIS_HASH;
  let entries = 0;
  // A malformed reference matches nothing (reported as missing) instead of failing the cast.
  const auditId = `CASE WHEN le.entry_ref ~ '^[0-9]{1,18}$' THEN le.entry_ref::bigint END`;
  const retrievalId = `CASE WHEN le.entry_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN le.entry_ref::uuid END`;
  for (let after = 0; ;) {
    const { rows } = await q.query<EntryRow>(
      `SELECT le.seq::text AS seq, le.entry_type, le.entry_ref, le.payload_hash, le.prev_hash, le.entry_hash,
              CASE le.entry_type
                WHEN 'audit_event' THEN (SELECT ${AUDIT_PAYLOAD_SQL} FROM audit_events e WHERE e.id = ${auditId})
                ELSE (SELECT ${RETRIEVAL_PAYLOAD_SQL} FROM retrievals r WHERE r.id = ${retrievalId})
              END AS payload,
              CASE le.entry_type
                WHEN 'audit_event' THEN (SELECT ${AUDIT_CHAIN_SQL} FROM audit_events e WHERE e.id = ${auditId})
                ELSE (SELECT p.organization_id FROM retrievals r JOIN projects p ON p.id = r.project_id WHERE r.id = ${retrievalId})
              END AS source_chain
       FROM ledger_entries le
       WHERE le.chain_id = $1 AND le.seq > $2
       ORDER BY le.seq
       LIMIT $3`,
      [head.chainId, after, PAGE],
    );
    for (const row of rows) {
      const seq = Number(row.seq);
      const label = `entry ${seq} (${row.entry_type} ${row.entry_ref})`;
      entries++;
      if (seq !== expectedSeq) note(`${label}: expected sequence ${expectedSeq}; an entry is missing`);
      if (row.prev_hash !== previousHash) note(`${label}: does not link to the previous entry`);
      if (row.payload === null) note(`${label}: the chained record no longer exists`);
      else if (sha256Hex(row.payload) !== row.payload_hash) note(`${label}: the chained record was changed`);
      if (row.source_chain !== null && row.source_chain !== head.chainId) note(`${label}: recorded in another organization's chain`);
      const recomputed = ledgerEntryHash(row.prev_hash, seq, row.entry_type, row.entry_ref, row.payload_hash);
      if (recomputed !== row.entry_hash) note(`${label}: entry hash does not match its contents`);
      const checkpoint = wanted.get(seq);
      if (checkpoint !== undefined && checkpoint !== row.entry_hash) note(`entry ${seq}: differs from the recorded checkpoint; the chain was rewritten`);
      wanted.delete(seq);
      expectedSeq = seq + 1;
      previousHash = row.entry_hash;
      after = seq;
    }
    if (rows.length < PAGE) break;
  }
  if (entries !== head.seq || previousHash !== head.hash) note(`head ${head.seq} does not match the last entry`);
  for (const seq of wanted.keys()) {
    if (seq === 0 && wanted.get(0) === GENESIS_HASH) continue;
    note(`checkpoint ${seq}: no such entry; the chain was truncated or rewritten`);
  }
  return { chainId: head.chainId, entries, head, ok: problems.length === 0, problems };
}

/**
 * Recomputes every chain from the source records. Detects changed, deleted, reordered or inserted records,
 * records added with the ledger disabled, and rewrites that contradict a checkpoint recorded earlier.
 * It cannot detect a rewrite of the whole chain unless a checkpoint from before the rewrite is supplied.
 */
export async function verifyLedger(
  q: Queryable,
  options: { chainIds?: readonly string[]; checkpoints?: readonly LedgerCheckpoint[] } = {},
): Promise<LedgerReport> {
  const heads = await ledgerCheckpoints(q, options.chainIds);
  const checkpoints = options.checkpoints ?? [];
  const problems: string[] = [];
  const chains: LedgerChainReport[] = [];
  for (const head of heads) {
    chains.push(await verifyChain(q, head, checkpoints.filter((c) => c.chainId === head.chainId)));
  }
  for (const checkpoint of checkpoints) {
    if (!heads.some((head) => head.chainId === checkpoint.chainId)) problems.push(`checkpoint for chain ${checkpoint.chainId}: chain not found`);
  }
  const unchained = await q.query<{ kind: string; ref: string }>(
    `SELECT 'audit_event' AS kind, e.id::text AS ref FROM audit_events e
     WHERE ($1::uuid[] IS NULL OR ${AUDIT_CHAIN_SQL} = ANY($1::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.entry_type = 'audit_event' AND le.entry_ref = e.id::text)
     UNION ALL
     SELECT 'retrieval', r.id::text FROM retrievals r JOIN projects p ON p.id = r.project_id
     WHERE ($1::uuid[] IS NULL OR p.organization_id = ANY($1::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.entry_type = 'retrieval' AND le.entry_ref = r.id::text)
     LIMIT ${MAX_PROBLEMS}`,
    [options.chainIds === undefined ? null : [...options.chainIds]],
  );
  for (const row of unchained.rows) problems.push(`${row.kind} ${row.ref}: recorded without a ledger entry`);
  return { ok: problems.length === 0 && chains.every((chain) => chain.ok), chains, problems };
}

/** One organization's chain, for its administrators and owners. The report holds identifiers and digests only. */
export async function verifyOrganizationLedger(
  ctx: MemoryNetContext,
  callerId: string,
  input: { organizationId: string; checkpoint?: string },
): Promise<LedgerReport> {
  const organizationId = requireId(input.organizationId, "organizationId");
  const checkpoint = input.checkpoint === undefined || input.checkpoint.trim() === "" ? null : parseCheckpoint(input.checkpoint);
  if (checkpoint && checkpoint.chainId !== organizationId) throw new ValidationError("That checkpoint belongs to another chain");
  const caller = await requireCaller(ctx.db, callerId);
  const scope = await resolveScope(ctx.db, { level: "organization", id: organizationId });
  await requireRole(ctx.db, caller, scope, MINIMUM_ROLE.verifyLedger, "verify the audit ledger");
  return verifyLedger(ctx.db, { chainIds: [organizationId], checkpoints: checkpoint ? [checkpoint] : [] });
}
