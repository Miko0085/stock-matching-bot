-- Renames the UAE source-routing label to DUBAI, per AGENTS.md section 0
-- (any change to the contour set must update both AGENTS.md and
-- docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md in the same commit -- done
-- here). A second, distinct UAE-country market (Abu Dhabi) is coming --
-- "UAE" can no longer mean one undifferentiated bucket, it has to name the
-- city actually served today so "ABU_DHABI" can be added later as a true
-- sibling label, the same way SAUDI was added as a label before any Saudi
-- service existed (migration 0024).
--
-- Unlike the Saudi split (which carved an ambiguous subset out of UAE via
-- a name-regex reclassify script), every row currently route_mode='UAE' is
-- unambiguously the Dubai market -- a pure rename, not a judgment call --
-- so the data migration is a single UPDATE here, not a separate
-- operator-run script. The constraint must be dropped BEFORE the UPDATE,
-- not after: the OLD constraint (no 'DUBAI' in its allow-list yet) would
-- reject the UPDATE's own target value otherwise.
--
-- lead-matching-service / dashboard / rf-lead-matching-service code that
-- reads this value must deploy in lockstep with this migration (same
-- "coordinated deploy" requirement as the matching_uae schema rename --
-- see docs/DECISIONS.md ADR-034 for the real incident that happens when
-- that's skipped).

ALTER TABLE ingest.source_routes DROP CONSTRAINT IF EXISTS source_routes_route_mode_check;

UPDATE ingest.source_routes SET route_mode = 'DUBAI' WHERE route_mode = 'UAE';

ALTER TABLE ingest.source_routes
  ADD CONSTRAINT source_routes_route_mode_check
  CHECK (route_mode IN ('DUBAI', 'RF', 'SAUDI', 'BOTH', 'AUTO', 'NONE'));
