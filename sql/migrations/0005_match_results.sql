-- One row per Request <-> Stock business match. Reprocessing the same
-- request UPSERTs score/status/debug fields instead of creating a duplicate
-- business match (see UNIQUE constraint below).
CREATE TABLE IF NOT EXISTS matching.match_results (
  id BIGSERIAL PRIMARY KEY,
  match_run_id BIGINT NOT NULL REFERENCES matching.match_runs (id),
  source_message_id TEXT NOT NULL,
  stock_id TEXT NOT NULL,
  match_score NUMERIC NOT NULL,
  match_status TEXT NOT NULL CHECK (match_status IN ('STRONG_MATCH', 'MATCH')),
  match_rank INTEGER,
  location_score NUMERIC,
  bedrooms_score NUMERIC,
  property_type_score NUMERIC,
  budget_score NUMERIC,
  furnishing_score NUMERIC,
  score_breakdown JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'match_results_source_message_id_stock_id_key'
  ) THEN
    ALTER TABLE matching.match_results
      ADD CONSTRAINT match_results_source_message_id_stock_id_key UNIQUE (source_message_id, stock_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_match_results_stock_id
  ON matching.match_results (stock_id);

CREATE INDEX IF NOT EXISTS idx_match_results_match_run_id
  ON matching.match_results (match_run_id);
