-- Model output is an immutable review draft, never authoritative memory.
CREATE TABLE decision_guard_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  requester_id uuid NOT NULL,
  requester_kind text NOT NULL DEFAULT 'human' CHECK (requester_kind = 'human'),
  agent_id uuid NOT NULL,
  agent_kind text NOT NULL DEFAULT 'agent' CHECK (agent_kind = 'agent'),
  created_at timestamptz NOT NULL,
  extraction jsonb NOT NULL CHECK (jsonb_typeof(extraction) = 'object' AND extraction->>'reviewState' = 'unreviewed'),
  source_records jsonb NOT NULL CHECK (jsonb_typeof(source_records) = 'array'),
  decision_records jsonb NOT NULL CHECK (jsonb_typeof(decision_records) = 'array'),
  UNIQUE(project_id, id),
  FOREIGN KEY(requester_id, requester_kind) REFERENCES principals(id, kind),
  FOREIGN KEY(agent_id, agent_kind) REFERENCES principals(id, kind)
);

-- Includes original conflict-decision evidence so historical snapshots cannot
-- become readable merely because the decision later changes its source set.
CREATE TABLE decision_guard_run_sources (
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  source_id uuid NOT NULL,
  PRIMARY KEY(run_id, source_id),
  FOREIGN KEY(project_id, run_id) REFERENCES decision_guard_runs(project_id, id),
  FOREIGN KEY(project_id, source_id) REFERENCES sources(project_id, id)
);

CREATE TABLE decision_guard_publications (
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  candidate_index integer NOT NULL CHECK (candidate_index >= 0 AND candidate_index < 6),
  kind text NOT NULL CHECK (kind IN ('new', 'replace')),
  target_memory_id uuid,
  proposal_id uuid NOT NULL UNIQUE,
  proposal_revision integer NOT NULL CHECK (proposal_revision > 0),
  requested_by uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(run_id, candidate_index),
  FOREIGN KEY(project_id, run_id) REFERENCES decision_guard_runs(project_id, id),
  FOREIGN KEY(project_id, target_memory_id) REFERENCES memories(project_id, id),
  FOREIGN KEY(project_id, proposal_id) REFERENCES memory_proposals(project_id, id),
  FOREIGN KEY(proposal_id, proposal_revision) REFERENCES proposal_revisions(proposal_id, revision),
  CHECK ((kind = 'replace') = (target_memory_id IS NOT NULL))
);

CREATE FUNCTION reject_decision_guard_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Decision Guard provenance is append-only';
END;
$$;
CREATE TRIGGER decision_guard_runs_immutable BEFORE UPDATE OR DELETE ON decision_guard_runs
  FOR EACH ROW EXECUTE FUNCTION reject_decision_guard_change();
CREATE TRIGGER decision_guard_sources_immutable BEFORE UPDATE OR DELETE ON decision_guard_run_sources
  FOR EACH ROW EXECUTE FUNCTION reject_decision_guard_change();
CREATE TRIGGER decision_guard_publications_immutable BEFORE UPDATE OR DELETE ON decision_guard_publications
  FOR EACH ROW EXECUTE FUNCTION reject_decision_guard_change();

-- A model-linked proposal is reviewed as generated. Editing it could silently
-- drop an uncited context dependency while retaining derived private content.
-- Human review may change status/review metadata, never the proposed version.
CREATE FUNCTION protect_decision_guard_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM decision_guard_publications WHERE proposal_id = OLD.id)
     AND (to_jsonb(NEW) - ARRAY['status','reviewed_by','reviewed_at','review_reason','memory_id'])
       IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status','reviewed_by','reviewed_at','review_reason','memory_id']) THEN
    RAISE EXCEPTION 'Model-derived proposal content and dependencies are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER decision_guard_proposal_frozen BEFORE UPDATE ON memory_proposals
  FOR EACH ROW EXECUTE FUNCTION protect_decision_guard_proposal();

CREATE FUNCTION protect_decision_guard_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN target_id := OLD.proposal_id;
  ELSE target_id := NEW.proposal_id;
  END IF;
  IF EXISTS (SELECT 1 FROM decision_guard_publications WHERE proposal_id = target_id) THEN
    RAISE EXCEPTION 'Model-derived proposal content and dependencies are immutable';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (SELECT 1 FROM decision_guard_publications WHERE proposal_id = OLD.proposal_id) THEN
      RAISE EXCEPTION 'Model-derived proposal content and dependencies are immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER decision_guard_evidence_frozen BEFORE INSERT OR UPDATE OR DELETE ON proposal_evidence
  FOR EACH ROW EXECUTE FUNCTION protect_decision_guard_dependencies();
CREATE TRIGGER decision_guard_version_evidence_frozen BEFORE INSERT OR UPDATE OR DELETE ON proposal_revision_evidence
  FOR EACH ROW EXECUTE FUNCTION protect_decision_guard_dependencies();
CREATE TRIGGER decision_guard_versions_frozen BEFORE INSERT OR UPDATE OR DELETE ON proposal_revisions
  FOR EACH ROW EXECUTE FUNCTION protect_decision_guard_dependencies();
