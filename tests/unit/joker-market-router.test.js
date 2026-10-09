'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveMarket, classifySkipReason, MARKET_SCHEMAS } = require('../../src/joker/joker-market-router');

test('resolveMarket: region containing "Турция" routes to turkey', () => {
  assert.equal(resolveMarket('Турция'), 'turkey');
});

test('resolveMarket: region containing "ОАЭ" is an explicit skip (null), not a market', () => {
  assert.equal(resolveMarket('ОАЭ'), null);
});

test('resolveMarket: region containing "Оман"/"Саудовская Аравия" route to their own (currently empty) tables', () => {
  assert.equal(resolveMarket('Оман'), 'oman');
  assert.equal(resolveMarket('Саудовская Аравия'), 'saudi');
});

test('resolveMarket: exact region "Москва" routes to moscow', () => {
  assert.equal(resolveMarket('Москва'), 'moscow');
});

test('resolveMarket: STRICT scope (2026-09-28) -- every other real region observed live, including Moscow OBLAST (not the city), is out of scope and skipped', () => {
  for (const region of ['Московская область', 'Санкт-Петербург', 'Краснодарский край', 'Татарстан', 'Самарская область', 'Крым', 'Грузия', 'Узбекистан', 'Южный Кипр', 'Москва и Московская область']) {
    assert.equal(resolveMarket(region), null, `expected "${region}" to be out of the strict Moscow-city scope`);
  }
});

test('resolveMarket: empty/null region (confirmed live -- some objects have none) is skipped, never assumed to be Moscow, never throws', () => {
  assert.equal(resolveMarket(null), null);
  assert.equal(resolveMarket(''), null);
  assert.equal(resolveMarket(undefined), null);
});

test('classifySkipReason: distinguishes why an object was skipped, for sync-run diagnostics only', () => {
  assert.equal(classifySkipReason('ОАЭ'), 'dubai_deliberate_skip');
  assert.equal(classifySkipReason('Санкт-Петербург'), 'out_of_moscow_scope');
  assert.equal(classifySkipReason(''), 'no_region');
  assert.equal(classifySkipReason(null), 'no_region');
});

test('MARKET_SCHEMAS: exactly the 4 Joker-fed markets, UAE deliberately absent (it keeps its existing source)', () => {
  assert.deepEqual(Object.keys(MARKET_SCHEMAS).sort(), ['moscow', 'oman', 'saudi', 'turkey']);
  assert.equal(MARKET_SCHEMAS.moscow, 'matching_moscow');
  assert.equal(MARKET_SCHEMAS.oman, 'matching_oman');
  assert.equal(MARKET_SCHEMAS.saudi, 'matching_saudi');
  assert.equal(MARKET_SCHEMAS.turkey, 'matching_turkey');
});
