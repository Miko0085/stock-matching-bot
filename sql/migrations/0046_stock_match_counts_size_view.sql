-- /stock's table never showed size_sqft/view even though both are real
-- columns on stock_inventory and were correctly extracted by every stock
-- source (pocket-listing-ingest-service included, confirmed: PKT-WA-261008-03
-- already had size_sqft=814/view='Full Park View' in the database) --
-- v_stock_match_counts (migration 0008, mirrored for Abu Dhabi by 0040)
-- simply never selected these two columns. CREATE OR REPLACE VIEW can only
-- append columns, never reorder/drop existing ones -- both appended at the
-- end of the SELECT list, after broker_contact, so this is a pure addition.

CREATE OR REPLACE VIEW matching_dubai.v_stock_match_counts AS
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
  s.size_sqft,
  s.view
FROM matching_dubai.stock_inventory s
LEFT JOIN matching_dubai.match_results mr ON mr.stock_id = s.stock_id
GROUP BY s.stock_id, s.status, s.area, s.building, s.bedrooms, s.property_type, s.selling_price,
  s.broker, s.broker_contact, s.size_sqft, s.view;

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
  s.broker_contact,
  s.size_sqft,
  s.view
FROM matching_abu_dhabi.stock_inventory s
LEFT JOIN matching_abu_dhabi.match_results mr ON mr.stock_id = s.stock_id
GROUP BY s.stock_id, s.status, s.area, s.building, s.bedrooms, s.property_type, s.selling_price,
  s.broker, s.broker_contact, s.size_sqft, s.view;
