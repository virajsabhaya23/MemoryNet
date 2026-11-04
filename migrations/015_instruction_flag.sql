-- MemoryNet migration 015: instruction-like content flag (2026-11-03).
-- Evidence and proposed knowledge that reads like instructions aimed at an AI model (overriding prior
-- instructions, impersonating chat roles, hidden control characters) is flagged for reviewers.
-- Like the other flags it is kept with the text and does not block approval. Definitions are
-- instructions by design and keep their original flag set.

ALTER TABLE sources DROP CONSTRAINT sources_content_flags_check,
  ADD CONSTRAINT sources_content_flags_check
    CHECK (content_flags <@ ARRAY['secret_removed', 'personal_data', 'truncated', 'instruction_like']::text[]);
ALTER TABLE memory_proposals DROP CONSTRAINT memory_proposals_content_flags_check,
  ADD CONSTRAINT memory_proposals_content_flags_check
    CHECK (content_flags <@ ARRAY['secret_removed', 'personal_data', 'truncated', 'instruction_like']::text[]);
ALTER TABLE proposal_revisions DROP CONSTRAINT proposal_revisions_content_flags_check,
  ADD CONSTRAINT proposal_revisions_content_flags_check
    CHECK (content_flags <@ ARRAY['secret_removed', 'personal_data', 'truncated', 'instruction_like']::text[]);
COMMENT ON COLUMN sources.content_flags IS 'secret_removed: a likely secret was replaced before storing. personal_data: may contain personal data. truncated: text was cut to the excerpt limit. instruction_like: may address an AI model with instructions.';
