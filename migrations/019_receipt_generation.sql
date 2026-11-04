-- Earlier append-only receipts cannot prove a past lifecycle generation. Leave them unknown.
ALTER TABLE retrieval_items ADD COLUMN status_generation integer CHECK (status_generation >= 0);
