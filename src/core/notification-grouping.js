'use strict';

// Groups one request's already broker-resolved matches into one entry per
// (source_message_id, broker_id) pair — never one notification per matched
// stock item. This is the mechanism behind cross-broker isolation: each
// group's `matches` array contains only that broker's own stock, so a
// broker can never see another broker's opportunities merely because both
// matched the same buyer request (docs/BROKER_ROUTING_AND_NOTIFICATIONS.md,
// a release-blocking invariant).
//
// `matchesWithBroker` entries must each carry a `brokerId` (null allowed —
// grouped under the 'UNASSIGNED' key, still returned so the match stays
// visible to an operator rather than silently vanishing).
function groupMatchesByBroker(sourceMessageId, matchesWithBroker = []) {
  const groups = new Map();

  for (const match of matchesWithBroker) {
    const brokerId = match.brokerId ?? null;
    const key = brokerId === null ? 'UNASSIGNED' : String(brokerId);
    if (!groups.has(key)) {
      groups.set(key, { sourceMessageId, brokerId, matches: [] });
    }
    groups.get(key).matches.push(match);
  }

  return Array.from(groups.values());
}

module.exports = { groupMatchesByBroker };
