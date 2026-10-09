'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MARKETS, DEFAULT_MARKET, resolveMarketKey, resolveMatchRunsMarketKey, MATCH_RUNS_SCHEMAS } = require('../../dashboard/queries');

test('MARKETS: Dubai + Abu Dhabi (both real matchers) + the 4 Joker-fed stock-visibility-only markets', () => {
  assert.deepEqual(Object.keys(MARKETS).sort(), ['abu_dhabi', 'moscow', 'oman', 'saudi', 'turkey', 'uae']);
  for (const key of ['uae', 'abu_dhabi']) {
    assert.ok(MARKETS[key].schema, `expected ${key} to have a schema`);
    assert.equal(MARKETS[key].hasMatchCounts, true);
  }
  assert.equal(MARKETS.uae.schema, 'matching_dubai');
  assert.equal(MARKETS.abu_dhabi.schema, 'matching_abu_dhabi');
  for (const key of ['moscow', 'oman', 'saudi', 'turkey']) {
    assert.ok(MARKETS[key].schema, `expected ${key} to have a schema`);
    assert.equal(MARKETS[key].hasMatchCounts, false);
  }
});

test('resolveMarketKey: a known market key passes through unchanged', () => {
  assert.equal(resolveMarketKey('moscow'), 'moscow');
  assert.equal(resolveMarketKey('turkey'), 'turkey');
  assert.equal(resolveMarketKey('abu_dhabi'), 'abu_dhabi');
});

test('resolveMarketKey: an unknown/malicious market key falls back to the default (uae), never passed through raw', () => {
  assert.equal(resolveMarketKey('drop table'), DEFAULT_MARKET);
  assert.equal(resolveMarketKey('matching; DROP TABLE matching_dubai.stock_inventory; --'), DEFAULT_MARKET);
  assert.equal(resolveMarketKey(undefined), DEFAULT_MARKET);
  assert.equal(resolveMarketKey(''), DEFAULT_MARKET);
});

test('DEFAULT_MARKET is uae -- existing /stock links with no ?market= param must keep behaving exactly as before', () => {
  assert.equal(DEFAULT_MARKET, 'uae');
});

test('hasMatchRuns: Dubai/Abu Dhabi/Moscow have real match_runs, Oman/Saudi/Turkey do not (2026-10-07, channel/route/account filters)', () => {
  for (const key of ['uae', 'abu_dhabi', 'moscow']) {
    assert.equal(MARKETS[key].hasMatchRuns, true, `expected ${key}.hasMatchRuns === true`);
  }
  for (const key of ['oman', 'saudi', 'turkey']) {
    assert.equal(MARKETS[key].hasMatchRuns, false, `expected ${key}.hasMatchRuns === false`);
  }
});

test('MATCH_RUNS_SCHEMAS allow-list matches exactly the hasMatchRuns markets\' schemas', () => {
  const expected = new Set(Object.values(MARKETS).filter((m) => m.hasMatchRuns).map((m) => m.schema));
  assert.deepEqual(MATCH_RUNS_SCHEMAS, expected);
});

test('resolveMatchRunsMarketKey: a market with real match_runs passes through unchanged', () => {
  assert.equal(resolveMatchRunsMarketKey('uae'), 'uae');
  assert.equal(resolveMatchRunsMarketKey('abu_dhabi'), 'abu_dhabi');
  assert.equal(resolveMatchRunsMarketKey('moscow'), 'moscow');
});

test('resolveMatchRunsMarketKey: a stock-visibility-only market falls back to the default, never surfaced as a /requests or /history tab', () => {
  assert.equal(resolveMatchRunsMarketKey('oman'), DEFAULT_MARKET);
  assert.equal(resolveMatchRunsMarketKey('saudi'), DEFAULT_MARKET);
  assert.equal(resolveMatchRunsMarketKey('turkey'), DEFAULT_MARKET);
});

test('resolveMatchRunsMarketKey: an unknown/malicious market key falls back to the default, never passed through raw', () => {
  assert.equal(resolveMatchRunsMarketKey('drop table'), DEFAULT_MARKET);
  assert.equal(resolveMatchRunsMarketKey(undefined), DEFAULT_MARKET);
});
