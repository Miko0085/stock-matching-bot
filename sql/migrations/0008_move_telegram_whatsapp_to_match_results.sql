-- telegram_post/whatsapp_post never described the stock listing in practice
-- (always empty in the source sheet) — conceptually they belong to the
-- ACCEPTED REQUEST's original chat post (which channel + link the buyer's
-- message came from), not the stock item. Move them to match_results (one
-- link per successful match, derived from the request's provider) and drop
-- the unused stock columns. `notes` stays on stock_inventory — it holds real
-- per-listing remarks (condition, size, distress sale, etc.), unrelated to
-- this move.
--
-- PostgreSQL's CREATE OR REPLACE VIEW cannot drop or reorder existing output
-- columns, only append new ones — so the three views that gained
-- s.telegram_post/s.whatsapp_post in 0007 must be dropped and recreated
-- (the dependent v_match_history_with_source too, then rebuilt the same
-- conditional way 0006 originally built it).

DROP VIEW IF EXISTS matching.v_match_history_with_source;
DROP VIEW IF EXISTS matching.v_stock_match_counts;
DROP VIEW IF EXISTS matching.v_request_matches;
DROP VIEW IF EXISTS matching.v_match_history;

ALTER TABLE matching.stock_inventory DROP COLUMN IF EXISTS telegram_post;
ALTER TABLE matching.stock_inventory DROP COLUMN IF EXISTS whatsapp_post;

ALTER TABLE matching.match_results ADD COLUMN IF NOT EXISTS telegram_post TEXT;
ALTER TABLE matching.match_results ADD COLUMN IF NOT EXISTS whatsapp_post TEXT;

CREATE VIEW matching.v_stock_match_counts AS
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
  max(mr.created_at) AS latest_match,
  s.broker,
  s.broker_contact
FROM matching.stock_inventory s
LEFT JOIN matching.match_results mr ON mr.stock_id = s.stock_id
GROUP BY s.stock_id, s.status, s.area, s.building, s.bedrooms, s.property_type, s.selling_price,
  s.broker, s.broker_contact;

CREATE VIEW matching.v_request_matches AS
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
  res.match_rank,
  s.area,
  s.building,
  s.bedrooms,
  s.property_type,
  s.selling_price,
  s.broker,
  s.broker_contact,
  res.telegram_post,
  res.whatsapp_post
FROM matching.match_runs run
LEFT JOIN matching.match_results res ON res.match_run_id = run.id
LEFT JOIN matching.stock_inventory s ON s.stock_id = res.stock_id
ORDER BY run.created_at DESC, res.match_rank ASC NULLS LAST;

CREATE VIEW matching.v_match_history AS
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
  s.selling_price,
  s.broker,
  s.broker_contact,
  res.telegram_post,
  res.whatsapp_post
FROM matching.match_results res
LEFT JOIN matching.stock_inventory s ON s.stock_id = res.stock_id;

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
      RAISE NOTICE 'Skipping matching.v_match_history_with_source: %', SQLERRM;
    END;
  END IF;
END $$;
