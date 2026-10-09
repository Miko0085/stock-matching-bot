-- Cost-optimization pipeline support (additive, backward-compatible --
-- nothing here changes an existing column's meaning or drops anything).
--
-- Two NEW, deliberately separate concepts (previously conflated in
-- match_runs.content_hash, which mixes text + author and was never meant
-- to be an AI-result cache):
--
--   1. matching.processed_events -- "have we seen this exact PHYSICAL
--      webhook event before" (provider + account_id + chat_id +
--      message_id for Telegram, provider + chat_id + external message id
--      for WhatsApp). Permanent (no TTL) -- a redelivered webhook for an
--      event already processed is always a duplicate, regardless of age.
--
--   2. matching.message_interpretation_cache -- "have we already paid to
--      classify/parse this exact NORMALIZED TEXT before" (author/chat/
--      provider-independent on purpose, so the same ad reposted by 20
--      different brokers is recognized as the same content). Keyed by
--      (text_hash, interpreter_version) so bumping the parser/prompt
--      version naturally invalidates every old cached interpretation --
--      old rows simply stop matching new lookups, no backfill needed.

CREATE TABLE IF NOT EXISTS matching.processed_events (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_id TEXT,
  chat_id TEXT,
  message_id TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'processed_events_event_key_key'
  ) THEN
    ALTER TABLE matching.processed_events
      ADD CONSTRAINT processed_events_event_key_key UNIQUE (event_key);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS matching.message_interpretation_cache (
  id BIGSERIAL PRIMARY KEY,
  text_hash TEXT NOT NULL,
  interpreter_version TEXT NOT NULL,
  normalized_text TEXT,
  interpretation_source TEXT NOT NULL CHECK (interpretation_source IN ('local', 'ai')),
  message_class TEXT,
  demand_owner TEXT,
  promotion BOOLEAN,
  spam BOOLEAN,
  parsed_request JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hit_count INTEGER NOT NULL DEFAULT 1
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_interpretation_cache_hash_version_key'
  ) THEN
    ALTER TABLE matching.message_interpretation_cache
      ADD CONSTRAINT message_interpretation_cache_hash_version_key
      UNIQUE (text_hash, interpreter_version);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_interpretation_cache_last_seen
  ON matching.message_interpretation_cache (last_seen_at);

-- Queryable audit trail for the new triage stage, so metrics/replay can be
-- derived from match_runs directly instead of only from log lines.
-- triage_decision: 'REJECT' | 'PARSED_LOCALLY' | 'AI_REVIEW' | NULL
--   (NULL covers pre-existing rows and event/content-level duplicates,
--   which never reach the triage stage at all).
-- interpretation_source: 'local' | 'ai' | 'cache_local' | 'cache_ai' | NULL
ALTER TABLE matching.match_runs ADD COLUMN IF NOT EXISTS triage_decision TEXT;
ALTER TABLE matching.match_runs ADD COLUMN IF NOT EXISTS interpretation_source TEXT;
