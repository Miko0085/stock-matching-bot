-- Broker-centric routing/notifications extension (docs/DATA_MODEL_EXTENSION.md,
-- docs/BROKER_ROUTING_AND_NOTIFICATIONS.md, docs/TELEGRAM_BOT_AND_USER_MANAGEMENT.md,
-- docs/JOKER_CRM_ADAPTER.md). Purely additive: no existing table is dropped
-- or destructively altered, and every new FK is nullable so a match/stock
-- row with unknown broker ownership stays valid (routing_status handles
-- that case explicitly instead).
--
-- Naming note: the source docs describe a generic `request_id` on
-- notification_deliveries. This pilot's existing "request" concept is
-- already `source_message_id` (matching.match_runs/match_results) — reusing
-- that name here rather than introducing a second name for the same thing.

-- ============================================================
-- brokers — canonical internal identity. External CRM IDs are never the
-- primary key here; see broker_external_identities below.
-- ============================================================
CREATE TABLE IF NOT EXISTS matching.brokers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- broker_external_identities — maps a canonical broker to external systems
-- (Joker user/agent id today, more sources later). One broker can have
-- several identities (e.g. present in Joker AND manually entered); one
-- external identity resolves to exactly one broker.
-- ============================================================
CREATE TABLE IF NOT EXISTS matching.broker_external_identities (
  id BIGSERIAL PRIMARY KEY,
  broker_id BIGINT NOT NULL REFERENCES matching.brokers (id),
  source TEXT NOT NULL,
  external_user_id TEXT,
  external_agent_id TEXT,
  external_login TEXT,
  raw_source_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_broker_external_identities_source_user
  ON matching.broker_external_identities (source, external_user_id)
  WHERE external_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_broker_external_identities_broker_id
  ON matching.broker_external_identities (broker_id);

CREATE INDEX IF NOT EXISTS idx_broker_external_identities_agent_id
  ON matching.broker_external_identities (source, external_agent_id)
  WHERE external_agent_id IS NOT NULL;

-- ============================================================
-- telegram_bots — one row per bot token. Multiple bots are supported; no
-- code path may assume a single hardcoded bot.
-- ============================================================
CREATE TABLE IF NOT EXISTS matching.telegram_bots (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  bot_username TEXT,
  bot_token TEXT,
  status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('ACTIVE', 'DISABLED', 'ERROR', 'UNKNOWN')),
  purpose TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_url TEXT,
  last_healthcheck_at TIMESTAMPTZ,
  last_successful_send_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- broker_telegram_accounts — a broker's linked Telegram identity. A broker
-- may accumulate more than one row over time (re-linked account, second
-- bot); `is_active` marks which one is current. connection_token/
-- connection_token_expires_at implement the /start=<token> single-use,
-- expiring handshake described in docs/TELEGRAM_BOT_AND_USER_MANAGEMENT.md
-- without needing a separate table: a row is created PENDING (is_verified
-- false, telegram_user_id/chat_id still null) with a token, and the bot's
-- /start webhook fills in the Telegram identity and flips is_verified once
-- the token matches and has not expired.
-- ============================================================
CREATE TABLE IF NOT EXISTS matching.broker_telegram_accounts (
  id BIGSERIAL PRIMARY KEY,
  broker_id BIGINT NOT NULL REFERENCES matching.brokers (id),
  telegram_user_id TEXT,
  telegram_chat_id TEXT,
  telegram_username TEXT,
  telegram_first_name TEXT,
  telegram_last_name TEXT,
  telegram_bot_id BIGINT REFERENCES matching.telegram_bots (id),
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  connection_token TEXT,
  connection_token_expires_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_broker_telegram_accounts_broker_id
  ON matching.broker_telegram_accounts (broker_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_broker_telegram_accounts_bot_chat
  ON matching.broker_telegram_accounts (telegram_bot_id, telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_broker_telegram_accounts_token
  ON matching.broker_telegram_accounts (connection_token)
  WHERE connection_token IS NOT NULL;

-- ============================================================
-- broker_notification_routes — business-configured delivery routes, not
-- merely n8n connections. A disabled/absent route is why a broker with
-- stock can still end up with no notification sent (never silently dropped
-- upstream — see notification_deliveries.status = SKIPPED).
-- ============================================================
CREATE TABLE IF NOT EXISTS matching.broker_notification_routes (
  id BIGSERIAL PRIMARY KEY,
  broker_id BIGINT NOT NULL REFERENCES matching.brokers (id),
  channel TEXT NOT NULL CHECK (channel IN ('TELEGRAM', 'WHATSAPP', 'EMAIL')),
  telegram_bot_id BIGINT REFERENCES matching.telegram_bots (id),
  telegram_account_id BIGINT REFERENCES matching.broker_telegram_accounts (id),
  destination TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 1,
  min_score NUMERIC,
  notify_match BOOLEAN NOT NULL DEFAULT TRUE,
  notify_strong_match BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_broker_notification_routes_broker_id
  ON matching.broker_notification_routes (broker_id);

CREATE INDEX IF NOT EXISTS idx_broker_notification_routes_priority
  ON matching.broker_notification_routes (broker_id, priority)
  WHERE enabled;

-- ============================================================
-- notification_deliveries — one row per attempted delivery. idempotency_key
-- is unique so a retried notification job can never create an uncontrolled
-- duplicate broker message (src/core/notification-idempotency.js computes
-- it deterministically from source_message_id + broker_id + channel +
-- notification_version).
-- ============================================================
CREATE TABLE IF NOT EXISTS matching.notification_deliveries (
  id BIGSERIAL PRIMARY KEY,
  source_message_id TEXT NOT NULL,
  broker_id BIGINT NOT NULL REFERENCES matching.brokers (id),
  channel TEXT NOT NULL CHECK (channel IN ('TELEGRAM', 'WHATSAPP', 'EMAIL')),
  route_id BIGINT REFERENCES matching.broker_notification_routes (id),
  telegram_bot_id BIGINT REFERENCES matching.telegram_bots (id),
  destination TEXT,
  matches_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED')),
  idempotency_key TEXT NOT NULL,
  payload_json JSONB,
  provider_message_id TEXT,
  error_code TEXT,
  error_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_deliveries_idempotency_key
  ON matching.notification_deliveries (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_broker_id
  ON matching.notification_deliveries (broker_id);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_source_message_id
  ON matching.notification_deliveries (source_message_id);

-- ============================================================
-- joker_sync_runs — one row per Joker sync attempt, for observability and
-- to prove sync idempotency over time.
-- ============================================================
CREATE TABLE IF NOT EXISTS matching.joker_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED')),
  users_received INTEGER,
  agents_received INTEGER,
  objects_received INTEGER,
  objects_active INTEGER,
  brokers_inserted INTEGER,
  brokers_updated INTEGER,
  stock_inserted INTEGER,
  stock_updated INTEGER,
  stock_deactivated INTEGER,
  error TEXT,
  metadata_json JSONB
);

CREATE INDEX IF NOT EXISTS idx_joker_sync_runs_started_at
  ON matching.joker_sync_runs (started_at DESC);

-- ============================================================
-- channel_health_checks — one row per health probe of a monitoring worker
-- or notification bot. Deliberately NOT the same signal as "last message
-- received" (see docs/CHANNEL_MONITORING_AND_CONTROL.md when it exists) —
-- process_status/session_status/heartbeat are tracked independently so a
-- quiet-but-healthy channel isn't confused with a dead one.
-- ============================================================
CREATE TABLE IF NOT EXISTS matching.channel_health_checks (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,
  worker_key TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL CHECK (status IN ('OK', 'DEGRADED', 'DOWN', 'UNKNOWN')),
  process_status TEXT,
  session_status TEXT,
  last_message_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  latency_ms INTEGER,
  error_code TEXT,
  error_text TEXT,
  metadata_json JSONB,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channel_health_checks_worker_checked_at
  ON matching.channel_health_checks (worker_key, checked_at DESC);

-- ============================================================
-- stock_inventory extension — broker ownership + source provenance.
-- stock_source defaults to GOOGLE_SHEETS so every existing row (the only
-- source today) stays valid without a backfill step. source_updated_at and
-- synced_at already exist from earlier migrations and play the role
-- DATA_MODEL_EXTENSION.md calls source_updated_at/last_synced_at.
-- ============================================================
ALTER TABLE matching.stock_inventory ADD COLUMN IF NOT EXISTS stock_source TEXT NOT NULL DEFAULT 'GOOGLE_SHEETS';
ALTER TABLE matching.stock_inventory ADD COLUMN IF NOT EXISTS external_listing_id TEXT;
ALTER TABLE matching.stock_inventory ADD COLUMN IF NOT EXISTS broker_id BIGINT REFERENCES matching.brokers (id);
ALTER TABLE matching.stock_inventory ADD COLUMN IF NOT EXISTS listing_owner_broker_id BIGINT REFERENCES matching.brokers (id);
ALTER TABLE matching.stock_inventory ADD COLUMN IF NOT EXISTS responsible_broker_id BIGINT REFERENCES matching.brokers (id);
ALTER TABLE matching.stock_inventory ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ;
ALTER TABLE matching.stock_inventory ADD COLUMN IF NOT EXISTS raw_source_json JSONB;

CREATE INDEX IF NOT EXISTS idx_stock_inventory_broker_id
  ON matching.stock_inventory (broker_id);

CREATE INDEX IF NOT EXISTS idx_stock_inventory_stock_source
  ON matching.stock_inventory (stock_source);

-- ============================================================
-- match_results extension — snapshot broker ownership and routing outcome
-- at match creation time, so a later CRM ownership change never rewrites
-- who a historical opportunity was actually routed to.
-- ============================================================
ALTER TABLE matching.match_results ADD COLUMN IF NOT EXISTS broker_id BIGINT REFERENCES matching.brokers (id);
ALTER TABLE matching.match_results ADD COLUMN IF NOT EXISTS stock_source TEXT;
ALTER TABLE matching.match_results ADD COLUMN IF NOT EXISTS external_listing_id TEXT;
ALTER TABLE matching.match_results ADD COLUMN IF NOT EXISTS routing_status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (routing_status IN ('PENDING', 'ROUTED', 'UNASSIGNED', 'NOTIFICATIONS_CREATED', 'ERROR'));

CREATE INDEX IF NOT EXISTS idx_match_results_broker_id
  ON matching.match_results (broker_id);

CREATE INDEX IF NOT EXISTS idx_match_results_routing_status
  ON matching.match_results (routing_status)
  WHERE routing_status = 'UNASSIGNED';
