-- Wires the dormant broker-routing/notifications schema (migration 0009,
-- carried into matching_dubai by 0027/0035) into a real, working feature:
-- per-broker Telegram/WhatsApp match notifications (ADR pending, see
-- docs/DECISIONS.md). As of this migration every table 0009 added for this
-- purpose is still completely empty in production and stock_inventory.
-- broker_id is 0% populated -- so this migration only ADDS what the real,
-- messy free-text broker data actually needs; nothing here is a rename or
-- a narrowing, purely additive.

-- ============================================================
-- notification_deliveries: the user confirmed dedup granularity is one
-- notification per (stock_id, source_message_id) pair, not per
-- (source_message_id, broker_id) as migration 0009 originally modeled (one
-- row could cover many stock items for one broker). stock_id is the new,
-- real dedup key; idempotency_key (the old request+broker+channel hash)
-- becomes legacy -- relaxed to nullable rather than dropped, since the
-- table has zero production rows so this is a free, safe redefinition.
-- ============================================================
ALTER TABLE matching_dubai.notification_deliveries ADD COLUMN IF NOT EXISTS stock_id TEXT;

-- Groups every stock_id row that was sent as part of the SAME outbound
-- Telegram/WhatsApp message (one message can bundle several newly-matched
-- stock items for one broker, per docs/TELEGRAM_BOT_AND_USER_MANAGEMENT.md's
-- "do not send one message per stock match" rule) -- lets a later query ask
-- "what one message did this delivery row belong to" without re-deriving it
-- from timestamps.
ALTER TABLE matching_dubai.notification_deliveries ADD COLUMN IF NOT EXISTS source_message_broker_batch_id TEXT;

ALTER TABLE matching_dubai.notification_deliveries ALTER COLUMN idempotency_key DROP NOT NULL;

-- THE dedup guarantee: a rerun/reprocess of the same (stock, request) can
-- never insert a second delivery row for the same channel, enforced at the
-- database level, not only in application logic.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_deliveries_stock_request_channel
  ON matching_dubai.notification_deliveries (stock_id, source_message_id, channel)
  WHERE stock_id IS NOT NULL;

-- For the /notifications stats panel's period/date-range filtered counts.
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_broker_channel_created
  ON matching_dubai.notification_deliveries (broker_id, channel, created_at);

-- ============================================================
-- broker_notification_routes: WhatsApp delivery needs a sending-ACCOUNT
-- selection (which of whatsapp-worker's in-memory-tracked accounts, e.g.
-- "wa_anna", sends on this route's behalf). whatsapp-worker keeps no
-- DB-tracked account table of its own (accounts are enumerable live via its
-- own GET /whatsapp/accounts), so this is a free-text column, not an FK.
-- ============================================================
ALTER TABLE matching_dubai.broker_notification_routes ADD COLUMN IF NOT EXISTS whatsapp_account_id TEXT;

COMMENT ON COLUMN matching_dubai.broker_notification_routes.whatsapp_account_id IS
  'whatsapp-worker account_id (e.g. wa_anna) this route sends from when channel = WHATSAPP. Enumerable live via GET /whatsapp/accounts; not an FK since whatsapp-worker tracks no DB-side account table.';

-- One route per broker per channel -- matches the simple per-channel toggle
-- UI on /notifications. The original 0009 schema allowed many routes per
-- broker/channel for a priority/fallback ordering feature this UI does not
-- need yet.
CREATE UNIQUE INDEX IF NOT EXISTS uq_broker_notification_routes_broker_channel
  ON matching_dubai.broker_notification_routes (broker_id, channel);

-- ============================================================
-- telegram_bots: long-polling offset bookkeeping for the new /start
-- handshake poller (dashboard/telegram-bot-poller.js). Using the bots
-- table itself rather than a new table -- one bot, one polling cursor, same
-- place its status/health already live.
-- ============================================================
ALTER TABLE matching_dubai.telegram_bots ADD COLUMN IF NOT EXISTS last_update_id BIGINT;

COMMENT ON COLUMN matching_dubai.telegram_bots.last_update_id IS
  'Last Telegram getUpdates update_id processed by the long-polling /start handler (dashboard/telegram-bot-poller.js). Persisted so a dashboard restart resumes at offset = last_update_id + 1 instead of redelivering or dropping updates. webhook_url is intentionally left unused under this polling approach rather than repurposed.';

-- ============================================================
-- brokers: a normalized-phone identity key. stock_inventory.broker_contact
-- is free text (confirmed in production: 18 distinct ACTIVE values, mixed
-- formatting, the same phone sometimes appearing under more than one
-- broker display name) -- normalized_phone is the real, stable key the
-- one-time backfill script (scripts/broker-backfill-from-stock-contacts-run.js)
-- and the live notifier both match on, since stock_inventory.broker_id
-- itself is 0% populated today and the messy display-name data can't be
-- deduped on broker_id alone.
-- ============================================================
ALTER TABLE matching_dubai.brokers ADD COLUMN IF NOT EXISTS normalized_phone TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_brokers_normalized_phone
  ON matching_dubai.brokers (normalized_phone)
  WHERE normalized_phone IS NOT NULL;

COMMENT ON COLUMN matching_dubai.brokers.normalized_phone IS
  'Bare-digits form (src/core/phone-normalize.js normalizePhoneDigits) of this broker''s contact number -- canonical identity key for matching free-text stock_inventory.broker_contact values onto one broker row, and the phone field sent to whatsapp-worker''s /whatsapp/send.';

ALTER TABLE matching_dubai.brokers ADD COLUMN IF NOT EXISTS source_display_names JSONB;

COMMENT ON COLUMN matching_dubai.brokers.source_display_names IS
  'Array of distinct free-text broker display names seen in stock_inventory.broker for this normalized_phone at backfill time (e.g. ["Pavel Goss", "Павел Nika Estate"]) -- audit trail only, so a name variant is never silently dropped; never read by the matching/notification pipeline itself.';
