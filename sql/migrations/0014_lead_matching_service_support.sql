-- Standalone Lead Matching Service support (TZ 67-68: additive,
-- backward-compatible, no destructive changes). Reuses matching.match_runs
-- rather than a separate table -- the old n8n pipeline keeps writing rows
-- with its existing statuses/columns unaffected; every column added here
-- is nullable so existing rows stay valid without a backfill.

-- The new service's result statuses (TZ 72) don't fit the old CHECK
-- constraint, which only allowed STRONG_MATCH/MATCH/NO_MATCH/ERROR.
-- Widened, never narrowed -- STRONG_MATCH stays valid for the old
-- pipeline's rows and future writes.
ALTER TABLE matching.match_runs DROP CONSTRAINT IF EXISTS match_runs_result_status_check;
ALTER TABLE matching.match_runs ADD CONSTRAINT match_runs_result_status_check
  CHECK (result_status IN (
    'STRONG_MATCH', 'MATCH', 'NO_MATCH', 'ERROR',
    'REJECTED', 'DUPLICATE', 'PARSER_ERROR', 'INSUFFICIENT_CRITERIA'
  ));

-- TZ 68's minimum match_run persistence list: provider/source_url/
-- group_name/original_text have no dedicated column today -- the old
-- pipeline only ever stored them inside parsed_request/normalized_request
-- JSONB. The new service needs original_text to survive 1:1, queryable,
-- independent of whatever shape parsed_request happens to take.
ALTER TABLE matching.match_runs ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE matching.match_runs ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE matching.match_runs ADD COLUMN IF NOT EXISTS group_name TEXT;
ALTER TABLE matching.match_runs ADD COLUMN IF NOT EXISTS original_text TEXT;
