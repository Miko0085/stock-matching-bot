'use strict';

// Resolves which internal broker a stock row's opportunities route to.
// Priority is deliberately data (an ordered list of stock field names), not
// a hardcoded if/else chain, so it can be reconfigured later without
// touching call sites (docs/BROKER_ROUTING_AND_NOTIFICATIONS.md's "Routing
// priority should be configurable").
const DEFAULT_BROKER_PRIORITY = ['responsible_broker_id', 'listing_owner_broker_id', 'broker_id'];

// Returns { brokerId, resolvedFrom, routingStatus }. A match is never
// dropped when this resolves to no broker — routingStatus: 'UNASSIGNED'
// is a valid, expected outcome the caller persists rather than discards.
function resolveBrokerForStock(stock, priority = DEFAULT_BROKER_PRIORITY) {
  const source = stock || {};
  for (const field of priority) {
    const value = source[field];
    if (value !== null && value !== undefined) {
      return { brokerId: value, resolvedFrom: field, routingStatus: 'ROUTED' };
    }
  }
  return { brokerId: null, resolvedFrom: null, routingStatus: 'UNASSIGNED' };
}

module.exports = { DEFAULT_BROKER_PRIORITY, resolveBrokerForStock };
