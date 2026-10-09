-- RF stock contract, now approved (2026-09-28) -- see
-- docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md section 5.1/5.1.1/5.1.2.
-- Migration 0018 deliberately left stock/alias/domain tables out of
-- `matching_rf` pending exactly this approval; this migration adds them,
-- in the SAME schema, still fully independent from `matching.*` (UAE).
--
-- Source: Joker CRM (moscow.nikaestate.ru), already integrated for
-- dashboard/joker-client.js. This is stock VISIBILITY only -- no RF
-- matching/scoring logic is implemented by this migration (RF's scoring
-- weights are still undecided, see the plan doc section 5.2).
--
-- Raw vs normalized columns are kept side by side deliberately: the raw
-- Joker value is never discarded (needed to debug/re-derive), the
-- normalized value is what a future matcher would actually filter/score
-- on. See the plan doc for the exact normalization rules encoded in
-- src/joker/joker-normalize.js.
CREATE TABLE IF NOT EXISTS matching_rf.stock_inventory (
  id BIGSERIAL PRIMARY KEY,
  joker_object_id BIGINT NOT NULL,
  joker_url TEXT,
  available BOOLEAN NOT NULL DEFAULT true,

  deal_type TEXT, -- raw Joker 'sale' | 'rent'

  property_type_raw TEXT,
  property_type TEXT, -- normalized code, NULL when excluded (e.g. commercial)
  property_type_excluded BOOLEAN NOT NULL DEFAULT false,

  city TEXT,
  district_raw TEXT,
  district TEXT, -- normalized (р-н/р-он suffix stripped)
  complex_raw TEXT,
  complex TEXT, -- normalized ЖК/МФК display name (prefix/quotes/whitespace stripped)

  rooms_raw TEXT, -- may be "Студия" / "Свободная планировка" / a numeric string
  rooms INTEGER, -- NULL when rooms_raw is non-numeric
  rooms_sentinel TEXT CHECK (rooms_sentinel IS NULL OR rooms_sentinel IN ('STUDIO', 'FREE_PLAN')),
  bedrooms INTEGER, -- Joker's separate BedroomsCount field

  area_sqm NUMERIC,
  floor INTEGER,
  floors_total INTEGER,

  price NUMERIC, -- bare RUB amount, no currency field on this Joker tenant

  readiness_year INTEGER,
  readiness_quarter INTEGER CHECK (readiness_quarter IS NULL OR readiness_quarter BETWEEN 1 AND 4),

  agent_id INTEGER,
  agent_name TEXT,
  agent_phone TEXT,
  agent_email TEXT,

  include_in_matching BOOLEAN NOT NULL DEFAULT true, -- human-curator override
  raw_payload JSONB, -- full original Joker object, for re-processing without re-fetching

  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matching_rf_stock_inventory_joker_object_id_key'
  ) THEN
    ALTER TABLE matching_rf.stock_inventory
      ADD CONSTRAINT matching_rf_stock_inventory_joker_object_id_key UNIQUE (joker_object_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_matching_rf_stock_inventory_available
  ON matching_rf.stock_inventory (available);
CREATE INDEX IF NOT EXISTS idx_matching_rf_stock_inventory_district
  ON matching_rf.stock_inventory (district);
CREATE INDEX IF NOT EXISTS idx_matching_rf_stock_inventory_complex
  ON matching_rf.stock_inventory (complex);

-- Same purpose as matching.matching_aliases for UAE -- own table, per
-- AGENTS.md section 0 ("UAE and RF MUST have independent... aliases").
-- Starts empty; populated by hand as real ЖК/district mismatches are
-- found that plain string-cleanup normalization (joker-normalize.js)
-- cannot resolve on its own (e.g. two visually unrelated spellings of the
-- same complex).
CREATE TABLE IF NOT EXISTS matching_rf.location_aliases (
  id BIGSERIAL PRIMARY KEY,
  alias_type TEXT NOT NULL CHECK (alias_type IN ('district', 'complex')),
  alias_normalized TEXT NOT NULL,
  canonical_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matching_rf_location_aliases_type_alias_key'
  ) THEN
    ALTER TABLE matching_rf.location_aliases
      ADD CONSTRAINT matching_rf_location_aliases_type_alias_key UNIQUE (alias_type, alias_normalized);
  END IF;
END $$;

-- Same shape as matching.stock_sync_runs (migration 0003) -- own table,
-- own bookkeeping, per market.
CREATE TABLE IF NOT EXISTS matching_rf.stock_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  objects_seen INTEGER,
  objects_upserted INTEGER,
  objects_marked_unavailable INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_matching_rf_stock_sync_runs_started_at
  ON matching_rf.stock_sync_runs (started_at DESC);
