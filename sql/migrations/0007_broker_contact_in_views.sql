-- Adds broker contact info (broker, broker_contact, telegram_post,
-- whatsapp_post) and, for v_request_matches, stock detail fields — appended
-- strictly at the end of each SELECT list, since PostgreSQL's
-- CREATE OR REPLACE VIEW refuses to reorder or insert columns before
-- existing ones ("cannot change name of view column").

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
  max(mr.created_at) AS latest_match,
  s.broker,
  s.broker_contact,
  s.telegram_post,
  s.whatsapp_post
FROM matching.stock_inventory s
LEFT JOIN matching.match_results mr ON mr.stock_id = s.stock_id
GROUP BY s.stock_id, s.status, s.area, s.building, s.bedrooms, s.property_type, s.selling_price,
  s.broker, s.broker_contact, s.telegram_post, s.whatsapp_post;

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
  res.match_rank,
  s.area,
  s.building,
  s.bedrooms,
  s.property_type,
  s.selling_price,
  s.broker,
  s.broker_contact,
  s.telegram_post,
  s.whatsapp_post
FROM matching.match_runs run
LEFT JOIN matching.match_results res ON res.match_run_id = run.id
LEFT JOIN matching.stock_inventory s ON s.stock_id = res.stock_id
ORDER BY run.created_at DESC, res.match_rank ASC NULLS LAST;

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
  s.selling_price,
  s.broker,
  s.broker_contact,
  s.telegram_post,
  s.whatsapp_post
FROM matching.match_results res
LEFT JOIN matching.stock_inventory s ON s.stock_id = res.stock_id;
