-- MemoryNet migration 002: memory records (2026-09-24).
-- Keeps proposals apart from approved knowledge. memory_proposals holds every
-- proposal and its review. memories holds approved knowledge: a stable ID,
-- project, human owner, and current version. memory_revisions keeps each
-- approved version, and memory_evidence the sources each version cites.
-- Rows from migration 001 carry over, and approved memories keep their IDs.

-- Lets foreign keys require a person rather than an agent.
ALTER TABLE principals ADD CONSTRAINT principals_id_kind_key UNIQUE (id, kind);

CREATE TABLE memory_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  type text NOT NULL CHECK (type IN ('decision', 'rationale', 'lesson', 'constraint', 'failed_approach', 'incident')),
  title text NOT NULL,
  content text NOT NULL,
  owner_id uuid NOT NULL,
  owner_kind text NOT NULL DEFAULT 'human' CHECK (owner_kind = 'human'),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  revision integer NOT NULL CHECK (revision > 0),
  proposed_by uuid NOT NULL REFERENCES principals (id),
  proposed_at timestamptz NOT NULL,
  reviewed_by uuid REFERENCES principals (id),
  reviewed_at timestamptz,
  review_reason text,
  memory_id uuid,
  UNIQUE (project_id, id),
  UNIQUE (project_id, id, reviewed_by),
  FOREIGN KEY (owner_id, owner_kind) REFERENCES principals (id, kind),
  CHECK ((status = 'pending') = (reviewed_by IS NULL)),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CHECK (reviewed_by IS DISTINCT FROM proposed_by),
  CHECK ((status = 'approved') = (memory_id IS NOT NULL))
);
COMMENT ON TABLE memory_proposals IS 'Proposed knowledge and its review. Never trusted context. Approving a proposal publishes a memory revision and sets memory_id. owner_id is the person who will be accountable for the memory.';
CREATE INDEX memory_proposals_by_project ON memory_proposals (project_id);

CREATE TABLE proposal_evidence (
  project_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  source_id uuid NOT NULL,
  PRIMARY KEY (proposal_id, source_id),
  FOREIGN KEY (project_id, proposal_id) REFERENCES memory_proposals (project_id, id),
  FOREIGN KEY (project_id, source_id) REFERENCES sources (project_id, id)
);
COMMENT ON TABLE proposal_evidence IS 'Sources supporting a proposal. Composite keys keep evidence inside the proposal''s project.';
CREATE INDEX proposal_evidence_by_source ON proposal_evidence (source_id);

-- Carry over migration 001 rows. A proposal's owner is its proposer when that is a person, otherwise the project's creator.
INSERT INTO memory_proposals
  (id, project_id, type, title, content, owner_id, status, revision, proposed_by, proposed_at,
   reviewed_by, reviewed_at, review_reason, memory_id)
SELECT m.id, m.project_id, m.type, m.title, m.content,
       CASE WHEN pr.kind = 'human' THEN m.proposed_by ELSE p.created_by END,
       m.status, m.revision, m.proposed_by, m.proposed_at, m.reviewed_by, m.reviewed_at, m.review_reason,
       CASE WHEN m.status = 'approved' THEN m.id END
FROM memories m
JOIN principals pr ON pr.id = m.proposed_by
JOIN projects p ON p.id = m.project_id;

INSERT INTO proposal_evidence (project_id, proposal_id, source_id)
SELECT project_id, memory_id, source_id FROM memory_evidence;

DROP TABLE memory_evidence;
DROP TABLE memories;

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  owner_id uuid NOT NULL,
  owner_kind text NOT NULL DEFAULT 'human' CHECK (owner_kind = 'human'),
  status text NOT NULL CHECK (status IN ('approved')),
  current_revision integer NOT NULL CHECK (current_revision > 0),
  created_at timestamptz NOT NULL,
  UNIQUE (project_id, id),
  FOREIGN KEY (owner_id, owner_kind) REFERENCES principals (id, kind)
);
COMMENT ON TABLE memories IS 'Approved knowledge. The ID never changes; each approved version is a memory_revisions row. Readable only when every evidence source of the current version is readable. Step 2 adds suspended, superseded, and deleted states.';
CREATE INDEX memories_by_project ON memories (project_id);

CREATE TABLE memory_revisions (
  project_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  type text NOT NULL CHECK (type IN ('decision', 'rationale', 'lesson', 'constraint', 'failed_approach', 'incident')),
  title text NOT NULL,
  content text NOT NULL,
  proposal_id uuid NOT NULL UNIQUE,
  approved_by uuid NOT NULL,
  approver_kind text NOT NULL DEFAULT 'human' CHECK (approver_kind = 'human'),
  approved_at timestamptz NOT NULL,
  PRIMARY KEY (memory_id, revision),
  FOREIGN KEY (project_id, memory_id) REFERENCES memories (project_id, id),
  -- The approver must be the proposal's reviewer, who can never be its proposer.
  FOREIGN KEY (project_id, proposal_id, approved_by) REFERENCES memory_proposals (project_id, id, reviewed_by),
  FOREIGN KEY (approved_by, approver_kind) REFERENCES principals (id, kind)
);
COMMENT ON TABLE memory_revisions IS 'Each approved version of a memory, copied from the proposal a different person approved. Approvers must be people.';

CREATE TABLE memory_evidence (
  project_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL,
  source_id uuid NOT NULL,
  PRIMARY KEY (memory_id, revision, source_id),
  FOREIGN KEY (memory_id, revision) REFERENCES memory_revisions (memory_id, revision),
  FOREIGN KEY (project_id, memory_id) REFERENCES memories (project_id, id),
  FOREIGN KEY (project_id, source_id) REFERENCES sources (project_id, id)
);
COMMENT ON TABLE memory_evidence IS 'Sources cited by each approved version. Composite keys keep evidence inside the memory''s project.';
CREATE INDEX memory_evidence_by_source ON memory_evidence (source_id);

INSERT INTO memories (id, project_id, owner_id, status, current_revision, created_at)
SELECT id, project_id, owner_id, 'approved', 1, reviewed_at
FROM memory_proposals WHERE status = 'approved';

INSERT INTO memory_revisions
  (project_id, memory_id, revision, type, title, content, proposal_id, approved_by, approved_at)
SELECT project_id, id, 1, type, title, content, id, reviewed_by, reviewed_at
FROM memory_proposals WHERE status = 'approved';

INSERT INTO memory_evidence (project_id, memory_id, revision, source_id)
SELECT pe.project_id, pe.proposal_id, 1, pe.source_id
FROM proposal_evidence pe
JOIN memory_proposals mp ON mp.id = pe.proposal_id
WHERE mp.status = 'approved';

ALTER TABLE memory_proposals
  ADD FOREIGN KEY (project_id, memory_id) REFERENCES memories (project_id, id);
