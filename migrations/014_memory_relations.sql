-- MemoryNet migration 014: reviewed relations between memories and the paths they govern (2026-11-03).
-- A proposal version may name repository paths (globs such as src/api/**) that its guidance governs,
-- and links to other memories in the same project: depends_on, refines, conflicts_with or related.
-- Both are part of the exact version a reviewer approves and are copied to the published version.
-- A link is never an access grant: readers see and traverse only memories they may already read.

CREATE FUNCTION valid_memory_relations(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; path text; seen text[] := '{}';
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(value) <> 'object' OR NOT (value ?& ARRAY['paths', 'links'])
     OR (value - ARRAY['paths', 'links']) <> '{}'::jsonb
     OR jsonb_typeof(value->'paths') <> 'array' OR jsonb_typeof(value->'links') <> 'array'
     OR jsonb_array_length(value->'paths') > 20 OR jsonb_array_length(value->'links') > 20
     OR (jsonb_array_length(value->'paths') = 0 AND jsonb_array_length(value->'links') = 0) THEN
    RETURN false;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value->'paths') LOOP
    IF jsonb_typeof(item) <> 'string' THEN RETURN false; END IF;
    path := item #>> '{}';
    IF length(path) < 1 OR length(path) > 200 OR path !~ '^[A-Za-z0-9._@+~*?/ -]+$'
       OR path LIKE '/%' OR path ~ '(^|/)\.\.?(/|$)' OR path LIKE '%//%' OR path = ANY(seen)
       OR length(regexp_replace(path, '[^*?]', '', 'g')) > 8 THEN
      RETURN false;
    END IF;
    seen := seen || path;
  END LOOP;
  seen := '{}';
  FOR item IN SELECT * FROM jsonb_array_elements(value->'links') LOOP
    IF jsonb_typeof(item) <> 'object' OR NOT (item ?& ARRAY['relation', 'memoryId'])
       OR (item - ARRAY['relation', 'memoryId']) <> '{}'::jsonb
       OR item->>'relation' NOT IN ('depends_on', 'refines', 'conflicts_with', 'related')
       OR jsonb_typeof(item->'memoryId') <> 'string'
       OR (item->>'memoryId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (item->>'memoryId') = ANY(seen) THEN
      RETURN false;
    END IF;
    seen := seen || (item->>'memoryId');
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

ALTER TABLE memory_proposals ADD COLUMN relations jsonb CHECK (valid_memory_relations(relations));
ALTER TABLE proposal_revisions ADD COLUMN relations jsonb CHECK (valid_memory_relations(relations));
ALTER TABLE memory_revisions ADD COLUMN relations jsonb CHECK (valid_memory_relations(relations));
COMMENT ON COLUMN memory_revisions.relations IS 'Reviewed paths this version governs and links to other memories in the project; null when none.';

-- Relations are bound to the exact reviewed version, like applicability (migration 009).
CREATE FUNCTION bind_reviewed_relations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'memory_proposals' THEN
    IF NEW.relations IS DISTINCT FROM OLD.relations AND (OLD.status <> 'pending' OR NEW.revision <> OLD.revision + 1) THEN
      RAISE EXCEPTION 'Relation changes require a new pending proposal revision';
    END IF;
  ELSIF TG_TABLE_NAME = 'proposal_revisions' THEN
    IF TG_OP = 'UPDATE' AND NEW.relations IS DISTINCT FROM OLD.relations THEN
      RAISE EXCEPTION 'Reviewed relations are immutable';
    END IF;
    IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM memory_proposals mp WHERE mp.id = NEW.proposal_id
         AND mp.revision = NEW.revision AND mp.relations IS NOT DISTINCT FROM NEW.relations) THEN
      RAISE EXCEPTION 'Proposal relations must match its exact stored revision';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.relations IS DISTINCT FROM OLD.relations THEN
      RAISE EXCEPTION 'Approved relations are immutable';
    END IF;
    IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM proposal_revisions pr WHERE pr.proposal_id = NEW.proposal_id
         AND pr.revision = NEW.proposal_revision AND pr.relations IS NOT DISTINCT FROM NEW.relations) THEN
      RAISE EXCEPTION 'Approved relations must match the exact reviewed proposal revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reviewed_proposal_relations BEFORE UPDATE ON memory_proposals
  FOR EACH ROW EXECUTE FUNCTION bind_reviewed_relations();
CREATE TRIGGER proposal_revision_relations BEFORE INSERT OR UPDATE ON proposal_revisions
  FOR EACH ROW EXECUTE FUNCTION bind_reviewed_relations();
CREATE TRIGGER memory_revision_relations BEFORE INSERT OR UPDATE ON memory_revisions
  FOR EACH ROW EXECUTE FUNCTION bind_reviewed_relations();

-- Links stay inside the project and never point at the memory itself (or at the memory a change targets).
CREATE FUNCTION check_memory_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE own uuid;
BEGIN
  IF NEW.relations IS NULL THEN RETURN NEW; END IF;
  -- Branches, not CASE: a record field is resolved even in an untaken CASE arm.
  IF TG_TABLE_NAME = 'memory_revisions' THEN own := NEW.memory_id;
  ELSIF TG_TABLE_NAME = 'memory_proposals' THEN own := NEW.target_memory_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.relations->'links') link
    WHERE (link->>'memoryId')::uuid IS NOT DISTINCT FROM own
       OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = (link->>'memoryId')::uuid AND m.project_id = NEW.project_id)) THEN
    RAISE EXCEPTION 'Memory links must point to another memory in the same project' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_proposal_links BEFORE INSERT OR UPDATE OF relations ON memory_proposals
  FOR EACH ROW EXECUTE FUNCTION check_memory_links();
CREATE TRIGGER proposal_revision_links BEFORE INSERT ON proposal_revisions
  FOR EACH ROW EXECUTE FUNCTION check_memory_links();
CREATE TRIGGER memory_revision_links BEFORE INSERT ON memory_revisions
  FOR EACH ROW EXECUTE FUNCTION check_memory_links();

-- Finds every memory version linking to a given memory without scanning all relations.
CREATE INDEX memory_revisions_relations ON memory_revisions USING gin (relations jsonb_path_ops) WHERE relations IS NOT NULL;
