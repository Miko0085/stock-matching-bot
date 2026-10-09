-- Abu Dhabi's own v_stock_match_counts, mirroring matching_dubai's exact
-- definition (migration 0008, the current/final version -- 0006/0007 were
-- superseded). Needed so the dashboard's /stock page can show Abu Dhabi
-- with real match_count/strong_match_count columns, same as Dubai, instead
-- of folding it into the Joker-fed "stock visibility only" markets
-- (Oman/Saudi/Turkey) which genuinely have no matching logic -- Abu Dhabi
-- DOES have a real matcher (matching_abu_dhabi.match_results), unlike
-- those three. See docs/DECISIONS.md's Abu Dhabi dashboard-split ADR.
--
-- Abu Dhabi's stock_inventory/match_results column shapes are identical to
-- Dubai's own (migration 0036 copied them verbatim, minus the broker-
-- provenance columns no matching code reads) -- so this view's definition
-- needs no adaptation beyond the schema name.

CREATE OR REPLACE VIEW matching_abu_dhabi.v_stock_match_counts AS
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
FROM matching_abu_dhabi.stock_inventory s
LEFT JOIN matching_abu_dhabi.match_results mr ON mr.stock_id = s.stock_id
GROUP BY s.stock_id, s.status, s.area, s.building, s.bedrooms, s.property_type, s.selling_price,
  s.broker, s.broker_contact;
