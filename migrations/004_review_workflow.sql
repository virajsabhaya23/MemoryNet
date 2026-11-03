-- MemoryNet migration 004: review workflow (2026-09-25).
-- Keeps every version of a proposal. Editing a pending proposal adds a version,
-- and a reviewer approves or rejects one exact version. Anyone who wrote a
-- version is one of its authors and cannot review it. Each approved memory
-- version records which proposal version it came from.
-- Existing proposals become version 1, written by their proposer.

CREATE TABLE proposal_revisions (
  project_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  type text NOT NULL CHECK (type IN ('decision', 'rationale', 'lesson', 'constraint', 'failed_approach', 'incident')),
  title text NOT NULL,
  content text NOT NULL,
  owner_id uuid NOT NULL,
  owner_kind text NOT NULL DEFAULT 'human' CHECK (owner_kind = 'human'),
  content_flags text[] NOT NULL DEFAULT '{}'
    CHECK (content_flags <@ ARRAY['secret_removed', 'personal_data', 'truncated']::text[]),
  authored_by uuid NOT NULL REFERENCES principals (id),
  authored_at timestamptz NOT NULL,
  change_note text,
  PRIMARY KEY (proposal_id, revision),
  FOREIGN KEY (project_id, proposal_id) REFERENCES memory_proposals (project_id, id),
  FOREIGN KEY (owner_id, owner_kind) REFERENCES principals (id, kind)
);
COMMENT ON TABLE proposal_revisions IS 'Every version of a proposal, as written. memory_proposals holds the latest one. authored_by wrote that version and may not review the proposal.';
CREATE INDEX proposal_revisions_by_author ON proposal_revisions (authored_by);

CREATE TABLE proposal_revision_evidence (
  project_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  revision integer NOT NULL,
  source_id uuid NOT NULL,
  PRIMARY KEY (proposal_id, revision, source_id),
  FOREIGN KEY (proposal_id, revision) REFERENCES proposal_revisions (proposal_id, revision),
  FOREIGN KEY (project_id, source_id) REFERENCES sources (project_id, id)
);
COMMENT ON TABLE proposal_revision_evidence IS 'Sources cited by each proposal version. Composite keys keep evidence inside the project.';

INSERT INTO proposal_revisions
  (project_id, proposal_id, revision, type, title, content, owner_id, content_flags,
   authored_by, authored_at)
SELECT project_id, id, revision, type, title, content, owner_id, content_flags,
       proposed_by, proposed_at
FROM memory_proposals;

INSERT INTO proposal_revision_evidence (project_id, proposal_id, revision, source_id)
SELECT pe.project_id, pe.proposal_id, mp.revision, pe.source_id
FROM proposal_evidence pe JOIN memory_proposals mp ON mp.id = pe.proposal_id;

-- Authors other than the proposer; the proposer is already refused by a check constraint.
CREATE FUNCTION reject_author_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reviewed_by IS NOT NULL AND NEW.reviewed_by IS DISTINCT FROM NEW.proposed_by
     AND EXISTS (SELECT 1 FROM proposal_revisions
                 WHERE proposal_id = NEW.id AND authored_by = NEW.reviewed_by) THEN
    RAISE EXCEPTION 'An author of a proposal version cannot review the proposal'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_proposals_no_author_review
  BEFORE UPDATE OF reviewed_by ON memory_proposals
  FOR EACH ROW EXECUTE FUNCTION reject_author_review();

ALTER TABLE memory_revisions ADD COLUMN proposal_revision integer;
UPDATE memory_revisions mr SET proposal_revision = mp.revision
FROM memory_proposals mp WHERE mp.id = mr.proposal_id;
ALTER TABLE memory_revisions
  ALTER COLUMN proposal_revision SET NOT NULL,
  ADD FOREIGN KEY (proposal_id, proposal_revision) REFERENCES proposal_revisions (proposal_id, revision);
COMMENT ON COLUMN memory_revisions.proposal_revision IS 'The exact proposal version the reviewer approved.';
