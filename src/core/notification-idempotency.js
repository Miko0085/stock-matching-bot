'use strict';

const crypto = require('crypto');

// Deterministic key for one (request, broker, channel, notification
// version) tuple — recomputing it for the same inputs always yields the
// same string, so a retried notification job can look up whether a
// delivery row already exists instead of blindly creating a duplicate
// broker message (unique index on matching_dubai.notification_deliveries.
// idempotency_key enforces this at the database level too).
function computeIdempotencyKey({ sourceMessageId, brokerId, channel, notificationVersion = 1 }) {
  if (!sourceMessageId) throw new Error('computeIdempotencyKey: sourceMessageId is required');
  if (brokerId === null || brokerId === undefined) {
    throw new Error('computeIdempotencyKey: brokerId is required (use the literal string "UNASSIGNED" for unassigned groups, not null)');
  }
  if (!channel) throw new Error('computeIdempotencyKey: channel is required');

  const raw = `${sourceMessageId}:${brokerId}:${channel}:${notificationVersion}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = { computeIdempotencyKey };
