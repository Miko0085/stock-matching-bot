-- Adds SAUDI as a third exclusive market route alongside UAE/RF, per
-- AGENTS.md section 0 (any change to the contour set must update both
-- AGENTS.md and docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md in the same
-- commit -- done here). Mirrors RF's own bootstrap: no dedicated
-- saudi-lead-matching-service exists yet, so a SAUDI-routed message is
-- correctly rejected by lead-matching-service (src/gates/source-routing.js
-- already treats any route other than UAE/BOTH/AUTO as ineligible) until
-- that service exists -- this migration only makes the LABEL available so
-- real Saudi Arabia sources can be tagged correctly today instead of
-- being folded into UAE (found live 2026-09-27: 9 Telegram groups about
-- Saudi Arabia real estate had been marked route_mode='UAE', because no
-- other bucket existed).
--
-- BOTH keeps its existing UAE+RF meaning unchanged -- SAUDI is not added
-- to it; a source is never simultaneously UAE/RF and Saudi in practice.

ALTER TABLE ingest.source_routes DROP CONSTRAINT IF EXISTS source_routes_route_mode_check;
ALTER TABLE ingest.source_routes
  ADD CONSTRAINT source_routes_route_mode_check
  CHECK (route_mode IN ('UAE', 'RF', 'SAUDI', 'BOTH', 'AUTO', 'NONE'));
