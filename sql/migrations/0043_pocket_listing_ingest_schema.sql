-- pocket-listing-ingest-service (ADR-050, 2026-10-07): an independent
-- background process that ingests NEW WhatsApp messages from the
-- "Secondary Nika Estate" pocket-listing group, classifies+extracts
-- supply-side listing data via an LLM, and writes Dubai-only NEEDS_REVIEW
-- rows straight into matching_dubai.stock_inventory. Deliberately its own
-- schema, NOT ingest.* -- that schema is shared transport for the
-- market-contour routing system (AGENTS.md section 0); this service never
-- goes through source routing at all (it only ever looks at one hardcoded/
-- env-configured chat_id), so it gets its own, smaller home.
CREATE SCHEMA IF NOT EXISTS pocket_listing_ingest;

-- One row per processed WhatsApp message -- doubles as the event-
-- idempotency dedup key (UNIQUE source_message_id, checked before any
-- OpenAI call) and the audit log of what was skipped and why. A skipped
-- (non-listing) message is logged by message_id/sender/outcome only --
-- NOT the full personal-chat text -- this service has no business
-- permanently storing staff small talk.
CREATE TABLE IF NOT EXISTS pocket_listing_ingest.processed_messages (
  id BIGSERIAL PRIMARY KEY,
  source_message_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  posted_at TIMESTAMPTZ,
  classified_as_listing BOOLEAN NOT NULL,
  skip_reason TEXT, -- 'not_a_listing' | 'non_dubai_city' | 'invalid_stock_row:...' | NULL (NULL means a stock row was created)
  stock_id TEXT,     -- the matching_dubai.stock_inventory row created, if any
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pocket_listing_ingest_chat_id
  ON pocket_listing_ingest.processed_messages (chat_id);

CREATE INDEX IF NOT EXISTS idx_pocket_listing_ingest_created_at
  ON pocket_listing_ingest.processed_messages (created_at DESC);
