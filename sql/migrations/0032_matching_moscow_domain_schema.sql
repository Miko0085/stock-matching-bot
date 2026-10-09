-- Moscow's real matching domain schema (2026-09-29): widens match_runs to
-- accept real outcomes and adds match_results, mirroring matching_uae's
-- shape (migrations 0004/0010-0014/0005) but adapted -- see
-- docs/DECISIONS.md's ADR for this change for the full "port UAE's real
-- code, not the stale AGENTS.md spec" reasoning (MATCH/NO_MATCH only, no
-- STRONG_MATCH; one JSONB score_breakdown instead of one column per
-- criterion, since Moscow has up to 15 toggleable criteria vs UAE's
-- fixed 4).

-- Widen the CHECK constraint -- guarded DROP/ADD is safe to re-run
-- (mirrors migration 0014's exact pattern for matching_uae.match_runs).
ALTER TABLE matching_moscow.match_runs DROP CONSTRAINT IF EXISTS match_runs_result_status_check;
ALTER TABLE matching_moscow.match_runs ADD CONSTRAINT match_runs_result_status_check
  CHECK (result_status IN (
    'NOT_IMPLEMENTED', 'REJECTED', 'ERROR',
    'MATCH', 'NO_MATCH', 'DUPLICATE', 'PARSER_ERROR', 'INSUFFICIENT_CRITERIA'
  ));

ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS parsed_request JSONB;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS normalized_request JSONB;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS stock_synced_at TIMESTAMPTZ;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS active_stock_count INTEGER;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS candidates_count INTEGER;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS matches_count INTEGER;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS best_score INTEGER;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS no_match_reason TEXT;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS parser_version TEXT;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS matcher_version TEXT;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS requester_contact_url TEXT;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS requester_sender_id TEXT;
ALTER TABLE matching_moscow.match_runs ADD COLUMN IF NOT EXISTS requester_name TEXT;

CREATE INDEX IF NOT EXISTS idx_matching_moscow_match_runs_content_hash ON matching_moscow.match_runs (content_hash);

-- match_results: one Request <-> one Stock pair, same UNIQUE-for-upsert
-- discipline as matching_uae.match_results (AGENTS.md section 9).
-- `stock_joker_object_id` (not a generic "stock_id" TEXT) because
-- Moscow's stock identity really is `joker_object_id` (BIGINT), unlike
-- UAE's string `stock_id`.
CREATE TABLE IF NOT EXISTS matching_moscow.match_results (
  id BIGSERIAL PRIMARY KEY,
  match_run_id BIGINT NOT NULL REFERENCES matching_moscow.match_runs(id),
  source_message_id TEXT NOT NULL,
  stock_joker_object_id BIGINT NOT NULL,
  match_score INTEGER NOT NULL,
  match_status TEXT NOT NULL CHECK (match_status = 'MATCH'),
  match_rank INTEGER NOT NULL,
  score_breakdown JSONB,
  telegram_post BOOLEAN,
  whatsapp_post BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matching_moscow_match_results_request_stock_key'
  ) THEN
    ALTER TABLE matching_moscow.match_results
      ADD CONSTRAINT matching_moscow_match_results_request_stock_key UNIQUE (source_message_id, stock_joker_object_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_matching_moscow_match_results_run ON matching_moscow.match_results (match_run_id);

-- Price tolerance setting for the real candidate/hard-filter query
-- (replaces the UAE-copied `budget_tolerance_pct` migration 0030
-- removed) -- same re-stamp-a-new-version pattern as migrations
-- 0023/0030/0031.
DO $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM matching_moscow.runtime_settings WHERE key = 'joker_price_tolerance_pct') THEN
    INSERT INTO matching_moscow.config_versions (version_number, snapshot, note, created_by)
    SELECT
      coalesce(max(version_number), 0) + 1,
      '{"phase": 1, "description": "Added joker_price_tolerance_pct (default 10) for the real Moscow candidate query/hard-filter -- replaces UAE-copied budget_tolerance_pct removed by migration 0030."}'::jsonb,
      'migration 0032: add joker_price_tolerance_pct',
      'migration:0032_matching_moscow_domain_schema'
    FROM matching_moscow.config_versions
    RETURNING id INTO v_id;

    UPDATE matching_moscow.runtime_settings SET config_version_id = v_id;
    UPDATE matching_moscow.intake_rules SET config_version_id = v_id;

    INSERT INTO matching_moscow.runtime_settings (key, value_type, value_text, config_version_id, updated_by) VALUES
      ('joker_price_tolerance_pct', 'numeric', '10', v_id, 'migration:0032')
    ON CONFLICT (key) DO NOTHING;

    UPDATE matching_moscow.config_versions
    SET snapshot = jsonb_build_object(
      'schema_version', 1,
      'config_version', (SELECT version_number FROM matching_moscow.config_versions WHERE id = v_id),
      'runtime_settings', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'key', key, 'value_type', value_type, 'value_text', value_text, 'enabled', enabled
        ) ORDER BY key), '[]'::jsonb)
        FROM matching_moscow.runtime_settings WHERE config_version_id = v_id
      ),
      'intake_rules', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'rule_group', rule_group, 'match_type', match_type, 'pattern', pattern,
          'enabled', enabled, 'priority', priority, 'description', description
        ) ORDER BY rule_group, priority, id), '[]'::jsonb)
        FROM matching_moscow.intake_rules WHERE config_version_id = v_id
      )
    )
    WHERE id = v_id;

    DELETE FROM matching_moscow.config_draft WHERE id = 1;
  END IF;
END $$;
