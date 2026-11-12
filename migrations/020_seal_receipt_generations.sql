-- Receipts captured after 019 but before this upgrade have the original four-field digest.
-- Do not change their contents or recompute their historical audit chain.
ALTER TABLE retrieval_items ADD COLUMN generation_sealed boolean NOT NULL DEFAULT false;
ALTER TABLE retrieval_items ALTER COLUMN generation_sealed SET DEFAULT true;

-- Keep all historical payloads byte-identical. Seal the lifecycle generation on new pins.
CREATE OR REPLACE FUNCTION ledger_retrieval_payload(target uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array('retrieval', r.id, r.project_id, r.caller_id, r.search_terms, r.outcome,
    ledger_utc(r.retrieved_at), r.applicability,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(ri.position, ri.memory_id, ri.revision, ri.status) || CASE WHEN NOT ri.generation_sealed OR ri.status_generation IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(ri.status_generation) END ORDER BY ri.position)
              FROM retrieval_items ri WHERE ri.retrieval_id = r.id), '[]'::jsonb))::text
  FROM retrievals r WHERE r.id = target
$$;
