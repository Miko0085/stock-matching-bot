-- Additive, backward-compatible diagnostics column (spec sections 20-27 of
-- the matching-correctness implementation task). Nullable JSONB -- legacy
-- n8n pilot-v1 never writes it and keeps working completely unchanged
-- (stays NULL for every pilot-v1 row, forever). Only the current
-- lead-matching-service-v1 writer populates it, and only for genuine
-- buyer-path requests that reach the matcher (see matching/diagnostics.js).
--
-- This does NOT change matching.match_runs' or matching.match_results'
-- existing unique identity, and does not migrate/backfill any historical
-- row -- purely additive, no data movement.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'matching' AND table_name = 'match_runs' AND column_name = 'match_diagnostics'
  ) THEN
    ALTER TABLE matching.match_runs ADD COLUMN match_diagnostics JSONB;
  END IF;
END $$;
