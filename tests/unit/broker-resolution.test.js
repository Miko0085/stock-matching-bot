'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBrokerForStock, DEFAULT_BROKER_PRIORITY } = require('../../src/core/broker-resolution');

test('responsible broker is preferred over listing owner and fallback broker', () => {
  const result = resolveBrokerForStock({
    responsible_broker_id: 1,
    listing_owner_broker_id: 2,
    broker_id: 3,
  });
  assert.equal(result.brokerId, 1);
  assert.equal(result.resolvedFrom, 'responsible_broker_id');
  assert.equal(result.routingStatus, 'ROUTED');
});

test('listing owner is used when responsible broker is missing', () => {
  const result = resolveBrokerForStock({
    responsible_broker_id: null,
    listing_owner_broker_id: 2,
    broker_id: 3,
  });
  assert.equal(result.brokerId, 2);
  assert.equal(result.resolvedFrom, 'listing_owner_broker_id');
  assert.equal(result.routingStatus, 'ROUTED');
});

test('fallback broker_id is used when responsible and listing owner are both missing', () => {
  const result = resolveBrokerForStock({
    responsible_broker_id: null,
    listing_owner_broker_id: null,
    broker_id: 3,
  });
  assert.equal(result.brokerId, 3);
  assert.equal(result.resolvedFrom, 'broker_id');
  assert.equal(result.routingStatus, 'ROUTED');
});

test('no broker anywhere resolves to UNASSIGNED, never dropped', () => {
  const result = resolveBrokerForStock({
    responsible_broker_id: null,
    listing_owner_broker_id: null,
    broker_id: null,
  });
  assert.equal(result.brokerId, null);
  assert.equal(result.resolvedFrom, null);
  assert.equal(result.routingStatus, 'UNASSIGNED');
});

test('a stock row missing every broker field entirely also resolves to UNASSIGNED', () => {
  const result = resolveBrokerForStock({});
  assert.equal(result.routingStatus, 'UNASSIGNED');
});

test('priority order is configurable, not hardcoded', () => {
  const reversedPriority = [...DEFAULT_BROKER_PRIORITY].reverse();
  const result = resolveBrokerForStock(
    { responsible_broker_id: 1, listing_owner_broker_id: 2, broker_id: 3 },
    reversedPriority
  );
  assert.equal(result.brokerId, 3);
  assert.equal(result.resolvedFrom, 'broker_id');
});
