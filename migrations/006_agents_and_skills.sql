-- MemoryNet migration 006: agents, skills, instructions, and rules (2026-09-25).
-- A definition describes what an agent, skill, instruction, or rule is responsible
-- for, at one organization, business unit, or project. Like memories, every change
-- is a proposal that a different person approves; each approved version is kept, so
-- an older one can come back through a new review. Links between definitions, and
-- to approved memories, belong to a version. MemoryNet stores definitions as data
-- and never runs them.

CREATE TABLE definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  business_unit_id uuid,
  project_id uuid,
  kind text NOT NULL CHECK (kind IN ('agent', 'skill', 'instruction', 'rule')),
  current_revision integer NOT NULL CHECK (current_revision > 0),
  created_at timestamptz NOT NULL,
  -- Same convention as role_assignments: a project definition leaves business_unit_id empty.
  CHECK (business_unit_id IS NULL OR project_id IS NULL),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, business_unit_id) REFERENCES business_units (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
);
COMMENT ON TABLE definitions IS 'Approved agents, skills, instructions, and rules. The ID and kind never change; each approved version is a definition_revisions row. The scope is the organization when business_unit_id and project_id are null.';
CREATE INDEX definitions_by_organization ON definitions (organization_id);

CREATE TABLE definition_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  business_unit_id uuid,
  project_id uuid,
  action text NOT NULL CHECK (action IN ('create', 'change', 'retire')),
  -- Empty for a new definition until it is approved.
  definition_id uuid,
  -- The approved version a change was written against; approval fails if it is no longer current.
  base_revision integer CHECK (base_revision > 0),
  kind text NOT NULL CHECK (kind IN ('agent', 'skill', 'instruction', 'rule')),
  name text NOT NULL,
  purpose text NOT NULL,
  responsibilities text[] NOT NULL CHECK (cardinality(responsibilities) BETWEEN 1 AND 20),
  boundaries text[] NOT NULL CHECK (cardinality(boundaries) <= 20),
  instructions text NOT NULL,
  applies_to text,
  runs_as uuid,
  runs_as_kind text NOT NULL DEFAULT 'agent' CHECK (runs_as_kind = 'agent'),
  owner_id uuid NOT NULL,
  owner_kind text NOT NULL DEFAULT 'human' CHECK (owner_kind = 'human'),
  change_note text,
  content_flags text[] NOT NULL DEFAULT '{}'
    CHECK (content_flags <@ ARRAY['secret_removed', 'personal_data', 'truncated']::text[]),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  revision integer NOT NULL CHECK (revision > 0),
  proposed_by uuid NOT NULL REFERENCES principals (id),
  proposed_at timestamptz NOT NULL,
  reviewed_by uuid REFERENCES principals (id),
  reviewed_at timestamptz,
  review_reason text,
  -- The definition version this proposal became.
  approved_revision integer,
  UNIQUE (id, reviewed_by),
  CHECK (business_unit_id IS NULL OR project_id IS NULL),
  CHECK (action <> 'create' OR base_revision IS NULL),
  CHECK (action = 'create' OR (definition_id IS NOT NULL AND base_revision IS NOT NULL)),
  CHECK (action <> 'retire' OR change_note IS NOT NULL),
  CHECK (runs_as IS NULL OR kind = 'agent'),
  CHECK ((status = 'pending') = (reviewed_by IS NULL)),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CHECK (reviewed_by IS DISTINCT FROM proposed_by),
  CHECK ((status = 'approved') = (approved_revision IS NOT NULL)),
  CHECK (status <> 'approved' OR definition_id IS NOT NULL),
  FOREIGN KEY (organization_id, business_unit_id) REFERENCES business_units (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  FOREIGN KEY (organization_id, definition_id) REFERENCES definitions (organization_id, id),
  FOREIGN KEY (runs_as, runs_as_kind) REFERENCES principals (id, kind),
  FOREIGN KEY (owner_id, owner_kind) REFERENCES principals (id, kind)
);
COMMENT ON TABLE definition_proposals IS 'Proposed new definitions, changes (including restoring an older version), and retirements, with their review. Never trusted guidance. Only human contributors and above can see them.';
CREATE INDEX definition_proposals_by_organization ON definition_proposals (organization_id, status);
CREATE INDEX definition_proposals_by_definition ON definition_proposals (definition_id);

CREATE TABLE definition_proposal_links (
  proposal_id uuid NOT NULL REFERENCES definition_proposals (id),
  relation text NOT NULL CHECK (relation IN ('uses', 'follows', 'hands_off_to', 'based_on')),
  target_definition_id uuid REFERENCES definitions (id),
  target_memory_id uuid REFERENCES memories (id),
  CHECK ((target_definition_id IS NULL) <> (target_memory_id IS NULL)),
  CHECK ((relation = 'based_on') = (target_memory_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (proposal_id, relation, target_definition_id, target_memory_id)
);
COMMENT ON TABLE definition_proposal_links IS 'Links a proposal asks for: uses a skill, follows a rule or instruction, hands off to an agent, or is based on an approved memory.';

CREATE TABLE definition_revisions (
  organization_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  name text NOT NULL,
  purpose text NOT NULL,
  responsibilities text[] NOT NULL CHECK (cardinality(responsibilities) BETWEEN 1 AND 20),
  boundaries text[] NOT NULL CHECK (cardinality(boundaries) <= 20),
  instructions text NOT NULL,
  applies_to text,
  runs_as uuid,
  runs_as_kind text NOT NULL DEFAULT 'agent' CHECK (runs_as_kind = 'agent'),
  owner_id uuid NOT NULL,
  owner_kind text NOT NULL DEFAULT 'human' CHECK (owner_kind = 'human'),
  change_note text,
  content_flags text[] NOT NULL DEFAULT '{}'
    CHECK (content_flags <@ ARRAY['secret_removed', 'personal_data', 'truncated']::text[]),
  proposal_id uuid NOT NULL UNIQUE,
  approved_by uuid NOT NULL,
  approver_kind text NOT NULL DEFAULT 'human' CHECK (approver_kind = 'human'),
  approved_at timestamptz NOT NULL,
  PRIMARY KEY (definition_id, revision),
  FOREIGN KEY (organization_id, definition_id) REFERENCES definitions (organization_id, id),
  -- The approver must be the proposal's reviewer, who can never be its proposer.
  FOREIGN KEY (proposal_id, approved_by) REFERENCES definition_proposals (id, reviewed_by),
  FOREIGN KEY (approved_by, approver_kind) REFERENCES principals (id, kind),
  FOREIGN KEY (runs_as, runs_as_kind) REFERENCES principals (id, kind),
  FOREIGN KEY (owner_id, owner_kind) REFERENCES principals (id, kind)
);
COMMENT ON TABLE definition_revisions IS 'Each approved version of a definition, copied from the proposal a different person approved. A retired version keeps the content it had.';

CREATE TABLE definition_links (
  organization_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  revision integer NOT NULL,
  relation text NOT NULL CHECK (relation IN ('uses', 'follows', 'hands_off_to', 'based_on')),
  target_definition_id uuid,
  target_memory_id uuid REFERENCES memories (id),
  CHECK ((target_definition_id IS NULL) <> (target_memory_id IS NULL)),
  CHECK ((relation = 'based_on') = (target_memory_id IS NOT NULL)),
  CHECK (target_definition_id IS DISTINCT FROM definition_id),
  UNIQUE NULLS NOT DISTINCT (definition_id, revision, relation, target_definition_id, target_memory_id),
  FOREIGN KEY (definition_id, revision) REFERENCES definition_revisions (definition_id, revision),
  FOREIGN KEY (organization_id, target_definition_id) REFERENCES definitions (organization_id, id)
);
COMMENT ON TABLE definition_links IS 'Links of each approved version. A link to a definition points to the same scope or one above it, so everyone who can see the definition can see its target.';
CREATE INDEX definition_links_by_target_definition ON definition_links (target_definition_id);
CREATE INDEX definition_links_by_target_memory ON definition_links (target_memory_id);

-- The only definition of who may see a definition: a role at its scope, above it, or inside it.
-- Guidance for an organization or business unit applies to the work inside it; nothing is shared sideways.
CREATE VIEW definition_read_access AS
SELECT DISTINCT presence.principal_id, d.id AS definition_id
FROM definitions d
JOIN (
  SELECT principal_id, organization_id, NULL::uuid AS business_unit_id, NULL::uuid AS project_id
  FROM effective_organization_roles
  UNION ALL
  SELECT r.principal_id, b.organization_id, b.id, NULL::uuid
  FROM effective_business_unit_roles r JOIN business_units b ON b.id = r.business_unit_id
  UNION ALL
  SELECT r.principal_id, p.organization_id, p.business_unit_id, p.id
  FROM effective_project_roles r JOIN projects p ON p.id = r.project_id
) presence ON presence.organization_id = d.organization_id
WHERE (d.project_id IS NULL OR presence.project_id = d.project_id)
  AND (d.business_unit_id IS NULL OR presence.business_unit_id = d.business_unit_id);
