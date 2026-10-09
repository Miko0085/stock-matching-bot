'use strict';

// P0.3 release blocker fix: event idempotency is a CLAIM with a lease, not
// a one-shot "have we seen this" flag. This is what makes at-least-once
// webhook delivery + a mid-processing crash/timeout safe: a claim that
// never reaches completeEvent() (process died, AI timed out, DB blipped)
// is reclaimable once its lease expires or once failEvent() marks it
// explicitly retryable -- an event can never be permanently consumed by
// a failed attempt.
const LEASE_SECONDS_DEFAULT = 120;

// Attempts to claim `eventKey` for processing. Succeeds (claimed: true)
// when: the event has never been seen, OR its previous attempt failed
// (FAILED_RETRYABLE), OR its previous claim's lease has expired (the
// process that held it never called completeEvent/failEvent -- a crash).
// Never succeeds for a COMPLETED event, and never succeeds twice
// concurrently for the same still-live lease (the WHERE clause on the
// ON CONFLICT DO UPDATE is evaluated atomically by Postgres row-locking,
// so two simultaneous claims for the same event_key can never both win).
async function claimEvent(pool, { eventKey, provider, accountId, chatId, messageId, leaseSeconds = LEASE_SECONDS_DEFAULT }) {
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.processed_events (event_key, provider, account_id, chat_id, message_id, status, lease_expires_at, attempts)
     VALUES ($1, $2, $3, $4, $5, 'PROCESSING', now() + ($6 || ' seconds')::interval, 1)
     ON CONFLICT (event_key) DO UPDATE SET
       status = 'PROCESSING',
       lease_expires_at = now() + ($6 || ' seconds')::interval,
       attempts = matching_dubai.processed_events.attempts + 1
     WHERE matching_dubai.processed_events.status != 'COMPLETED'
       AND (
         matching_dubai.processed_events.status = 'FAILED_RETRYABLE'
         OR matching_dubai.processed_events.lease_expires_at IS NULL
         OR matching_dubai.processed_events.lease_expires_at < now()
       )
     RETURNING id, attempts`,
    [eventKey, provider, accountId, chatId, messageId, leaseSeconds]
  );

  if (rows.length > 0) {
    return { claimed: true, attempts: rows[0].attempts };
  }

  // Not claimed -- distinguish "genuinely done" from "someone else is
  // actively processing it right now" purely for logging/diagnostics;
  // both cases are treated as DUPLICATE by the pipeline either way.
  const { rows: existing } = await pool.query(
    `SELECT status FROM matching_dubai.processed_events WHERE event_key = $1`,
    [eventKey]
  );
  const status = existing[0]?.status || null;
  return { claimed: false, reason: status === 'COMPLETED' ? 'completed' : 'leased_by_in_flight_attempt' };
}

async function completeEvent(pool, eventKey) {
  await pool.query(
    `UPDATE matching_dubai.processed_events SET status = 'COMPLETED', lease_expires_at = NULL, completed_at = now() WHERE event_key = $1`,
    [eventKey]
  );
}

async function failEvent(pool, eventKey) {
  await pool.query(
    `UPDATE matching_dubai.processed_events SET status = 'FAILED_RETRYABLE', lease_expires_at = NULL WHERE event_key = $1`,
    [eventKey]
  );
}

// Backward-compatible name kept for callers/tests migrated from the
// pre-P0.3 one-shot API -- delegates to claimEvent() and reports the
// same {isNew} shape the old signature returned.
async function recordEventIfNew(pool, args) {
  const result = await claimEvent(pool, args);
  return { isNew: result.claimed };
}

module.exports = { claimEvent, completeEvent, failEvent, recordEventIfNew, LEASE_SECONDS_DEFAULT };
