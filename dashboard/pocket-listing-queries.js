'use strict';

// Read-only queries over pocket_listing_ingest.processed_messages, the
// audit log/dedup table written by the independent
// pocket-listing-ingest-service (ADR-050). This dashboard page is the
// first and only observability surface for that service -- it has no
// other UI of its own.

async function getTotals(pool) {
  const { rows } = await pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE classified_as_listing AND stock_id IS NOT NULL)::int AS listings_created,
      count(*) FILTER (WHERE NOT classified_as_listing)::int AS not_a_listing,
      count(*) FILTER (WHERE classified_as_listing AND stock_id IS NULL)::int AS skipped_other,
      max(created_at) AS latest
    FROM pocket_listing_ingest.processed_messages
  `);
  return rows[0];
}

async function getSkipReasonBreakdown(pool) {
  const { rows } = await pool.query(`
    SELECT coalesce(skip_reason, '(создан объект)') AS reason, count(*)::int AS c
    FROM pocket_listing_ingest.processed_messages
    GROUP BY 1
    ORDER BY 2 DESC
  `);
  return rows;
}

async function getRecentProcessedMessages(pool, { limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT source_message_id, chat_id, sender_name, posted_at, classified_as_listing, skip_reason, stock_id, created_at
     FROM pocket_listing_ingest.processed_messages
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { getTotals, getSkipReasonBreakdown, getRecentProcessedMessages };
