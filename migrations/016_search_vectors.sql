-- MemoryNet migration 016: stored search vectors (2026-11-03).
-- Search and task context used to build text-search vectors for every readable memory and its cited
-- evidence on every request. Each memory version and source now stores its vector once. Ranking is
-- unchanged: title (weight A), type and text (B), and cited references and excerpts (C); the per-source
-- vectors are concatenated at query time, which ranks the same as one vector over the joined text.

CREATE AGGREGATE tsvector_agg(tsvector) (SFUNC = tsvector_concat, STYPE = tsvector, INITCOND = '');

ALTER TABLE memory_revisions ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', title), 'A')
  || setweight(to_tsvector('english', replace(type, '_', ' ') || ' ' || content), 'B')) STORED;

ALTER TABLE sources ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', replace(reference, '/', ' ') || ' ' || excerpt), 'C')) STORED;
