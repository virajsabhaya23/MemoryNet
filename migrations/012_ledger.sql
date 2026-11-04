-- MemoryNet migration 012: tamper-evident ledger (2026-11-03).
-- Every audit event and retrieval receipt is appended to a per-organization SHA-256 hash chain.
-- Each entry commits to the previous entry, so editing, deleting, reordering or inserting a
-- chained record changes every later hash. A head recorded elsewhere (a checkpoint) proves the
-- chain up to that point was not rewritten. Database triggers block ordinary edits; the chain
-- detects edits made by anyone able to bypass them. src/ledger.ts recomputes these payloads
-- independently and must stay identical to the expressions below.

CREATE TABLE ledger_heads (
  chain_id uuid PRIMARY KEY,
  seq bigint NOT NULL CHECK (seq >= 0),
  head_hash text NOT NULL CHECK (head_hash ~ '^[a-f0-9]{64}$')
);
COMMENT ON TABLE ledger_heads IS 'Latest entry of each ledger chain. chain_id is an organization ID, or the nil UUID for events outside any organization.';

CREATE TABLE ledger_entries (
  chain_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  entry_type text NOT NULL CHECK (entry_type IN ('audit_event', 'retrieval')),
  entry_ref text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[a-f0-9]{64}$'),
  entry_hash text NOT NULL CHECK (entry_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (chain_id, seq),
  UNIQUE (entry_type, entry_ref)
);
COMMENT ON TABLE ledger_entries IS 'Append-only hash chain. entry_hash = sha256(prev_hash:seq:entry_type:entry_ref:payload_hash). Holds digests and identifiers only, never content.';

CREATE FUNCTION ledger_utc(value timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

CREATE FUNCTION ledger_chain_for(organization uuid, project uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(organization, (SELECT organization_id FROM projects WHERE id = project),
                  '00000000-0000-0000-0000-000000000000'::uuid)
$$;

CREATE FUNCTION ledger_audit_payload(e audit_events) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array('audit_event', e.id, ledger_utc(e.occurred_at), e.actor_id, e.action,
    e.organization_id, e.project_id, e.target_type, e.target_id, e.reason, e.details)::text
$$;

CREATE FUNCTION ledger_retrieval_payload(target uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array('retrieval', r.id, r.project_id, r.caller_id, r.search_terms, r.outcome,
    ledger_utc(r.retrieved_at), r.applicability,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(ri.position, ri.memory_id, ri.revision, ri.status) ORDER BY ri.position)
              FROM retrieval_items ri WHERE ri.retrieval_id = r.id), '[]'::jsonb))::text
  FROM retrievals r WHERE r.id = target
$$;

CREATE FUNCTION ledger_append(target_chain uuid, kind text, ref text, payload text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  previous record;
  next_seq bigint;
  payload_digest text;
  digest text;
BEGIN
  IF target_chain IS NULL OR payload IS NULL THEN
    RAISE EXCEPTION 'Ledger entries need a chain and a payload';
  END IF;
  INSERT INTO ledger_heads (chain_id, seq, head_hash) VALUES (target_chain, 0, repeat('0', 64))
    ON CONFLICT (chain_id) DO NOTHING;
  SELECT seq, head_hash INTO previous FROM ledger_heads WHERE chain_id = target_chain FOR UPDATE;
  next_seq := previous.seq + 1;
  payload_digest := encode(sha256(convert_to(payload, 'UTF8')), 'hex');
  digest := encode(sha256(convert_to(previous.head_hash || ':' || next_seq::text || ':' || kind || ':' || ref || ':' || payload_digest, 'UTF8')), 'hex');
  INSERT INTO ledger_entries (chain_id, seq, entry_type, entry_ref, payload_hash, prev_hash, entry_hash)
    VALUES (target_chain, next_seq, kind, ref, payload_digest, previous.head_hash, digest);
  UPDATE ledger_heads SET seq = next_seq, head_hash = digest WHERE chain_id = target_chain;
END;
$$;

-- Existing records are chained once, oldest first, before the triggers below take over.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT 'audit_event'::text AS kind, e.id::text AS ref, e.occurred_at AS at, 0 AS ord, e.id AS n,
           ledger_chain_for(e.organization_id, e.project_id) AS chain, ledger_audit_payload(e) AS payload
    FROM audit_events e
    UNION ALL
    SELECT 'retrieval'::text, r.id::text, r.retrieved_at, 1, NULL::bigint, p.organization_id, ledger_retrieval_payload(r.id)
    FROM retrievals r JOIN projects p ON p.id = r.project_id
    ORDER BY at, ord, n, ref
  LOOP
    PERFORM ledger_append(item.chain, item.kind, item.ref, item.payload);
  END LOOP;
END;
$$;

CREATE FUNCTION protect_ledger_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.seq <> 0 OR NEW.head_hash <> repeat('0', 64) THEN
      RAISE EXCEPTION 'A ledger chain starts empty';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.chain_id = OLD.chain_id AND NEW.seq = OLD.seq + 1 AND EXISTS (
       SELECT 1 FROM ledger_entries le WHERE le.chain_id = NEW.chain_id AND le.seq = NEW.seq
         AND le.entry_hash = NEW.head_hash AND le.prev_hash = OLD.head_hash) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Ledger heads only advance by appending an entry';
END;
$$;
CREATE TRIGGER ledger_heads_append_only BEFORE INSERT OR UPDATE OR DELETE ON ledger_heads
  FOR EACH ROW EXECUTE FUNCTION protect_ledger_head();

CREATE FUNCTION protect_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (
       SELECT 1 FROM ledger_heads lh WHERE lh.chain_id = NEW.chain_id
         AND lh.seq + 1 = NEW.seq AND lh.head_hash = NEW.prev_hash) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Ledger entries are append-only and must extend their chain';
END;
$$;
CREATE TRIGGER ledger_entries_append_only BEFORE INSERT OR UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION protect_ledger_entry();

CREATE FUNCTION ledger_record_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_append(ledger_chain_for(NEW.organization_id, NEW.project_id), 'audit_event', NEW.id::text, ledger_audit_payload(NEW));
  RETURN NULL;
END;
$$;
CREATE TRIGGER audit_events_ledger AFTER INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION ledger_record_audit();

-- Deferred to commit so the receipt's digest covers every item written in the same transaction.
CREATE FUNCTION ledger_record_retrieval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ledger_append((SELECT organization_id FROM projects WHERE id = NEW.project_id), 'retrieval',
    NEW.id::text, ledger_retrieval_payload(NEW.id));
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER retrievals_ledger AFTER INSERT ON retrievals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_record_retrieval();

CREATE FUNCTION seal_retrieval_items() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_entries WHERE entry_type = 'retrieval' AND entry_ref = NEW.retrieval_id::text) THEN
    RAISE EXCEPTION 'A retrieval receipt is sealed once committed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retrieval_items_sealed BEFORE INSERT ON retrieval_items
  FOR EACH ROW EXECUTE FUNCTION seal_retrieval_items();
