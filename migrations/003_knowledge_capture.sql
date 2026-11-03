-- MemoryNet migration 003: knowledge capture (2026-09-24).
-- Sources record how they were captured: by a person or agent through
-- MemoryNet ('manual'), or by the GitHub App from a merged pull request
-- ('github_app', with no captured_by). Sources and proposals carry content
-- flags for reviewers. Two unique indexes stop the same evidence from being
-- stored twice. Existing rows become manual sources with no flags.

ALTER TABLE sources
  ADD COLUMN capture_method text NOT NULL DEFAULT 'manual'
    CHECK (capture_method IN ('manual', 'github_app')),
  ADD COLUMN content_flags text[] NOT NULL DEFAULT '{}'
    CHECK (content_flags <@ ARRAY['secret_removed', 'personal_data', 'truncated']::text[]),
  ALTER COLUMN captured_by DROP NOT NULL,
  ADD CONSTRAINT sources_captured_by_matches_method
    CHECK ((capture_method = 'manual') = (captured_by IS NOT NULL));
COMMENT ON COLUMN sources.capture_method IS 'manual: recorded by a person or agent. github_app: captured from a verified GitHub App event; captured_by is null.';
COMMENT ON COLUMN sources.content_flags IS 'secret_removed: a likely secret was replaced before storing. personal_data: may contain personal data. truncated: text was cut to the excerpt limit.';

-- One source per pull request the GitHub App captures, however often its event arrives.
CREATE UNIQUE INDEX sources_one_per_captured_pull_request
  ON sources (provider, external_repository_id, reference)
  WHERE capture_method = 'github_app';

-- The same evidence recorded again by hand is stored once.
CREATE UNIQUE INDEX sources_manual_evidence_once
  ON sources (project_id, provider, external_repository_id, reference, revision, md5(excerpt))
  NULLS NOT DISTINCT
  WHERE capture_method = 'manual';

ALTER TABLE memory_proposals
  ADD COLUMN content_flags text[] NOT NULL DEFAULT '{}'
    CHECK (content_flags <@ ARRAY['secret_removed', 'personal_data', 'truncated']::text[]);
COMMENT ON COLUMN memory_proposals.content_flags IS 'Flags found in the proposal''s own title and content. Its evidence carries its own flags.';
