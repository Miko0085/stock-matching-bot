-- Adds ABU_DHABI as a new exclusive market route alongside DUBAI/RF/SAUDI,
-- per AGENTS.md section 0 (any change to the contour set must update both
-- AGENTS.md and docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md in the same
-- commit -- done here). Mirrors migration 0024's exact additive style
-- (SAUDI added as a label before any Saudi service existed): purely
-- additive, no UPDATE needed, since zero existing sources are being
-- reclassified to Abu Dhabi (confirmed: all are either DUBAI, RF, SAUDI,
-- or NONE today, per an explicit live check before this migration was
-- written).
--
-- BOTH keeps its existing fixed DUBAI+RF meaning unchanged -- ABU_DHABI is
-- not added to it (src/sources/route-resolver.js's `case 'BOTH'` would
-- need real redesign to become a 3-way concept; out of scope for this
-- bootstrap step, same as SAUDI never joined BOTH either).

ALTER TABLE ingest.source_routes DROP CONSTRAINT IF EXISTS source_routes_route_mode_check;
ALTER TABLE ingest.source_routes
  ADD CONSTRAINT source_routes_route_mode_check
  CHECK (route_mode IN ('DUBAI', 'RF', 'SAUDI', 'ABU_DHABI', 'BOTH', 'AUTO', 'NONE'));
