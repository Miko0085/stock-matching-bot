'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lookupSourceRoute, isDubaiEligible } = require('../../src/gates/source-routing');

function fakePool(row) {
  return { query: async () => ({ rows: row ? [row] : [] }) };
}

test('isDubaiEligible: [DUBAI] and [AUTO] (no real market classifier yet) are eligible', () => {
  assert.equal(isDubaiEligible(['DUBAI']), true);
  assert.equal(isDubaiEligible(['AUTO']), true);
});

test('isDubaiEligible: a multi-market array containing DUBAI is eligible, regardless of what else it holds', () => {
  assert.equal(isDubaiEligible(['DUBAI', 'RF']), true);
  assert.equal(isDubaiEligible(['DUBAI', 'ABU_DHABI', 'SAUDI']), true);
});

test('isDubaiEligible: [RF], [SAUDI], [NONE] are never eligible for the Dubai contour', () => {
  assert.equal(isDubaiEligible(['RF']), false);
  assert.equal(isDubaiEligible(['SAUDI']), false);
  assert.equal(isDubaiEligible(['NONE']), false);
});

test('isDubaiEligible: a multi-market array NOT containing DUBAI is never eligible', () => {
  assert.equal(isDubaiEligible(['RF', 'ABU_DHABI']), false);
});

test('lookupSourceRoute: no ingest.sources row at all fails CLOSED (not eligible), never open', async () => {
  const result = await lookupSourceRoute(fakePool(null), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.found, false);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'source_not_catalogued');
});

test('lookupSourceRoute: monitoring_enabled=false is never eligible regardless of route_modes', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: false, route_modes: ['DUBAI'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'source_monitoring_disabled');
});

test('lookupSourceRoute: monitoring_enabled=true but route_modes=[NONE] is not eligible', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['NONE'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'source_route_none');
});

test('lookupSourceRoute: route_modes=[RF] is explicitly rejected -- the Dubai contour must never process it', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['RF'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_dubai_eligible');
});

test('lookupSourceRoute: route_modes=[SAUDI] is explicitly rejected -- same treatment as RF', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['SAUDI'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'not_dubai_eligible');
});

test('lookupSourceRoute: route_modes=[DUBAI] with monitoring on is eligible', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['DUBAI'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
});

test('lookupSourceRoute: a genuine multi-market selection [DUBAI, ABU_DHABI] is eligible for Dubai (BOTH retired, any combination now works the same way)', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['DUBAI', 'ABU_DHABI'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, true);
});

test('lookupSourceRoute: route_modes=[AUTO] with monitoring on is eligible (interim default until a real market classifier exists)', async () => {
  const result = await lookupSourceRoute(fakePool({ monitoring_enabled: true, route_modes: ['AUTO'] }), { provider: 'telegram', accountId: 'tg_main', chatId: '-100999' });
  assert.equal(result.eligible, true);
});

test('lookupSourceRoute: an empty/missing account_id never throws -- queries with an empty string instead', async () => {
  await assert.doesNotReject(lookupSourceRoute(fakePool(null), { provider: 'whatsapp', accountId: null, chatId: '123@g.us' }));
});
