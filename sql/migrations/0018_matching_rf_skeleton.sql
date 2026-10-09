-- RF contour schema skeleton (AGENTS.md section 20, MARKET_CONTOURS_AND_
-- SOURCE_ROUTING.md section 20). Deliberately minimal: the RF stock
-- contract, request schema, location hierarchy, room/layout semantics,
-- budget rules, hard filters, ranking, and aliases are NOT YET DEFINED
-- (no business rules have been approved) -- this migration only reserves
-- the independent schema NAMESPACE and persists the one thing that is
-- already true regardless of future business rules: an RF-routed event
-- was received and the RF matcher is not yet implemented.
--
-- Do NOT add stock/alias/domain tables here without an approved RF stock
-- contract -- see rf-lead-matching-service/README.md.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'matching_rf') THEN
    EXECUTE 'CREATE SCHEMA matching_rf';
  END IF;
END $$;

-- Deliberately domain-free: no area/bedrooms/budget/room columns. Once
-- the RF stock contract is approved, real RF domain tables
-- (matching_rf.stock_inventory, matching_rf.location_aliases, etc.) are
-- added in their own additive migrations -- this table is not extended
-- to hold them.
CREATE TABLE IF NOT EXISTS matching_rf.match_runs (
  id BIGSERIAL PRIMARY KEY,
  source_message_id TEXT NOT NULL,
  provider TEXT,
  account_id TEXT,
  chat_id TEXT,
  original_text TEXT,
  result_status TEXT NOT NULL CHECK (result_status IN ('NOT_IMPLEMENTED', 'REJECTED', 'ERROR')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_matching_rf_match_runs_created_at ON matching_rf.match_runs (created_at DESC);

-- Contour-specific interpretation cache namespace, reserved from day one
-- per section 15's hard isolation requirement -- a UAE interpretation
-- must never be reused as an RF interpretation or vice versa. Same shape
-- as matching.message_interpretation_cache (migration 0015), in its own
-- schema. Unused until the RF parser/triage exists; reserved now so the
-- table never needs to be introduced later as a retrofit into shared
-- space.
CREATE TABLE IF NOT EXISTS matching_rf.message_interpretation_cache (
  id BIGSERIAL PRIMARY KEY,
  text_hash TEXT NOT NULL,
  interpreter_version TEXT NOT NULL,
  normalized_text TEXT,
  interpretation_source TEXT NOT NULL CHECK (interpretation_source IN ('local', 'ai')),
  message_class TEXT,
  demand_owner TEXT,
  promotion BOOLEAN,
  spam BOOLEAN,
  parsed_request JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count INTEGER NOT NULL DEFAULT 1
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matching_rf_interpretation_cache_hash_version_key'
  ) THEN
    ALTER TABLE matching_rf.message_interpretation_cache
      ADD CONSTRAINT matching_rf_interpretation_cache_hash_version_key UNIQUE (text_hash, interpreter_version);
  END IF;
END $$;
