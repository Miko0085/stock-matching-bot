-- New Joker-fed markets (2026-09-28) -- Oman, Saudi Arabia (stock), Turkey.
-- See docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md section 8 and
-- AGENTS.md section 0 (updated in the same commit as this migration, per
-- its own change-control rule for any contour-set change).
--
-- IMPORTANT: `matching_saudi` here is a DIFFERENT thing from the existing
-- `SAUDI` source-ROUTING label (migration 0024, ingest.source_routes.
-- route_mode). That one is about which contour an incoming Telegram/
-- WhatsApp message routes to; this one is a Joker-fed STOCK table for
-- browsing available inventory. They may one day be used by the same
-- future Saudi matching service, but today neither reads the other.
--
-- All 3 schemas get the identical table shape as matching_rf (migration
-- 0025) -- same normalized Joker stock contract applies to every
-- Joker-sourced market. A real full-catalog scan (2026-09-28) found ZERO
-- Joker objects tagged region 'Оман' or 'Саудовская Аравия' -- these
-- tables are created ready for future data, not populated by this
-- migration or expected to be non-empty immediately after the next sync.
--
-- Deliberately NOT touching matching.* (UAE) or matching_rf.* (already
-- migrated in 0025) -- additive only, one DO block per schema so a
-- partial failure on one market never affects the others.
DO $$
DECLARE
  schema_name TEXT;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['matching_oman', 'matching_saudi', 'matching_turkey']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = schema_name) THEN
      EXECUTE format('CREATE SCHEMA %I', schema_name);
    END IF;

    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %I.stock_inventory (
        id BIGSERIAL PRIMARY KEY,
        joker_object_id BIGINT NOT NULL,
        joker_url TEXT,
        available BOOLEAN NOT NULL DEFAULT true,

        deal_type TEXT,

        property_type_raw TEXT,
        property_type TEXT,
        property_type_excluded BOOLEAN NOT NULL DEFAULT false,

        city TEXT,
        district_raw TEXT,
        district TEXT,
        complex_raw TEXT,
        complex TEXT,

        rooms_raw TEXT,
        rooms INTEGER,
        rooms_sentinel TEXT CHECK (rooms_sentinel IS NULL OR rooms_sentinel IN ('STUDIO', 'FREE_PLAN')),
        bedrooms INTEGER,

        area_sqm NUMERIC,
        floor INTEGER,
        floors_total INTEGER,

        price NUMERIC,

        readiness_year INTEGER,
        readiness_quarter INTEGER CHECK (readiness_quarter IS NULL OR readiness_quarter BETWEEN 1 AND 4),

        agent_id INTEGER,
        agent_name TEXT,
        agent_phone TEXT,
        agent_email TEXT,

        include_in_matching BOOLEAN NOT NULL DEFAULT true,
        raw_payload JSONB,

        synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    $ddl$, schema_name);

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = schema_name || '_stock_inventory_joker_object_id_key'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.stock_inventory ADD CONSTRAINT %I UNIQUE (joker_object_id)',
        schema_name, schema_name || '_stock_inventory_joker_object_id_key'
      );
    END IF;

    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_stock_inventory_available ON %I.stock_inventory (available)', schema_name, schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_stock_inventory_district ON %I.stock_inventory (district)', schema_name, schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_stock_inventory_complex ON %I.stock_inventory (complex)', schema_name, schema_name);

    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %I.location_aliases (
        id BIGSERIAL PRIMARY KEY,
        alias_type TEXT NOT NULL CHECK (alias_type IN ('district', 'complex')),
        alias_normalized TEXT NOT NULL,
        canonical_value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    $ddl$, schema_name);

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = schema_name || '_location_aliases_type_alias_key'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.location_aliases ADD CONSTRAINT %I UNIQUE (alias_type, alias_normalized)',
        schema_name, schema_name || '_location_aliases_type_alias_key'
      );
    END IF;

    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %I.stock_sync_runs (
        id BIGSERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'RUNNING',
        objects_seen INTEGER,
        objects_upserted INTEGER,
        objects_marked_unavailable INTEGER,
        error TEXT
      )
    $ddl$, schema_name);

    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_stock_sync_runs_started_at ON %I.stock_sync_runs (started_at DESC)', schema_name, schema_name);
  END LOOP;
END $$;
