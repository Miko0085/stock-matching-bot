-- 2026-10-08 audit finding: PKT-WA-261008-02's broker/broker_contact were
-- both null -- pocket-listing-ingest-service (ADR-050) never mapped the
-- WhatsApp message's own sender (the person who posted the listing in
-- the group) onto stock_inventory's broker/broker_contact columns at
-- all. Fixing that requires the resolved (non-LID) phone-number form of
-- the sender, which whatsapp-worker sends as sender_id_alt
-- (wa_events.js's key.participantAlt) -- this table never stored it.
ALTER TABLE pocket_listing_ingest.processed_messages
  ADD COLUMN IF NOT EXISTS sender_id_alt TEXT;
