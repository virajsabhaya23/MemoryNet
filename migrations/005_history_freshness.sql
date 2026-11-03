-- MemoryNet migration 005: history and freshness (2026-09-25).
-- Memories can now be current ('approved'), suspended while disputed, or
-- replaced ('superseded') by a newer memory. A proposal can change an existing
-- memory: a new version of it ('revise'), a replacement ('replace'), or an
-- earlier version brought back as a new one ('restore'). Each change names the
-- memory version it builds on, so approving it after the memory moved on is
-- refused. Anyone who can read a memory may report it as possibly outdated.

ALTER TABLE memories DROP CONSTRAINT memories_status_check;
ALTER TABLE memories
  ADD CONSTRAINT memories_status_check
    CHECK (status IN ('approved', 'suspended', 'superseded')),
  ADD COLUMN superseded_by uuid,
  ADD COLUMN status_changed_by uuid,
  ADD COLUMN status_changed_by_kind text NOT NULL DEFAULT 'human'
    CHECK (status_changed_by_kind = 'human'),
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN status_reason text,
  ADD CONSTRAINT memories_replacement_in_project
    FOREIGN KEY (project_id, superseded_by) REFERENCES memories (project_id, id),
  ADD CONSTRAINT memories_status_changer_is_person
    FOREIGN KEY (status_changed_by, status_changed_by_kind) REFERENCES principals (id, kind),
  ADD CONSTRAINT memories_superseded_has_replacement
    CHECK ((status = 'superseded') = (superseded_by IS NOT NULL)),
  ADD CONSTRAINT memories_not_replaced_by_itself
    CHECK (superseded_by IS DISTINCT FROM id),
  ADD CONSTRAINT memories_status_change_complete
    CHECK ((status_changed_by IS NULL) = (status_changed_at IS NULL));
COMMENT ON COLUMN memories.status IS 'approved: current guidance. suspended: disputed, not current until a reviewer resolves it. superseded: replaced by superseded_by.';

CREATE TABLE memory_status_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  changed_by uuid NOT NULL,
  changed_by_kind text NOT NULL DEFAULT 'human' CHECK (changed_by_kind = 'human'),
  changed_at timestamptz NOT NULL,
  reason text,
  FOREIGN KEY (project_id, memory_id) REFERENCES memories (project_id, id),
  FOREIGN KEY (changed_by, changed_by_kind) REFERENCES principals (id, kind)
);
COMMENT ON TABLE memory_status_changes IS 'Every suspension, reinstatement, and replacement of a memory, with the person and reason. Only people change a memory''s status.';
CREATE INDEX memory_status_changes_by_memory ON memory_status_changes (memory_id, id);

ALTER TABLE memory_proposals
  ADD COLUMN change_kind text NOT NULL DEFAULT 'new'
    CHECK (change_kind IN ('new', 'revise', 'replace', 'restore')),
  ADD COLUMN target_memory_id uuid,
  ADD COLUMN base_revision integer CHECK (base_revision > 0),
  ADD COLUMN restored_from_revision integer CHECK (restored_from_revision > 0),
  ADD CONSTRAINT memory_proposals_target_in_project
    FOREIGN KEY (project_id, target_memory_id) REFERENCES memories (project_id, id),
  ADD CONSTRAINT memory_proposals_change_names_target
    CHECK ((change_kind = 'new') = (target_memory_id IS NULL)
       AND (target_memory_id IS NULL) = (base_revision IS NULL)),
  ADD CONSTRAINT memory_proposals_restore_names_version
    CHECK ((change_kind = 'restore') = (restored_from_revision IS NOT NULL));
COMMENT ON COLUMN memory_proposals.base_revision IS 'The version of target_memory_id this change builds on. Approval is refused once the memory has another current version.';
CREATE INDEX memory_proposals_by_target ON memory_proposals (target_memory_id)
  WHERE target_memory_id IS NOT NULL;

CREATE TABLE memory_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL,
  reported_by uuid NOT NULL REFERENCES principals (id),
  reported_at timestamptz NOT NULL,
  reason text NOT NULL,
  resolved_by uuid REFERENCES principals (id),
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('dismissed', 'revised', 'replaced', 'reinstated', 'restored')),
  resolution_note text,
  FOREIGN KEY (project_id, memory_id) REFERENCES memories (project_id, id),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL)),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);
COMMENT ON TABLE memory_reports IS 'Reports that a memory may be outdated, from people or agents. A report changes nothing by itself; a person decides.';
CREATE INDEX memory_reports_open ON memory_reports (memory_id) WHERE resolved_at IS NULL;
