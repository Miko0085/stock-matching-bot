'use strict';

// pocket_listing_ingest.processed_messages is BOTH the event-idempotency
// dedup key (UNIQUE source_message_id, checked before any OpenAI call --
// never re-process, never double-bill) AND the audit log the user asked
// for (every processed message, listing or not, gets exactly one row).
// A new, dedicated schema -- NOT ingest.* (that schema is shared transport
// for the market-contour routing system, AGENTS.md section 0; this
// service never goes through source routing at all).

async function findProcessed(pool, sourceMessageId) {
  const { rows } = await pool.query(
    'SELECT id, stock_id FROM pocket_listing_ingest.processed_messages WHERE source_message_id = $1',
    [sourceMessageId]
  );
  return rows[0] || null;
}

async function recordProcessed(pool, { sourceMessageId, chatId, senderId, senderIdAlt = null, senderName, postedAt, classifiedAsListing, skipReason = null, stockId = null }) {
  const { rows } = await pool.query(
    `INSERT INTO pocket_listing_ingest.processed_messages
       (source_message_id, chat_id, sender_id, sender_id_alt, sender_name, posted_at, classified_as_listing, skip_reason, stock_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (source_message_id) DO NOTHING
     RETURNING id`,
    [sourceMessageId, chatId, senderId, senderIdAlt, senderName, postedAt || null, classifiedAsListing, skipReason, stockId]
  );
  return rows[0] || null;
}

module.exports = { findProcessed, recordProcessed };
