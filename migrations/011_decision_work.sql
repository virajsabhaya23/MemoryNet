-- Immutable context baselines. Artifacts are references, not a second requirement authority.
CREATE TABLE decision_work (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  created_by uuid NOT NULL REFERENCES principals(id),
  title text NOT NULL,
  repository_id text NOT NULL,
  branch text NOT NULL,
  code_commit text NOT NULL,
  artifacts jsonb NOT NULL CHECK (jsonb_typeof(artifacts) = 'array'),
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  UNIQUE(project_id, id)
);
CREATE TABLE decision_work_pins (
  work_id uuid NOT NULL,
  project_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL,
  status_generation integer NOT NULL,
  PRIMARY KEY(work_id, memory_id),
  FOREIGN KEY(project_id, work_id) REFERENCES decision_work(project_id, id),
  FOREIGN KEY(project_id, memory_id) REFERENCES memories(project_id, id),
  FOREIGN KEY(memory_id, revision) REFERENCES memory_revisions(memory_id, revision)
);
CREATE INDEX decision_work_active ON decision_work(project_id, created_at DESC) WHERE closed_at IS NULL;
CREATE INDEX decision_work_memory ON decision_work_pins(memory_id);

CREATE FUNCTION protect_decision_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'decision_work' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'closed_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'closed_at')
       AND OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Work context baselines are immutable; create a new baseline';
END;
$$;
CREATE TRIGGER decision_work_immutable BEFORE UPDATE OR DELETE ON decision_work
  FOR EACH ROW EXECUTE FUNCTION protect_decision_work();
CREATE TRIGGER decision_work_pins_immutable BEFORE UPDATE OR DELETE ON decision_work_pins
  FOR EACH ROW EXECUTE FUNCTION protect_decision_work();
