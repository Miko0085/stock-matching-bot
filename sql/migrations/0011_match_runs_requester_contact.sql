-- Requester contact info (ADR-022). Telegram/WhatsApp already compute this
-- at message-arrival time in production's DEVI-envelope nodes
-- (authorProfileUrl: https://t.me/<sender_username> or
-- https://wa.me/<phone>, from the raw event itself) -- it just wasn't
-- being forwarded past Explode Raw Leads for Matching Pilot. Captured and
-- persisted here at ingestion time, once, permanently: relying on the
-- source message still existing later (to re-resolve a sender by
-- message_id) is not safe -- group messages get deleted/edited and are
-- not guaranteed to stay resolvable.
ALTER TABLE matching.match_runs ADD COLUMN IF NOT EXISTS requester_contact_url TEXT;
ALTER TABLE matching.match_runs ADD COLUMN IF NOT EXISTS requester_sender_id TEXT;
