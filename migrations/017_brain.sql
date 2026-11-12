-- MemoryNet migration 017: brain briefs (2026-11-04).
-- A brain brief is a labeled AI synthesis of a project's current approved
-- memories. It is never knowledge: it lives in its own append-only table,
-- is excluded from search and context export, and cites memory ids inline.

CREATE TABLE brain_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  requester_id uuid NOT NULL REFERENCES principals(id),
  agent_id uuid NOT NULL REFERENCES principals(id),
  model text NOT NULL,
  content text NOT NULL CHECK (length(content) > 0 AND length(content) <= 20000),
  citations jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(citations) = 'array'),
  created_at timestamptz NOT NULL
);

CREATE INDEX brain_briefs_project_created ON brain_briefs(project_id, created_at DESC);

CREATE FUNCTION reject_brain_brief_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Brain briefs are append-only';
END;
$$;

CREATE TRIGGER brain_briefs_immutable BEFORE UPDATE OR DELETE ON brain_briefs
  FOR EACH ROW EXECUTE FUNCTION reject_brain_brief_change();
