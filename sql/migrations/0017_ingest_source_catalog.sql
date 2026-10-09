-- Shared source/control-plane schema (AGENTS.md / MARKET_CONTOURS_AND_
-- SOURCE_ROUTING.md, section "Database separation"). Purely additive: a
-- brand new `ingest` schema, no existing table/column is touched.
--
-- This is infrastructure-level data ONLY (which chats exist, whether we
-- listen to them, which market contour they route to) -- it must never
-- hold UAE/RF domain matching data. A UAE matcher must never query
-- matching_rf.*; an RF matcher must never query matching_uae.*; NEITHER
-- may query anything in here for property-matching decisions beyond
-- "should I even process this source, and if so, which contour(s)."

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ingest') THEN
    EXECUTE 'CREATE SCHEMA ingest';
  END IF;
END $$;

-- One row per discovered Telegram/WhatsApp chat/group/channel, synced
-- from the workers' own already-authenticated sessions (never a second
-- Telethon/Baileys connection). Identity is (provider, account_id,
-- external_source_id) -- the SAME chat seen from two different worker
-- accounts is intentionally two distinct rows (P1.6: multi-account
-- identity must never collapse to chat_id alone).
CREATE TABLE IF NOT EXISTS ingest.sources (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('telegram', 'whatsapp')),
  account_id TEXT NOT NULL,
  external_source_id TEXT NOT NULL,
  source_type TEXT,
  name TEXT,
  username_or_handle TEXT,
  member_count INTEGER,
  joined BOOLEAN NOT NULL DEFAULT true,
  available BOOLEAN NOT NULL DEFAULT true,
  last_seen_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ingest_sources_identity_key'
  ) THEN
    ALTER TABLE ingest.sources
      ADD CONSTRAINT ingest_sources_identity_key UNIQUE (provider, account_id, external_source_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ingest_sources_provider_account ON ingest.sources (provider, account_id);
CREATE INDEX IF NOT EXISTS idx_ingest_sources_available ON ingest.sources (available);

-- Operator-controlled routing/monitoring decision, one row per source.
-- Deliberately a SEPARATE table from ingest.sources (source identity vs.
-- operator decision are different lifecycles): re-syncing a source
-- refreshes ingest.sources' own descriptive columns freely, but must
-- NEVER touch this table's monitoring_enabled/route_mode/manual_override/
-- notes -- a re-sync overwriting an operator's decision was an explicit
-- release blocker to avoid.
CREATE TABLE IF NOT EXISTS ingest.source_routes (
  source_id BIGINT PRIMARY KEY REFERENCES ingest.sources (id) ON DELETE CASCADE,
  monitoring_enabled BOOLEAN NOT NULL DEFAULT false,
  route_mode TEXT NOT NULL DEFAULT 'NONE' CHECK (route_mode IN ('UAE', 'RF', 'BOTH', 'AUTO', 'NONE')),
  manual_override BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- One row per sync attempt (a full Telegram or WhatsApp account sweep),
-- for observability -- never a dependency of the sync logic itself.
CREATE TABLE IF NOT EXISTS ingest.source_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('telegram', 'whatsapp')),
  account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED')),
  sources_seen INTEGER NOT NULL DEFAULT 0,
  sources_created INTEGER NOT NULL DEFAULT 0,
  sources_updated INTEGER NOT NULL DEFAULT 0,
  sources_marked_unavailable INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingest_source_sync_runs_provider_account
  ON ingest.source_sync_runs (provider, account_id, started_at DESC);

-- Shared PHYSICAL event idempotency for a future shared ingress/router
-- layer sitting in front of the UAE/RF contours (Section 14 of the
-- architecture doc). This is intentionally a SEPARATE table from
-- matching.processed_events (the UAE contour's own, already-wired-in
-- webhook dedup) -- the two answer different questions at different
-- points in the eventual pipeline and must not be conflated. Not yet
-- read/written by any running service in this change; it exists so the
-- shared-ingress design can be implemented without another migration.
CREATE TABLE IF NOT EXISTS ingest.processed_events (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_id TEXT,
  chat_id TEXT,
  message_id TEXT,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED_RETRYABLE')),
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 1,
  completed_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ingest_processed_events_event_key_key'
  ) THEN
    ALTER TABLE ingest.processed_events
      ADD CONSTRAINT ingest_processed_events_event_key_key UNIQUE (event_key);
  END IF;
END $$;
