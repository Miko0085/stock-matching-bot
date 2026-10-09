-- Multi-route source selection (2026-10-06, user request): replaces the
-- single `route_mode` column with an array `route_modes` so one Telegram/
-- WhatsApp source can be routed to ANY combination of real markets, not
-- just the one hardcoded `BOTH` pair (DUBAI+RF). `BOTH` is retired as a
-- stored value -- its old rows become the literal `['DUBAI','RF']` array,
-- which is now just one of many possible combinations, not a magic word.
--
-- `AUTO` and `NONE` remain mutually-exclusive SENTINEL states: a row may
-- hold `['AUTO']`, `['NONE']`, or any non-empty subset of the four real
-- market labels -- never AUTO/NONE mixed with a real label or with each
-- other. Enforced here at the DB layer (CHECK) AND again at the
-- application layer (src/sources/source-repository.js's
-- validateRouteModes) -- same two-independent-layers discipline already
-- used for `location_*` settings in config-validation.js.
--
-- Column RENAMED, not just retyped: every leftover scalar `route_mode`
-- reference (a stale `r.route_mode = $1` SQL string, a stale JS
-- `patch.routeMode`) now fails loudly with "column does not exist" /
-- "field does not exist" instead of silently comparing a string to an
-- array and always being false -- same deliberate-rename-for-safety
-- reasoning as the Dubai rename (ADR-043).

ALTER TABLE ingest.source_routes ADD COLUMN IF NOT EXISTS route_modes TEXT[];

UPDATE ingest.source_routes
SET route_modes = CASE route_mode
  WHEN 'BOTH' THEN ARRAY['DUBAI', 'RF']
  ELSE ARRAY[route_mode]
END
WHERE route_modes IS NULL;

ALTER TABLE ingest.source_routes ALTER COLUMN route_modes SET NOT NULL;
ALTER TABLE ingest.source_routes ALTER COLUMN route_modes SET DEFAULT ARRAY['NONE'];

ALTER TABLE ingest.source_routes DROP COLUMN IF EXISTS route_mode;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'source_routes_route_modes_valid'
  ) THEN
    ALTER TABLE ingest.source_routes
      ADD CONSTRAINT source_routes_route_modes_valid CHECK (
        cardinality(route_modes) > 0
        AND route_modes <@ ARRAY['DUBAI', 'RF', 'SAUDI', 'ABU_DHABI', 'AUTO', 'NONE']
        AND (NOT ('AUTO' = ANY(route_modes)) OR cardinality(route_modes) = 1)
        AND (NOT ('NONE' = ANY(route_modes)) OR cardinality(route_modes) = 1)
      );
  END IF;
END $$;
