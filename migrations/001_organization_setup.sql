-- MemoryNet migration 001: organization setup (2026-09-24).
-- Organization > business unit > project scopes, people and agents, role
-- assignments, GitHub repository connections, observed repository access, and
-- the minimal source and memory records whose reads these rules restrict.
-- Timestamps come from the application clock so access expiry is testable.

CREATE TABLE roles (
  name text PRIMARY KEY,
  rank smallint NOT NULL UNIQUE CHECK (rank > 0),
  agent_allowed boolean NOT NULL
);
COMMENT ON TABLE roles IS 'Fixed role ladder. Each role includes every permission of the lower ranks. Agents may hold only agent_allowed roles.';
INSERT INTO roles (name, rank, agent_allowed) VALUES
  ('reader', 1, true),
  ('contributor', 2, true),
  ('reviewer', 3, false),
  ('administrator', 4, false),
  ('owner', 5, false);

CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('human', 'agent')),
  display_name text NOT NULL,
  github_user_id text UNIQUE,
  created_at timestamptz NOT NULL
);
COMMENT ON TABLE principals IS 'People and AI agents that can hold roles. Agents are limited to reader or contributor.';

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES principals (id),
  created_at timestamptz NOT NULL
);
COMMENT ON TABLE organizations IS 'Top-level tenant. Nothing is shared across organizations.';

CREATE TABLE business_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  slug text NOT NULL,
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES principals (id),
  created_at timestamptz NOT NULL,
  UNIQUE (organization_id, slug),
  UNIQUE (organization_id, id)
);
COMMENT ON TABLE business_units IS 'Group of projects inside one organization.';

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES principals (id),
  created_at timestamptz NOT NULL,
  UNIQUE (organization_id, slug),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, business_unit_id) REFERENCES business_units (organization_id, id)
);
COMMENT ON TABLE projects IS 'Unit of knowledge ownership. Memories, sources, and repository connections belong to one project.';

CREATE TABLE role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES principals (id),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  business_unit_id uuid,
  project_id uuid,
  role text NOT NULL REFERENCES roles (name),
  granted_by uuid NOT NULL REFERENCES principals (id),
  granted_at timestamptz NOT NULL,
  revoked_by uuid REFERENCES principals (id),
  revoked_at timestamptz,
  revoke_reason text,
  CHECK (business_unit_id IS NULL OR project_id IS NULL),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  FOREIGN KEY (organization_id, business_unit_id) REFERENCES business_units (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
);
COMMENT ON TABLE role_assignments IS 'Role grants. Scope is the organization when business_unit_id and project_id are null. Org roles cover every BU and project in the org; BU roles cover its projects. Revoked rows stay as history.';
CREATE UNIQUE INDEX role_assignments_one_active_per_scope
  ON role_assignments (principal_id, organization_id, business_unit_id, project_id) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;
CREATE INDEX role_assignments_active_by_principal
  ON role_assignments (principal_id) WHERE revoked_at IS NULL;

-- The only definition of role inheritance. Agent grants above agent_allowed roles are ignored.
CREATE VIEW effective_organization_roles AS
SELECT ra.principal_id, ra.organization_id, MAX(r.rank)::int AS rank
FROM role_assignments ra
JOIN roles r ON r.name = ra.role
JOIN principals pr ON pr.id = ra.principal_id
WHERE ra.revoked_at IS NULL
  AND ra.business_unit_id IS NULL
  AND ra.project_id IS NULL
  AND (pr.kind = 'human' OR r.agent_allowed)
GROUP BY ra.principal_id, ra.organization_id;

CREATE VIEW effective_business_unit_roles AS
SELECT ra.principal_id, b.id AS business_unit_id, MAX(r.rank)::int AS rank
FROM role_assignments ra
JOIN roles r ON r.name = ra.role
JOIN principals pr ON pr.id = ra.principal_id
JOIN business_units b ON b.organization_id = ra.organization_id
WHERE ra.revoked_at IS NULL
  AND ra.project_id IS NULL
  AND (ra.business_unit_id IS NULL OR ra.business_unit_id = b.id)
  AND (pr.kind = 'human' OR r.agent_allowed)
GROUP BY ra.principal_id, b.id;

CREATE VIEW effective_project_roles AS
SELECT ra.principal_id, p.id AS project_id, MAX(r.rank)::int AS rank
FROM role_assignments ra
JOIN roles r ON r.name = ra.role
JOIN principals pr ON pr.id = ra.principal_id
JOIN projects p ON p.organization_id = ra.organization_id
WHERE ra.revoked_at IS NULL
  AND (ra.business_unit_id IS NULL OR ra.business_unit_id = p.business_unit_id)
  AND (ra.project_id IS NULL OR ra.project_id = p.id)
  AND (pr.kind = 'human' OR r.agent_allowed)
GROUP BY ra.principal_id, p.id;

CREATE TABLE repository_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  provider text NOT NULL CHECK (provider IN ('github')),
  external_repository_id text NOT NULL,
  full_name text NOT NULL,
  connected_by uuid NOT NULL REFERENCES principals (id),
  connected_at timestamptz NOT NULL,
  disconnected_by uuid REFERENCES principals (id),
  disconnected_at timestamptz,
  disconnect_reason text,
  CHECK ((disconnected_at IS NULL) = (disconnect_reason IS NULL)),
  CHECK (disconnected_by IS NULL OR disconnected_at IS NOT NULL)
);
COMMENT ON TABLE repository_connections IS 'Selected GitHub repositories linked to a project. A repository has at most one active project. disconnected_by is null when the system disconnected it.';
CREATE UNIQUE INDEX repository_connections_one_active_project
  ON repository_connections (provider, external_repository_id)
  WHERE disconnected_at IS NULL;

CREATE TABLE repository_access (
  principal_id uuid NOT NULL REFERENCES principals (id),
  provider text NOT NULL CHECK (provider IN ('github')),
  external_repository_id text NOT NULL,
  can_read boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (principal_id, provider, external_repository_id)
);
COMMENT ON TABLE repository_access IS 'Latest repository read access reported by the provider for each principal. A missing or stale row denies access.';

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  provider text NOT NULL CHECK (provider IN ('github')),
  external_repository_id text NOT NULL,
  reference text NOT NULL,
  url text NOT NULL,
  revision text,
  excerpt text NOT NULL,
  captured_by uuid NOT NULL REFERENCES principals (id),
  captured_at timestamptz NOT NULL,
  UNIQUE (project_id, id)
);
COMMENT ON TABLE sources IS 'Evidence captured from a connected repository. Readable only while that repository is connected to the same project and the reader has current repository access.';
CREATE INDEX sources_by_project ON sources (project_id);

-- Who may read each source. Queries must also require a fresh access_observed_at.
CREATE VIEW source_read_access AS
SELECT epr.principal_id, s.id AS source_id, s.project_id, acc.observed_at AS access_observed_at
FROM sources s
JOIN effective_project_roles epr ON epr.project_id = s.project_id
JOIN repository_connections rc
  ON rc.project_id = s.project_id
 AND rc.provider = s.provider
 AND rc.external_repository_id = s.external_repository_id
 AND rc.disconnected_at IS NULL
JOIN repository_access acc
  ON acc.principal_id = epr.principal_id
 AND acc.provider = s.provider
 AND acc.external_repository_id = s.external_repository_id
 AND acc.can_read;

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  type text NOT NULL CHECK (type IN ('decision', 'rationale', 'lesson', 'constraint', 'failed_approach', 'incident')),
  title text NOT NULL,
  content text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  revision integer NOT NULL CHECK (revision > 0),
  proposed_by uuid NOT NULL REFERENCES principals (id),
  proposed_at timestamptz NOT NULL,
  reviewed_by uuid REFERENCES principals (id),
  reviewed_at timestamptz,
  review_reason text,
  UNIQUE (project_id, id),
  CHECK ((status = 'pending') = (reviewed_by IS NULL)),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CHECK (reviewed_by IS DISTINCT FROM proposed_by)
);
COMMENT ON TABLE memories IS 'Project knowledge. Pending and rejected entries are proposals, not trusted context. Readable only when every evidence source is readable.';
CREATE INDEX memories_by_project ON memories (project_id);

CREATE TABLE memory_evidence (
  project_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  source_id uuid NOT NULL,
  PRIMARY KEY (memory_id, source_id),
  FOREIGN KEY (project_id, memory_id) REFERENCES memories (project_id, id),
  FOREIGN KEY (project_id, source_id) REFERENCES sources (project_id, id)
);
COMMENT ON TABLE memory_evidence IS 'Sources supporting a memory. Composite keys keep evidence inside the memory''s project.';
CREATE INDEX memory_evidence_by_source ON memory_evidence (source_id);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  actor_id uuid REFERENCES principals (id),
  action text NOT NULL,
  organization_id uuid REFERENCES organizations (id),
  project_id uuid REFERENCES projects (id),
  target_type text NOT NULL,
  target_id text NOT NULL,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE audit_events IS 'Append-only record of access and knowledge changes. actor_id is null for system actions. Never store source excerpts, memory content, or credentials here.';
CREATE INDEX audit_events_by_organization ON audit_events (organization_id, occurred_at);

CREATE FUNCTION reject_audit_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_change();
