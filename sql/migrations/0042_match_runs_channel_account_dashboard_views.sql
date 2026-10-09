-- Dashboard observability gap found while adding channel/route/account
-- filters to /requests and /history (2026-10-07): Dubai and Abu Dhabi's
-- pipelines both already have account_id/chat_id at matching time
-- (unifiedMessage.account_id/chat_id) but neither match_runs table had the
-- columns, so the data was silently dropped on every insert. RF's own
-- matching_moscow.match_runs already had and persisted both correctly
-- (migration 0018/0032) -- this brings Dubai/Abu Dhabi up to the same
-- shape. Additive, nullable columns; zero risk to existing rows/queries.
ALTER TABLE matching_dubai.match_runs ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE matching_dubai.match_runs ADD COLUMN IF NOT EXISTS chat_id TEXT;

ALTER TABLE matching_abu_dhabi.match_runs ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE matching_abu_dhabi.match_runs ADD COLUMN IF NOT EXISTS chat_id TEXT;

-- Second gap: matching_dubai.v_request_matches/v_match_history (migration
-- 0008, carried over by the 0035 schema rename) never surfaced
-- provider/account_id/chat_id/group_name even though match_runs has had
-- provider/group_name since 0008 itself. CREATE OR REPLACE VIEW can only
-- append columns, never reorder/drop -- safe here since we're purely
-- adding.
CREATE OR REPLACE VIEW matching_dubai.v_request_matches AS
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
  res.whatsapp_post,
  run.provider,
  run.account_id,
  run.chat_id,
  run.group_name
FROM matching_dubai.match_runs run
LEFT JOIN matching_dubai.match_results res ON res.match_run_id = run.id
LEFT JOIN matching_dubai.stock_inventory s ON s.stock_id = res.stock_id
ORDER BY run.created_at DESC, res.match_rank ASC NULLS LAST;

CREATE OR REPLACE VIEW matching_dubai.v_match_history AS
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
  res.whatsapp_post,
  run.provider,
  run.account_id,
  run.chat_id,
  run.group_name
FROM matching_dubai.match_results res
LEFT JOIN matching_dubai.stock_inventory s ON s.stock_id = res.stock_id
LEFT JOIN matching_dubai.match_runs run ON run.id = res.match_run_id;

-- Third gap: Abu Dhabi has had a real matcher live since this session
-- (matching_abu_dhabi.match_runs/match_results, migration 0036) but never
-- got its own v_request_matches/v_match_history -- migration 0040 only
-- added v_stock_match_counts for the /stock page. Same column shape as
-- Dubai's above (Abu Dhabi's stock_inventory is a verbatim port of
-- Dubai's, per 0036's own comment), now including provider/account_id/
-- chat_id/group_name from day one.
CREATE OR REPLACE VIEW matching_abu_dhabi.v_request_matches AS
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
  res.whatsapp_post,
  run.provider,
  run.account_id,
  run.chat_id,
  run.group_name
FROM matching_abu_dhabi.match_runs run
LEFT JOIN matching_abu_dhabi.match_results res ON res.match_run_id = run.id
LEFT JOIN matching_abu_dhabi.stock_inventory s ON s.stock_id = res.stock_id
ORDER BY run.created_at DESC, res.match_rank ASC NULLS LAST;

CREATE OR REPLACE VIEW matching_abu_dhabi.v_match_history AS
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
  res.whatsapp_post,
  run.provider,
  run.account_id,
  run.chat_id,
  run.group_name
FROM matching_abu_dhabi.match_results res
LEFT JOIN matching_abu_dhabi.stock_inventory s ON s.stock_id = res.stock_id
LEFT JOIN matching_abu_dhabi.match_runs run ON run.id = res.match_run_id;

-- Fourth gap: Moscow/RF has real matching live too (ADR-042) but has no
-- dashboard request/history view at all. Deliberately NOT reusing Dubai's
-- column names (AGENTS.md section 0: "Do NOT make RF criteria fit Dubai
-- fields or vice versa") -- Moscow's own stock identity is
-- stock_joker_object_id (BIGINT) and its stock fields are
-- district/complex/property_type_raw/price/agent_name/agent_phone, not
-- area/building/property_type/selling_price/broker/broker_contact.
-- telegram_post/whatsapp_post stay BOOLEAN here (matching_moscow.match_results'
-- real column type), unlike Dubai/Abu Dhabi's TEXT link.
CREATE OR REPLACE VIEW matching_moscow.v_request_matches AS
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
  res.stock_joker_object_id,
  res.match_score,
  res.match_status,
  res.match_rank,
  s.district,
  s.complex,
  s.bedrooms,
  s.property_type_raw,
  s.price,
  s.agent_name,
  s.agent_phone,
  s.joker_url,
  res.telegram_post,
  res.whatsapp_post,
  run.provider,
  run.account_id,
  run.chat_id
FROM matching_moscow.match_runs run
LEFT JOIN matching_moscow.match_results res ON res.match_run_id = run.id
LEFT JOIN matching_moscow.stock_inventory s ON s.joker_object_id = res.stock_joker_object_id
ORDER BY run.created_at DESC, res.match_rank ASC NULLS LAST;

CREATE OR REPLACE VIEW matching_moscow.v_match_history AS
SELECT
  res.id AS match_result_id,
  res.created_at,
  res.source_message_id,
  res.stock_joker_object_id,
  res.match_score,
  res.match_status,
  res.match_rank,
  s.district,
  s.complex,
  s.bedrooms,
  s.property_type_raw,
  s.price,
  s.agent_name,
  s.agent_phone,
  s.joker_url,
  res.telegram_post,
  res.whatsapp_post,
  run.provider,
  run.account_id,
  run.chat_id
FROM matching_moscow.match_results res
LEFT JOIN matching_moscow.stock_inventory s ON s.joker_object_id = res.stock_joker_object_id
LEFT JOIN matching_moscow.match_runs run ON run.id = res.match_run_id;
