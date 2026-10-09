'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildBrokerNotificationMessages } = require('../../src/core/broker-notifications');
const { makeStock } = require('../../tests/fixtures/stock');

function makeMatch(stockId) {
  return {
    stock: makeStock({ stock_id: stockId, area: 'Business Bay', building: 'Peninsula Four' }),
    score: { total: 92 },
    status: 'STRONG_MATCH',
  };
}

function extractStockIdsInOrder(messages) {
  const ids = [];
  for (const message of messages) {
    for (const match of message.matchAll(/🆔 (\S+)/g)) {
      ids.push(match[1]);
    }
  }
  return ids;
}

test('a small match list fits in a single message, no chunking needed', () => {
  const matches = [makeMatch('STK-0001'), makeMatch('STK-0002')];
  const messages = buildBrokerNotificationMessages({
    sourceMessageId: 'req-1',
    brokerId: 'broker-a',
    normalizedRequest: { area: 'Business Bay', budgetMin: null, budgetMax: 2500000 },
    matches,
  });
  assert.equal(messages.length, 1);
  assert.deepEqual(extractStockIdsInOrder(messages), ['STK-0001', 'STK-0002']);
});

// MANDATORY: payload larger than the provider limit must chunk without
// losing, duplicating, or reordering any match.
test('CHUNKING: a payload larger than the provider limit preserves every stock ID exactly once, in order', () => {
  const expectedIds = Array.from({ length: 60 }, (_, i) => `STK-${String(i + 1).padStart(4, '0')}`);
  const matches = expectedIds.map(makeMatch);

  const messages = buildBrokerNotificationMessages({
    sourceMessageId: 'req-large',
    brokerId: 'broker-a',
    normalizedRequest: { area: 'Business Bay', budgetMin: 2000000, budgetMax: 2500000 },
    matches,
    maxMessageLength: 1000, // force chunking deterministically in the test
  });

  assert.ok(messages.length > 1, 'expected the payload to actually require more than one message');

  for (const message of messages) {
    assert.ok(message.length <= 1000, `chunk exceeded maxMessageLength: ${message.length}`);
  }

  const actualIds = extractStockIdsInOrder(messages);
  assert.equal(actualIds.length, expectedIds.length, 'no stock ID may be lost or duplicated');
  assert.deepEqual(actualIds, expectedIds, 'stock order must be preserved across chunks');

  // Every chunk carries full request/broker context, not just the first.
  for (const message of messages) {
    assert.ok(message.includes('req-large'), 'every chunk must repeat the request context');
    assert.ok(message.includes('broker-a'), 'every chunk must repeat the broker context');
  }
});

test('chunk labels are accurate ("Part i/N") and only appear when more than one chunk exists', () => {
  const matches = Array.from({ length: 40 }, (_, i) => makeMatch(`STK-${i + 1}`));
  const messages = buildBrokerNotificationMessages({
    sourceMessageId: 'req-parts',
    brokerId: 'broker-b',
    normalizedRequest: {},
    matches,
    maxMessageLength: 800,
  });
  assert.ok(messages.length > 1);
  messages.forEach((message, i) => {
    assert.ok(message.includes(`Part ${i + 1}/${messages.length}`));
  });
});

test('zero matches never throws and produces exactly one (empty-list) message', () => {
  const messages = buildBrokerNotificationMessages({
    sourceMessageId: 'req-empty',
    brokerId: 'broker-a',
    normalizedRequest: {},
    matches: [],
  });
  assert.equal(messages.length, 1);
});
