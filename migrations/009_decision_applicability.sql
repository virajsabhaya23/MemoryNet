-- Reviewed applicability is bound to the exact proposal/memory revision.
ALTER TABLE repository_connections ADD CONSTRAINT repository_connections_project_id_id_key UNIQUE(project_id,id);
ALTER TABLE memory_proposals ADD COLUMN applicability jsonb, ADD COLUMN applicability_connection_id uuid,
  ADD COLUMN base_status_generation integer;
ALTER TABLE proposal_revisions ADD COLUMN applicability jsonb, ADD COLUMN applicability_connection_id uuid,
  ADD COLUMN base_status_generation integer;
ALTER TABLE memory_revisions ADD COLUMN applicability jsonb, ADD COLUMN applicability_connection_id uuid;
-- Existing histories do not prove which status a pre-upgrade pending proposal
-- observed. Existing memories start at generation1, old targeted proposals at0:
-- approval therefore requires explicit rebase/regeneration instead of guessing.
ALTER TABLE memories ADD COLUMN status_generation integer NOT NULL DEFAULT 1 CHECK(status_generation >= 0);
ALTER TABLE memories ALTER COLUMN status_generation SET DEFAULT 0;
-- This migration runs inside migrate()'s transaction. Existing model-linked
-- proposals are immutable, including new columns. Disable only their two freeze
-- triggers while initializing the newly introduced generation baseline; never
-- alter text, evidence, author identity or existing revision numbers.
ALTER TABLE memory_proposals DISABLE TRIGGER decision_guard_proposal_frozen;
ALTER TABLE proposal_revisions DISABLE TRIGGER decision_guard_versions_frozen;
UPDATE memory_proposals SET base_status_generation=0
  WHERE target_memory_id IS NOT NULL AND base_status_generation IS DISTINCT FROM 0;
UPDATE proposal_revisions pr SET base_status_generation=mp.base_status_generation FROM memory_proposals mp
  WHERE mp.id=pr.proposal_id AND mp.target_memory_id IS NOT NULL
    AND pr.base_status_generation IS DISTINCT FROM mp.base_status_generation;
ALTER TABLE memory_proposals ENABLE TRIGGER decision_guard_proposal_frozen;
ALTER TABLE proposal_revisions ENABLE TRIGGER decision_guard_versions_frozen;

CREATE FUNCTION valid_decision_applicability(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE branch text; first_at timestamptz; last_at timestamptz;
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(value) <> 'object' OR NOT(value ?& ARRAY['repositoryId','branch','validFrom','validUntil'])
    OR (value - ARRAY['repositoryId','branch','validFrom','validUntil']) <> '{}'::jsonb
    OR jsonb_typeof(value->'repositoryId') <> 'string' OR (value->>'repositoryId') !~ '^[1-9][0-9]{0,18}$'
    OR jsonb_typeof(value->'branch') <> 'string' OR jsonb_typeof(value->'validFrom') <> 'string'
    OR jsonb_typeof(value->'validUntil') NOT IN ('string','null') THEN RETURN false; END IF;
  branch := value->>'branch';
  IF length(branch)=0 OR length(branch)>255 OR branch='@' OR branch ~ '[[:space:][:cntrl:]~^:?*\[\\]'
    OR branch LIKE '%..%' OR branch LIKE '%@{%' OR branch LIKE '%//%'
    OR branch ~ '(^|/)\.' OR branch ~ '\.lock(/|$)' OR branch ~ '^[-/]|[/.]$' THEN RETURN false; END IF;
  IF (value->>'validFrom') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN false; END IF;
  first_at := (value->>'validFrom')::timestamptz;
  IF NOT isfinite(first_at) THEN RETURN false; END IF;
  IF value->>'validUntil' IS NOT NULL THEN
    IF (value->>'validUntil') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN false; END IF;
    last_at := (value->>'validUntil')::timestamptz;
    IF NOT isfinite(last_at) OR last_at <= first_at THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
ALTER TABLE memory_proposals ADD CHECK(valid_decision_applicability(applicability)),
  ADD CHECK((applicability IS NULL)=(applicability_connection_id IS NULL)),
  ADD CHECK((target_memory_id IS NULL)=(base_status_generation IS NULL)),
  ADD FOREIGN KEY(project_id,applicability_connection_id) REFERENCES repository_connections(project_id,id);
ALTER TABLE proposal_revisions ADD CHECK(valid_decision_applicability(applicability)),
  ADD CHECK((applicability IS NULL)=(applicability_connection_id IS NULL)),
  ADD FOREIGN KEY(project_id,applicability_connection_id) REFERENCES repository_connections(project_id,id);
ALTER TABLE memory_revisions ADD CHECK(valid_decision_applicability(applicability)),
  ADD CHECK((applicability IS NULL)=(applicability_connection_id IS NULL)),
  ADD FOREIGN KEY(project_id,applicability_connection_id) REFERENCES repository_connections(project_id,id);

CREATE FUNCTION check_decision_scope_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.applicability IS NOT NULL AND NOT EXISTS(SELECT 1 FROM repository_connections rc
    WHERE rc.id=NEW.applicability_connection_id AND rc.project_id=NEW.project_id
      AND rc.provider='github' AND rc.external_repository_id=NEW.applicability->>'repositoryId') THEN
    RAISE EXCEPTION 'Decision applicability repository does not match its project connection';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER proposal_scope_connection BEFORE INSERT OR UPDATE ON memory_proposals FOR EACH ROW EXECUTE FUNCTION check_decision_scope_connection();
CREATE TRIGGER proposal_version_scope_connection BEFORE INSERT OR UPDATE ON proposal_revisions FOR EACH ROW EXECUTE FUNCTION check_decision_scope_connection();
CREATE TRIGGER memory_version_scope_connection BEFORE INSERT OR UPDATE ON memory_revisions FOR EACH ROW EXECUTE FUNCTION check_decision_scope_connection();

CREATE FUNCTION protect_reviewed_proposal_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.applicability IS DISTINCT FROM OLD.applicability
      OR NEW.applicability_connection_id IS DISTINCT FROM OLD.applicability_connection_id
      OR NEW.base_status_generation IS DISTINCT FROM OLD.base_status_generation)
    AND (OLD.status <> 'pending' OR NEW.revision <> OLD.revision+1) THEN
    RAISE EXCEPTION 'Applicability changes require a new pending proposal revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reviewed_proposal_scope BEFORE UPDATE ON memory_proposals FOR EACH ROW EXECUTE FUNCTION protect_reviewed_proposal_scope();
CREATE FUNCTION bind_current_proposal_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.applicability IS NOT NULL OR NEW.base_status_generation IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM proposal_revisions pr WHERE pr.proposal_id=NEW.id AND pr.revision=NEW.revision
      AND pr.applicability IS NOT DISTINCT FROM NEW.applicability
      AND pr.applicability_connection_id IS NOT DISTINCT FROM NEW.applicability_connection_id
      AND pr.base_status_generation IS NOT DISTINCT FROM NEW.base_status_generation) THEN
      RAISE EXCEPTION 'Proposal applicability must match its exact stored revision';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER proposal_scope_revision_binding AFTER INSERT OR UPDATE ON memory_proposals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bind_current_proposal_scope();
CREATE FUNCTION protect_proposal_scope_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.applicability IS NOT NULL OR OLD.base_status_generation IS NOT NULL THEN RAISE EXCEPTION 'Reviewed scope revisions are immutable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (OLD.applicability IS NOT NULL OR NEW.applicability IS NOT NULL
    OR OLD.base_status_generation IS NOT NULL OR NEW.base_status_generation IS NOT NULL) THEN
    RAISE EXCEPTION 'Reviewed scope revisions are immutable';
  END IF;
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM memory_proposals mp WHERE mp.id=NEW.proposal_id AND mp.revision=NEW.revision
    AND mp.applicability IS NOT DISTINCT FROM NEW.applicability
    AND mp.applicability_connection_id IS NOT DISTINCT FROM NEW.applicability_connection_id
    AND mp.base_status_generation IS NOT DISTINCT FROM NEW.base_status_generation) THEN
    RAISE EXCEPTION 'Proposal applicability must match its exact stored revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER proposal_scope_version_immutable BEFORE INSERT OR UPDATE OR DELETE ON proposal_revisions FOR EACH ROW EXECUTE FUNCTION protect_proposal_scope_version();
CREATE FUNCTION bind_approved_decision_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; change_type text; captured_generation integer; captured_revision integer;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.applicability IS DISTINCT FROM OLD.applicability OR NEW.applicability_connection_id IS DISTINCT FROM OLD.applicability_connection_id) THEN
    RAISE EXCEPTION 'Approved decision applicability is immutable';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM proposal_revisions pr WHERE pr.proposal_id=NEW.proposal_id AND pr.revision=NEW.proposal_revision
    AND pr.applicability IS NOT DISTINCT FROM NEW.applicability AND pr.applicability_connection_id IS NOT DISTINCT FROM NEW.applicability_connection_id) THEN
    RAISE EXCEPTION 'Approved applicability must match the exact reviewed proposal revision';
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT mp.target_memory_id, mp.change_kind, pr.base_status_generation, mp.base_revision
      INTO target_id,change_type,captured_generation,captured_revision
      FROM memory_proposals mp JOIN proposal_revisions pr ON pr.proposal_id=mp.id AND pr.revision=NEW.proposal_revision
      WHERE mp.id=NEW.proposal_id;
    IF target_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memories m JOIN memory_revisions mr
      ON mr.memory_id=m.id AND mr.revision=m.current_revision WHERE m.id=target_id
        AND m.current_revision=captured_revision AND m.status_generation=captured_generation
        AND mr.applicability IS NOT DISTINCT FROM NEW.applicability
        AND m.status <> 'superseded' AND NOT(m.status='revoked' AND change_type='restore')) THEN
      RAISE EXCEPTION 'Reviewed change has a stale status/version or incompatible applicability';
    END IF;
  END IF;
  IF NEW.applicability IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM effective_project_roles epr
      WHERE epr.project_id=NEW.project_id AND epr.principal_id=NEW.approved_by AND epr.rank>=3)
    OR NOT EXISTS(SELECT 1 FROM repository_connections rc JOIN repository_access ra
      ON ra.provider=rc.provider AND ra.external_repository_id=rc.external_repository_id
      WHERE rc.id=NEW.applicability_connection_id AND rc.disconnected_at IS NULL
        AND ra.principal_id=NEW.approved_by AND ra.can_read)) THEN
    RAISE EXCEPTION 'Approver needs current project reviewer and repository access';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER approved_decision_scope_binding BEFORE INSERT OR UPDATE ON memory_revisions FOR EACH ROW EXECUTE FUNCTION bind_approved_decision_scope();

ALTER TABLE memories DROP CONSTRAINT memories_status_check;
ALTER TABLE memories ADD CONSTRAINT memories_status_check CHECK(status IN ('approved','suspended','superseded','revoked'));
ALTER TABLE retrieval_items DROP CONSTRAINT retrieval_items_status_check;
ALTER TABLE retrieval_items ADD CONSTRAINT retrieval_items_status_check CHECK(status IN ('approved','suspended','superseded','revoked'));
CREATE FUNCTION protect_decision_status_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN NEW.status_generation := OLD.status_generation+1;
  ELSIF NEW.status_generation IS DISTINCT FROM OLD.status_generation THEN RAISE EXCEPTION 'Status generation is server controlled'; END IF;
  IF OLD.status='revoked' AND NEW.status='approved' AND NOT EXISTS(SELECT 1 FROM memory_status_changes sc
    WHERE sc.memory_id=NEW.id AND sc.to_status='revoked' AND sc.revision<NEW.current_revision) THEN
    RAISE EXCEPTION 'Revoked decisions require a newly reviewed revision';
  END IF;
  IF NEW.status='superseded' AND NEW.superseded_by IS DISTINCT FROM OLD.superseded_by AND NOT EXISTS(
    SELECT 1 FROM memory_revisions original JOIN memories replacement ON replacement.id=NEW.superseded_by
    JOIN memory_revisions revised ON revised.memory_id=replacement.id AND revised.revision=replacement.current_revision
    WHERE original.memory_id=NEW.id AND original.revision=NEW.current_revision
      AND original.applicability IS NOT DISTINCT FROM revised.applicability) THEN
    RAISE EXCEPTION 'Replacement cannot retire a decision with different applicability';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER decision_status_generation BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION protect_decision_status_generation();
ALTER TABLE retrievals ADD COLUMN applicability jsonb;
CREATE INDEX decision_applicability_lookup ON memory_revisions((applicability->>'repositoryId'),(applicability->>'branch')) WHERE applicability IS NOT NULL;
-- Migration008 protects every model-linked proposal column using to_jsonb minus
-- review metadata, so newly added scope/generation columns remain frozen too.
