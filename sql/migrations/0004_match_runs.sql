-- One row per attempt to match one accepted source message (Telegram/WhatsApp
-- lead). source_message_id references the existing public.devi_messages.id
-- (bigint) but is intentionally NOT a foreign key: devi_messages is owned by
-- the production monitoring system and must never be altered by this pilot,
-- and this role only ever holds SELECT on it.
CREATE TABLE IF NOT EXISTS matching.match_runs (
  id BIGSERIAL PRIMARY KEY,
  source_message_id TEXT NOT NULL,
  result_status TEXT NOT NULL CHECK (result_status IN ('STRONG_MATCH', 'MATCH', 'NO_MATCH', 'ERROR')),
  parsed_request JSONB,
  normalized_request JSONB,
  stock_synced_at TIMESTAMPTZ,
  active_stock_count INTEGER,
  candidates_count INTEGER,
  matches_count INTEGER,
  best_score NUMERIC,
  no_match_reason TEXT,
  parser_version TEXT,
  matcher_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_match_runs_source_message_id
  ON matching.match_runs (source_message_id);

CREATE INDEX IF NOT EXISTS idx_match_runs_created_at
  ON matching.match_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_match_runs_result_status
  ON matching.match_runs (result_status);
