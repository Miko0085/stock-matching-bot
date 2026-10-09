-- Metabase-friendly read views over the pilot tables, all in the `matching`
-- schema. All views are CREATE OR REPLACE so this migration is safe to
-- re-run.

CREATE OR REPLACE VIEW matching.v_dashboard_summary AS
SELECT
  (SELECT count(*) FROM matching.stock_inventory WHERE status = 'ACTIVE') AS active_stock,
  (SELECT count(*) FROM matching.match_runs) AS requests_processed,
  (SELECT count(*) FROM matching.match_runs WHERE result_status IN ('MATCH', 'STRONG_MATCH')) AS requests_with_matches,
  (SELECT count(*) FROM matching.match_runs WHERE result_status = 'NO_MATCH') AS no_match_requests,
  (SELECT count(*) FROM matching.match_results) AS total_matches,
  (SELECT count(*) FROM matching.match_results WHERE match_status = 'STRONG_MATCH') AS strong_matches,
  (SELECT count(DISTINCT stock_id) FROM matching.match_results) AS unique_stock_with_matches,
  (SELECT round(
      count(*)::numeric / NULLIF((SELECT count(*) FROM matching.match_runs), 0), 2
    ) FROM matching.match_results) AS avg_matches_per_request;

-- Stock view: unique matched-request count + strong-match count per stock item.
CREATE OR REPLACE VIEW matching.v_stock_match_counts AS
SELECT
  s.stock_id,
  s.status,
  s.area,
  s.building,
  s.bedrooms,
  s.property_type,
  s.selling_price,
  count(DISTINCT mr.source_message_id) AS match_count,
  count(DISTINCT mr.source_message_id) FILTER (WHERE mr.match_status = 'STRONG_MATCH') AS strong_match_count,
  max(mr.created_at) AS latest_match
FROM matching.stock_inventory s
LEFT JOIN matching.match_results mr ON mr.stock_id = s.stock_id
GROUP BY s.stock_id, s.status, s.area, s.building, s.bedrooms, s.property_type, s.selling_price;

-- Request view: every matched stock item for a given match_run, ordered by score.
CREATE OR REPLACE VIEW matching.v_request_matches AS
SELECT
  run.id AS match_run_id,
  run.source_message_id,
  run.result_status,
  run.parsed_request,
  run.normalized_request,
  run.matches_count,
  run.no_match_reason,
  run.created_at AS run_created_at,
  res.id AS match_result_id,
  res.stock_id,
  res.match_score,
  res.match_status,
  res.match_rank
FROM matching.match_runs run
LEFT JOIN matching.match_results res ON res.match_run_id = run.id
ORDER BY run.created_at DESC, res.match_rank ASC NULLS LAST;

-- Match history: filterable by date/area/building/bedrooms/score/status/stock.
CREATE OR REPLACE VIEW matching.v_match_history AS
SELECT
  res.id AS match_result_id,
  res.created_at,
  res.source_message_id,
  res.stock_id,
  res.match_score,
  res.match_status,
  res.match_rank,
  s.area,
  s.building,
  s.bedrooms,
  s.property_type,
  s.selling_price
FROM matching.match_results res
LEFT JOIN matching.stock_inventory s ON s.stock_id = res.stock_id;

-- Optional enrichment with the original accepted-lead source (provider,
-- group, author) when public.devi_messages exists and has the expected
-- columns. Skipped entirely (with a NOTICE) on databases that don't have it
-- (e.g. disposable test DBs) or whose shape differs, so this migration
-- always stays safe to re-run.
DO $$
BEGIN
  IF to_regclass('public.devi_messages') IS NOT NULL THEN
    BEGIN
      EXECUTE $view$
        CREATE OR REPLACE VIEW matching.v_match_history_with_source AS
        SELECT
          h.*,
          m.provider,
          m.source_url,
          m.group_name,
          m.author_name_norm AS author_name,
          m.posted_at
        FROM matching.v_match_history h
        LEFT JOIN public.devi_messages m ON m.id::text = h.source_message_id
      $view$;
    EXCEPTION WHEN OTHERS THEN
      -- public.devi_messages exists but its columns don't match the expected
      -- shape. Skip the enriched view rather than failing this migration.
      RAISE NOTICE 'Skipping matching.v_match_history_with_source: %', SQLERRM;
    END;
  END IF;
END $$;
