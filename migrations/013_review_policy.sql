-- MemoryNet migration 013: project review policy and multi-person approval (2026-11-03).
-- A project may require up to three different reviewers to approve the same exact proposal version
-- before it is published, and may turn off or limit agent-authored proposals. Policy versions and
-- approvals are append-only. A project without a policy keeps the original rule: one reviewer
-- who wrote no version of the proposal. Agents and authors can never approve.

CREATE TABLE project_policy_revisions (
  project_id uuid NOT NULL REFERENCES projects (id),
  revision integer NOT NULL CHECK (revision > 0),
  required_approvals smallint NOT NULL CHECK (required_approvals BETWEEN 1 AND 3),
  agent_proposals boolean NOT NULL,
  agent_pending_limit smallint NOT NULL CHECK (agent_pending_limit BETWEEN 1 AND 500),
  changed_by uuid NOT NULL,
  changer_kind text NOT NULL DEFAULT 'human' CHECK (changer_kind = 'human'),
  changed_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  PRIMARY KEY (project_id, revision),
  FOREIGN KEY (changed_by, changer_kind) REFERENCES principals (id, kind)
);
COMMENT ON TABLE project_policy_revisions IS 'Each version of a project review policy; the highest revision is current. Changed by people only.';

CREATE TABLE proposal_approvals (
  project_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  revision integer NOT NULL,
  reviewer_id uuid NOT NULL,
  reviewer_kind text NOT NULL DEFAULT 'human' CHECK (reviewer_kind = 'human'),
  approved_at timestamptz NOT NULL,
  reason text,
  PRIMARY KEY (proposal_id, revision, reviewer_id),
  FOREIGN KEY (project_id, proposal_id) REFERENCES memory_proposals (project_id, id),
  FOREIGN KEY (proposal_id, revision) REFERENCES proposal_revisions (proposal_id, revision),
  FOREIGN KEY (reviewer_id, reviewer_kind) REFERENCES principals (id, kind)
);
COMMENT ON TABLE proposal_approvals IS 'Each person who approved an exact proposal version. Publication needs as many as the project policy requires; editing creates a version with no approvals.';

-- How many approvals counted when this version was published; null for versions published before this migration,
-- which had exactly one approval: their reviewer.
ALTER TABLE memory_revisions ADD COLUMN approval_count smallint CHECK (approval_count IS NULL OR approval_count BETWEEN 1 AND 3);

-- Earlier publications had exactly one approval: their reviewer.
INSERT INTO proposal_approvals (project_id, proposal_id, revision, reviewer_id, approved_at, reason)
SELECT mr.project_id, mr.proposal_id, mr.proposal_revision, mr.approved_by, mr.approved_at, mp.review_reason
FROM memory_revisions mr JOIN memory_proposals mp ON mp.id = mr.proposal_id;

CREATE FUNCTION reject_policy_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER project_policy_revisions_append_only BEFORE UPDATE OR DELETE ON project_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_policy_change();
CREATE TRIGGER proposal_approvals_append_only BEFORE UPDATE OR DELETE ON proposal_approvals
  FOR EACH ROW EXECUTE FUNCTION reject_policy_change();

CREATE FUNCTION check_proposal_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM memory_proposals WHERE id = NEW.proposal_id AND proposed_by = NEW.reviewer_id)
     OR EXISTS (SELECT 1 FROM proposal_revisions WHERE proposal_id = NEW.proposal_id AND authored_by = NEW.reviewer_id) THEN
    RAISE EXCEPTION 'An author of a proposal version cannot approve the proposal' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memory_proposals WHERE id = NEW.proposal_id AND revision = NEW.revision AND status = 'pending') THEN
    RAISE EXCEPTION 'Only the current version of a pending proposal can be approved' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER proposal_approvals_by_reviewers BEFORE INSERT ON proposal_approvals
  FOR EACH ROW EXECUTE FUNCTION check_proposal_approval();

-- Only approvals whose reviewers still hold the reviewer role and can read every cited source count. The
-- application additionally applies access freshness, applicability and linked-memory checks.
CREATE FUNCTION require_policy_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE needed integer; counting integer;
BEGIN
  SELECT required_approvals INTO needed FROM project_policy_revisions
  WHERE project_id = NEW.project_id ORDER BY revision DESC LIMIT 1;
  needed := COALESCE(needed, 1);
  SELECT count(*) INTO counting FROM proposal_approvals pa
  WHERE pa.proposal_id = NEW.proposal_id AND pa.revision = NEW.proposal_revision
    AND EXISTS (SELECT 1 FROM effective_project_roles epr
                WHERE epr.project_id = NEW.project_id AND epr.principal_id = pa.reviewer_id AND epr.rank >= 3)
    AND NOT EXISTS (SELECT 1 FROM proposal_revision_evidence pre
                    WHERE pre.proposal_id = pa.proposal_id AND pre.revision = pa.revision
                      AND NOT EXISTS (SELECT 1 FROM source_read_access sra
                                      WHERE sra.principal_id = pa.reviewer_id AND sra.source_id = pre.source_id));
  IF NOT EXISTS (SELECT 1 FROM proposal_approvals WHERE proposal_id = NEW.proposal_id
                   AND revision = NEW.proposal_revision AND reviewer_id = NEW.approved_by)
     OR NEW.approval_count IS NULL OR NEW.approval_count < needed OR NEW.approval_count > counting THEN
    RAISE EXCEPTION 'Publication needs % different approvals of this exact version', needed USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_revisions_require_approvals BEFORE INSERT ON memory_revisions
  FOR EACH ROW EXECUTE FUNCTION require_policy_approvals();
