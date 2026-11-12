-- MemoryNet migration 021: reviewed definitions delivered with task context (2026-11-05).
-- A task-context receipt now also names each definition version it delivered: rules, instructions,
-- matching skills and the calling agent's own definition. Like retrieval_items, the rows are
-- append-only and sealed once the receipt is chained at commit.

CREATE TABLE retrieval_definitions (
  retrieval_id uuid NOT NULL REFERENCES retrievals (id),
  position integer NOT NULL CHECK (position > 0),
  definition_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (retrieval_id, position),
  UNIQUE (retrieval_id, definition_id),
  FOREIGN KEY (definition_id, revision) REFERENCES definition_revisions (definition_id, revision)
);
COMMENT ON TABLE retrieval_definitions IS 'Each definition version a retrieval delivered as reviewed guidance, in delivery order. IDs and versions only, never text.';

CREATE TRIGGER retrieval_definitions_append_only
  BEFORE UPDATE OR DELETE ON retrieval_definitions
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_change();
-- seal_retrieval_items only reads NEW.retrieval_id, so it seals these rows the same way.
CREATE TRIGGER retrieval_definitions_sealed BEFORE INSERT ON retrieval_definitions
  FOR EACH ROW EXECUTE FUNCTION seal_retrieval_items();

-- Receipts without definitions keep byte-identical payloads, so every existing chain still verifies.
-- A receipt with definitions appends one element: {"definitions": [[position, definition_id, revision], ...]}.
CREATE OR REPLACE FUNCTION ledger_retrieval_payload(target uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT (jsonb_build_array('retrieval', r.id, r.project_id, r.caller_id, r.search_terms, r.outcome,
    ledger_utc(r.retrieved_at), r.applicability,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(ri.position, ri.memory_id, ri.revision, ri.status) || CASE WHEN NOT ri.generation_sealed OR ri.status_generation IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(ri.status_generation) END ORDER BY ri.position)
              FROM retrieval_items ri WHERE ri.retrieval_id = r.id), '[]'::jsonb))
    || COALESCE((SELECT jsonb_build_array(jsonb_build_object('definitions', jsonb_agg(jsonb_build_array(rd.position, rd.definition_id, rd.revision) ORDER BY rd.position)))
                 FROM retrieval_definitions rd WHERE rd.retrieval_id = r.id HAVING count(*) > 0), '[]'::jsonb))::text
  FROM retrievals r WHERE r.id = target
$$;
