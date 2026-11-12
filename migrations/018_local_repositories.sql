-- Disjoint provider keys. Preserve every existing row and reviewed connection.
ALTER TABLE repository_connections DROP CONSTRAINT repository_connections_provider_check,
  ADD CHECK ((provider = 'github' AND external_repository_id !~ '^local-') OR
             (provider = 'local' AND external_repository_id ~ '^local-[a-f0-9]{32}$'));
ALTER TABLE repository_access DROP CONSTRAINT repository_access_provider_check,
  ADD CHECK ((provider = 'github' AND external_repository_id !~ '^local-') OR
             (provider = 'local' AND external_repository_id ~ '^local-[a-f0-9]{32}$'));
ALTER TABLE sources DROP CONSTRAINT sources_provider_check,
  ADD CHECK ((provider = 'github' AND external_repository_id !~ '^local-') OR
             (provider = 'local' AND external_repository_id ~ '^local-[a-f0-9]{32}$'));

CREATE OR REPLACE FUNCTION valid_decision_applicability(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE branch text; first_at timestamptz; last_at timestamptz;
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(value) <> 'object' OR NOT(value ?& ARRAY['repositoryId','branch','validFrom','validUntil'])
    OR (value - ARRAY['repositoryId','branch','validFrom','validUntil']) <> '{}'::jsonb
    OR jsonb_typeof(value->'repositoryId') <> 'string' OR (value->>'repositoryId') !~ '^([1-9][0-9]{0,18}|local-[a-f0-9]{32})$'
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
CREATE OR REPLACE FUNCTION check_decision_scope_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.applicability IS NOT NULL AND NOT EXISTS(SELECT 1 FROM repository_connections rc
    WHERE rc.id=NEW.applicability_connection_id AND rc.project_id=NEW.project_id
      AND rc.provider=CASE WHEN NEW.applicability->>'repositoryId' LIKE 'local-%' THEN 'local' ELSE 'github' END AND rc.external_repository_id=NEW.applicability->>'repositoryId') THEN
    RAISE EXCEPTION 'Decision applicability repository does not match its project connection';
  END IF;
  RETURN NEW;
END;
$$;
