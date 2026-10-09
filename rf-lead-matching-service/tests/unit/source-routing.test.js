'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lookupSourceRoute, isRfEligible } = require('../../src/gates/source-routing');

function fakePool(row) {
  return { query: async () => ({ rows: row ? [row] : [] }) };
}

test('isRfEligible: [RF] is eligible for the Moscow contour', () => {
  assert.equal(isRfEligible(['RF']), true);
});

test('isRfEligible: a multi-market array containing RF is eligible, regardless of what else it holds (BOTH retired -- any combination works the same way)', () => {
  assert.equal(isRfEligible(['RF', 'DUBAI']), true);
  assert.equal(isRfEligible(['DUBAI', 'RF', 'ABU_DHABI']), true);
});

test('isRfEligible: [DUBAI], [SAUDI], [NONE], [AUTO] (no real market classifier -- defaults to DUBAI, not RF) are never eligible', () => {
  assert.equal(isRfEligible(['DUBAI']), false);
  assert.equal(isRfEligible(['SAUDI']), false);
  assert.equal(isRfEligible(['NONE']), false);
  assert.equal(isRfEligible(['AUTO']), false, 'AUTO must not silently start routing to RF as a side effect of this gate existing');
});

test('isRfEligible: a multi-market array NOT containing RF is never eligible', () => {
  assert.equal(isRfEligible(['DUBAI', 'ABU_DHABI']), false);
});

test('lookupSourceRoute: no ingest.sources row at all fails CLOSED, never open', async () => {
  const result = await lookupSourceRoute(fakePool(null), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.found, false);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'source_not_catalogued');
});

test('lookupSourceRoute: monitoring_enabled=false is never eligible regardless of route_modes', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: false, route_modes: ['RF'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'source_monitoring_disabled');
});

test('lookupSourceRoute: monitoring_enabled=true but route_modes=[NONE] is not eligible', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['NONE'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'source_route_none');
});

test('lookupSourceRoute: route_modes=[DUBAI] is explicitly rejected by the Moscow contour, same "own lane only" isolation Dubai enforces in reverse', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['DUBAI'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_rf_eligible');
});

test('lookupSourceRoute: route_modes=[SAUDI] is rejected -- a routing label for a different, not-yet-existing contour', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['SAUDI'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_rf_eligible');
});

test('lookupSourceRoute: route_modes=[RF] with monitoring on is eligible', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['RF'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
});

test('lookupSourceRoute: a genuine multi-market selection [RF, ABU_DHABI] is eligible for RF', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['RF', 'ABU_DHABI'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, true);
});

test('lookupSourceRoute: route_modes=[AUTO] is NOT eligible for Moscow (defaults to Dubai until a real classifier exists)', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['AUTO'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_rf_eligible');
});

test('lookupSourceRoute: an empty/missing account_id never throws -- queries with an empty string instead', async () => {
  await assert.doesNotReject(lookupSourceRoute(fakePool(null), { provider: 'whatsapp', accountId: null, chatId: '123@g.us' }));
});
