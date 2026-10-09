'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lookupSourceRoute, isAbuDhabiEligible } = require('../../src/gates/source-routing');

function fakePool(row) {
  return { query: async () => ({ rows: row ? [row] : [] }) };
}

test('isAbuDhabiEligible: [ABU_DHABI] is eligible for this contour', () => {
  assert.equal(isAbuDhabiEligible(['ABU_DHABI']), true);
});

test('isAbuDhabiEligible: a multi-market array containing ABU_DHABI is eligible, regardless of what else it holds (BOTH retired -- any combination works the same way)', () => {
  assert.equal(isAbuDhabiEligible(['DUBAI', 'ABU_DHABI']), true);
  assert.equal(isAbuDhabiEligible(['ABU_DHABI', 'RF', 'SAUDI']), true);
});

test('isAbuDhabiEligible: [DUBAI], [RF], [SAUDI], [NONE], [AUTO] are never eligible', () => {
  assert.equal(isAbuDhabiEligible(['DUBAI']), false);
  assert.equal(isAbuDhabiEligible(['RF']), false);
  assert.equal(isAbuDhabiEligible(['SAUDI']), false);
  assert.equal(isAbuDhabiEligible(['NONE']), false);
  assert.equal(isAbuDhabiEligible(['AUTO']), false, 'AUTO defaults to Dubai, must not silently route to Abu Dhabi');
});

test('isAbuDhabiEligible: a multi-market array NOT containing ABU_DHABI is never eligible', () => {
  assert.equal(isAbuDhabiEligible(['DUBAI', 'RF']), false);
});

test('lookupSourceRoute: an uncatalogued source is rejected with source_not_catalogued', async () => {
  const result = await lookupSourceRoute(fakePool(null), { provider: 'telegram', accountId: 'acc1', chatId: '-100999' });
  assert.equal(result.found, false);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'source_not_catalogued');
});

test('lookupSourceRoute: monitoring disabled rejects regardless of route_modes', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: false, route_modes: ['ABU_DHABI'] }), {
    provider: 'telegram', accountId: 'acc1', chatId: '-100999',
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'source_monitoring_disabled');
});

test('lookupSourceRoute: route_modes=[NONE] rejects with source_route_none', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['NONE'] }), {
    provider: 'telegram', accountId: 'acc1', chatId: '-100999',
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'source_route_none');
});

test('lookupSourceRoute: a DUBAI-only source is rejected, never mis-processed as Abu Dhabi stock', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['DUBAI'] }), {
    provider: 'telegram', accountId: 'acc1', chatId: '-100999',
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_abu_dhabi_eligible');
});

test('lookupSourceRoute: route_modes=[ABU_DHABI], monitored, is eligible', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['ABU_DHABI'] }), {
    provider: 'telegram', accountId: 'acc1', chatId: '-100999',
  });
  assert.equal(result.found, true);
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
});

test('lookupSourceRoute: a genuine multi-market selection [DUBAI, ABU_DHABI] is eligible for Abu Dhabi too', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['DUBAI', 'ABU_DHABI'] }), {
    provider: 'telegram', accountId: 'acc1', chatId: '-100999',
  });
  assert.equal(result.eligible, true);
});
