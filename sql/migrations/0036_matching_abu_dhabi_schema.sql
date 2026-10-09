-- Creates the matching_abu_dhabi schema: a brand-new, fully independent
-- market contour (AGENTS.md section 0), sibling to matching_dubai and
-- matching_moscow. Abu Dhabi shares Dubai's exact business semantics
-- (AED, area/project/building/bedrooms field model, 50/30/15/5 ranking)
-- since abu-dhabi-lead-matching-service is built BY ANALOGY with
-- dubai-lead-matching-service -- but per the hard rule, stock/aliases/
-- caches/match tables must never be shared, so this is a complete,
-- separate schema, not a view onto matching_dubai.
--
-- Table shape is the PROVEN-MINIMAL working-matcher set (mirrors
-- matching_moscow's real 10-table schema exactly in shape/purpose:
-- stock_inventory, matching_aliases, stock_sync_runs, match_runs,
-- match_results, runtime_settings, intake_rules, config_versions,
-- config_draft, message_interpretation_cache) -- NOT matching_dubai's
-- full organically-grown schema (brokers/telegram_bots/ai_usage_log/
-- event_dedup/shadow_gate/dashboard views), since none of that is
-- required for a real, complete matcher and Abu Dhabi has no broker
-- system of its own. stock_inventory/match_runs/match_results column
-- lists are copied EXACTLY from matching_dubai's live schema and its own
-- repository code's actual INSERT statements (dubai-lead-matching-
-- service/src/repositories/{stock,match}-repository.js) minus the
-- migration-0009 broker-provenance columns (broker_id,
-- listing_owner_broker_id, responsible_broker_id, stock_source,
-- external_listing_id, source_created_at, raw_source_json,
-- routing_status) -- confirmed by grep that no matching/candidate-query/
-- hard-filters/matcher code references any of them.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'matching_abu_dhabi') THEN
    EXECUTE 'CREATE SCHEMA matching_abu_dhabi';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS matching_abu_dhabi.stock_inventory (
  stock_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  city TEXT,
  area TEXT,
  project_community TEXT,
  building TEXT,
  bedrooms INTEGER,
  bedrooms_label TEXT,
  bathrooms NUMERIC,
  property_type TEXT,
  selling_price NUMERIC,
  annual_rent NUMERIC,
  size_sqft NUMERIC,
  plot_size_sqft NUMERIC,
  furnishing TEXT,
  view TEXT,
  broker TEXT,
  broker_contact TEXT,
  notes TEXT,
  source_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matching_abu_dhabi.matching_aliases (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  canonical TEXT NOT NULL,
  canonical_normalized TEXT,
  parent_area TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, alias_normalized)
);

CREATE TABLE IF NOT EXISTS matching_abu_dhabi.stock_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  stock_rows_read INTEGER,
  stock_rows_active INTEGER,
  alias_rows_read INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS matching_abu_dhabi.match_runs (
  id BIGSERIAL PRIMARY KEY,
  source_message_id TEXT NOT NULL,
  provider TEXT,
  source_url TEXT,
  group_name TEXT,
  original_text TEXT,
  result_status TEXT NOT NULL,
  -- Generic reason for a REJECTED/DUPLICATE/NOT_IMPLEMENTED stage outcome
  -- (route/gate rejection text, e.g. "ROUTE_REJECT: ..."/"GATE_REJECT: ...").
  -- Distinct from no_match_reason below, which is specifically the real
  -- matcher's own NO_MATCH/INSUFFICIENT_CRITERIA diagnosis.
  reason TEXT,
  parsed_request JSONB,
  normalized_request JSONB,
  stock_synced_at TIMESTAMPTZ,
  active_stock_count INTEGER,
  candidates_count INTEGER,
  matches_count INTEGER,
  best_score NUMERIC,
  no_match_reason TEXT,
  parser_version TEXT,
  matcher_version TEXT,
  content_hash TEXT,
  requester_contact_url TEXT,
  requester_sender_id TEXT,
  requester_name TEXT,
  triage_decision TEXT,
  interpretation_source TEXT,
  match_diagnostics JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matching_abu_dhabi.match_results (
  id BIGSERIAL PRIMARY KEY,
  match_run_id BIGINT NOT NULL REFERENCES matching_abu_dhabi.match_runs(id),
  source_message_id TEXT NOT NULL,
  stock_id TEXT NOT NULL,
  match_score NUMERIC NOT NULL,
  match_status TEXT NOT NULL CHECK (match_status IN ('STRONG_MATCH', 'MATCH')),
  match_rank INTEGER,
  location_score NUMERIC,
  bedrooms_score NUMERIC,
  property_type_score NUMERIC,
  budget_score NUMERIC,
  furnishing_score NUMERIC,
  score_breakdown JSONB,
  telegram_post TEXT,
  whatsapp_post TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_message_id, stock_id)
);

-- Draft->Apply config tables (mirrors migration 0029's matching_moscow
-- shape exactly). schema_migrations is NOT created here -- it already
-- lives in the bookkeeping schema resolved by src/db/migrate.js and is
-- shared/renamed, never per-market.
CREATE TABLE IF NOT EXISTS matching_abu_dhabi.config_versions (
  id BIGSERIAL PRIMARY KEY,
  version_number INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS matching_abu_dhabi.runtime_settings (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value_type TEXT NOT NULL,
  value_text TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  config_version_id BIGINT REFERENCES matching_abu_dhabi.config_versions(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS matching_abu_dhabi.intake_rules (
  id BIGSERIAL PRIMARY KEY,
  rule_group TEXT NOT NULL CHECK (rule_group IN ('BLACKLIST', 'WHITELIST', 'PROPERTY_SIGNAL', 'SEND_TO_AI')),
  match_type TEXT NOT NULL CHECK (match_type IN ('PHRASE', 'REGEX')),
  pattern TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 100,
  description TEXT,
  config_version_id BIGINT REFERENCES matching_abu_dhabi.config_versions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_abu_dhabi_intake_rules_group_enabled
  ON matching_abu_dhabi.intake_rules (rule_group, enabled);

CREATE TABLE IF NOT EXISTS matching_abu_dhabi.config_draft (
  id INTEGER PRIMARY KEY DEFAULT 1,
  settings JSONB NOT NULL DEFAULT '[]'::jsonb,
  intake_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  based_on_version INTEGER,
  is_dirty BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matching_abu_dhabi.message_interpretation_cache (
  id BIGSERIAL PRIMARY KEY,
  text_hash TEXT NOT NULL,
  interpreter_version TEXT NOT NULL,
  normalized_text TEXT,
  interpretation_source TEXT NOT NULL,
  message_class TEXT,
  demand_owner TEXT,
  promotion BOOLEAN,
  spam BOOLEAN,
  parsed_request JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE (text_hash, interpreter_version)
);
