-- Retrieval records (development plan Step 3): what MemoryNet returned, to whom, and when.
-- IDs, versions, and statuses only, plus the normalized search terms; never memory text or the typed query.

CREATE TABLE retrievals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  caller_id uuid NOT NULL REFERENCES principals (id),
  search_terms text,
  outcome text NOT NULL CHECK (outcome IN ('results', 'no_results', 'failed')),
  retrieved_at timestamptz NOT NULL
);
COMMENT ON TABLE retrievals IS 'One search or context request. outcome results means current guidance was supplied; no_results means none was (not-current matches may still be listed); failed means nothing was searched. search_terms is null when the typed text may hold personal data.';
CREATE INDEX retrievals_by_project ON retrievals (project_id, retrieved_at DESC);

CREATE TABLE retrieval_items (
  retrieval_id uuid NOT NULL REFERENCES retrievals (id),
  position integer NOT NULL CHECK (position > 0),
  memory_id uuid NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('approved', 'suspended', 'superseded')),
  PRIMARY KEY (retrieval_id, position),
  UNIQUE (retrieval_id, memory_id),
  FOREIGN KEY (memory_id, revision) REFERENCES memory_revisions (memory_id, revision)
);
COMMENT ON TABLE retrieval_items IS 'Each memory version a retrieval returned, with its status then. Approved items were supplied as current guidance with their text; suspended and superseded items were only listed as not current.';

CREATE FUNCTION reject_retrieval_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'retrieval records are append-only';
END;
$$;
CREATE TRIGGER retrievals_append_only
  BEFORE UPDATE OR DELETE ON retrievals
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_change();
CREATE TRIGGER retrieval_items_append_only
  BEFORE UPDATE OR DELETE ON retrieval_items
  FOR EACH ROW EXECUTE FUNCTION reject_retrieval_change();
