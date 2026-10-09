'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupMatchesByBroker } = require('../../src/core/notification-grouping');
const { makeStock } = require('../../tests/fixtures/stock');

function makeMatch(stockId, brokerId, overrides = {}) {
  return {
    brokerId,
    stock: makeStock({ stock_id: stockId }),
    score: { total: 90 },
    status: 'STRONG_MATCH',
    ...overrides,
  };
}

// RELEASE BLOCKER (mandatory per the broker-routing extension spec): one
// request matching stock from two different brokers must never let either
// broker see the other's opportunities.
test('CROSS-BROKER ISOLATION: 3 matches for Broker A + 2 for Broker B produce exactly 2 groups, each seeing only its own stock', () => {
  const matches = [
    makeMatch('A1', 'broker-a'),
    makeMatch('A2', 'broker-a'),
    makeMatch('A3', 'broker-a'),
    makeMatch('B1', 'broker-b'),
    makeMatch('B2', 'broker-b'),
  ];

  const groups = groupMatchesByBroker('req-123', matches);

  assert.equal(groups.length, 2);
  const totalMatches = groups.reduce((sum, g) => sum + g.matches.length, 0);
  assert.equal(totalMatches, 5);

  const groupA = groups.find((g) => g.brokerId === 'broker-a');
  const groupB = groups.find((g) => g.brokerId === 'broker-b');

  assert.deepEqual(
    groupA.matches.map((m) => m.stock.stock_id).sort(),
    ['A1', 'A2', 'A3']
  );
  assert.deepEqual(
    groupB.matches.map((m) => m.stock.stock_id).sort(),
    ['B1', 'B2']
  );

  // Neither broker's payload contains a stock ID belonging to the other.
  assert.ok(!groupA.matches.some((m) => m.stock.stock_id.startsWith('B')));
  assert.ok(!groupB.matches.some((m) => m.stock.stock_id.startsWith('A')));
});

test('a single broker with all matches produces exactly one group with every match', () => {
  const matches = [makeMatch('X1', 'broker-x'), makeMatch('X2', 'broker-x')];
  const groups = groupMatchesByBroker('req-456', matches);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matches.length, 2);
});

test('matches with no resolved broker are grouped under UNASSIGNED, never dropped', () => {
  const matches = [makeMatch('U1', null), makeMatch('U2', null)];
  const groups = groupMatchesByBroker('req-789', matches);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].brokerId, null);
  assert.equal(groups[0].matches.length, 2);
});

test('UNASSIGNED matches and a real broker\'s matches never mix in the same group', () => {
  const matches = [makeMatch('U1', null), makeMatch('A1', 'broker-a')];
  const groups = groupMatchesByBroker('req-999', matches);
  assert.equal(groups.length, 2);
  const unassigned = groups.find((g) => g.brokerId === null);
  const brokerA = groups.find((g) => g.brokerId === 'broker-a');
  assert.equal(unassigned.matches.length, 1);
  assert.equal(brokerA.matches.length, 1);
});
