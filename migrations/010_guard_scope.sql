-- Historical runs stay unscoped. Never retrospectively grant agent-delivery applicability.
ALTER TABLE decision_guard_runs
  ADD COLUMN applicability jsonb,
  ADD COLUMN applicability_connection_id uuid,
  ADD CONSTRAINT guard_scope_pair CHECK ((applicability IS NULL) = (applicability_connection_id IS NULL)),
  ADD CONSTRAINT guard_scope_object CHECK (valid_decision_applicability(applicability)),
  ADD FOREIGN KEY(project_id,applicability_connection_id) REFERENCES repository_connections(project_id,id);
CREATE TRIGGER guard_scope_connection BEFORE INSERT ON decision_guard_runs
  FOR EACH ROW EXECUTE FUNCTION check_decision_scope_connection();
-- Existing append-only trigger protects these columns too.
