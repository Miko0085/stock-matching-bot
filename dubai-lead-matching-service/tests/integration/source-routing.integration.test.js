'use strict';

// Integration coverage for src/gates/source-routing.js wired into the real
// webhook pipeline via buildServer() -- NOT overriding lookupSourceRoute,
// so these exercise the actual DB-backed gate an operator's /sources page
// decisions feed into, not a mock.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { buildServer } = require('../../src/api/server');

let pool;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  await pool.query(`DELETE FROM matching_dubai.match_runs WHERE source_message_id LIKE 'src-route-it:%'`);
  await pool.query(`DELETE FROM matching_dubai.processed_events WHERE chat_id LIKE '-100srcroute%'`);
  await pool.query(`DELETE FROM ingest.sources WHERE external_source_id LIKE '-100srcroute%'`);
  await pool.query(`DELETE FROM matching_dubai.stock_inventory WHERE stock_id LIKE 'SRC-ROUTE-IT-%'`);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM matching_dubai.match_runs WHERE source_message_id LIKE 'src-route-it:%'`);
  await pool.query(`DELETE FROM matching_dubai.processed_events WHERE chat_id LIKE '-100srcroute%'`);
  await pool.query(`DELETE FROM ingest.sources WHERE external_source_id LIKE '-100srcroute%'`);
});

function buildTestApp() {
  const config = {
    matcherVersion: 'lms-test', parserVersion: 'lms-test', matchPriceTolerancePct: 10,
    dedupWindowHours: 48, matchDebug: false, apiKey: 'test-key', openaiApiKey: 'x', openaiModel: 'gpt-4o-mini', logLevel: 'silent',
  };
  const classifyAndParse = async () => {
    throw new Error('classifyAndParse must never be called for a source-routing-ineligible message (would waste a real AI call)');
  };
  return buildServer({ config, pool, classifyAndParse });
}

// `routeModes` (array, 2026-10-06 migration 0041 -- multi-route selection)
// replaces the old single `routeMode` string; a caller still wanting one
// market just passes a one-element array, e.g. `['DUBAI']`.
async function seedSource(chatId, { monitoringEnabled, routeModes }) {
  const { rows } = await pool.query(
    `INSERT INTO ingest.sources (provider, account_id, external_source_id, name)
     VALUES ('telegram', 'tg_main', $1, 'source-routing integration fixture')
     RETURNING id`,
    [chatId]
  );
  // upsertSource() (src/sources/source-repository.js) creates this row at
  // the application layer, not via a DB trigger/default -- a raw INSERT
  // into ingest.sources alone leaves NO ingest.source_routes row at all.
  await pool.query(
    `INSERT INTO ingest.source_routes (source_id, monitoring_enabled, route_modes)
     VALUES ($1, $2, $3)`,
    [rows[0].id, monitoringEnabled, routeModes]
  );
}

test('not catalogued at all -> REJECTED, never calls AI', async () => {
  const app = buildTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: '-100srcroute1', account_id: 'tg_main', message_id: '1', sender_id: '101', text: 'not catalogued fixture text' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'REJECTED');
  await app.close();
});

test('catalogued but monitoring_enabled=false -> REJECTED, never calls AI', async () => {
  await seedSource('-100srcroute2', { monitoringEnabled: false, routeModes: ['DUBAI'] });
  const app = buildTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: '-100srcroute2', account_id: 'tg_main', message_id: '1', sender_id: '102', text: 'monitoring disabled fixture text' },
  });
  assert.equal(res.json().status, 'REJECTED');
  await app.close();
});

test('monitoring on but route_mode=NONE -> REJECTED, never calls AI', async () => {
  await seedSource('-100srcroute3', { monitoringEnabled: true, routeModes: ['NONE'] });
  const app = buildTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: '-100srcroute3', account_id: 'tg_main', message_id: '1', sender_id: '103', text: 'route none fixture text' },
  });
  assert.equal(res.json().status, 'REJECTED');
  await app.close();
});

test('CRITICAL: route_mode=RF is rejected by the Dubai contour -- never processed here even without a live RF matcher to catch it instead', async () => {
  await seedSource('-100srcroute4', { monitoringEnabled: true, routeModes: ['RF'] });
  const app = buildTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: '-100srcroute4', account_id: 'tg_main', message_id: '1', sender_id: '104', text: 'route rf fixture text' },
  });
  assert.equal(res.json().status, 'REJECTED');
  await app.close();
});

test('monitoring on, route_mode=DUBAI -> reaches the real matcher end-to-end (MATCH)', async () => {
  await seedSource('-100srcroute5', { monitoringEnabled: true, routeModes: ['DUBAI'] });
  await pool.query(
    `INSERT INTO matching_dubai.stock_inventory (stock_id, status, transaction_type, area, bedrooms, property_type, selling_price)
     VALUES ('SRC-ROUTE-IT-1','ACTIVE','SALE','Business Bay',2,'Apartment',2000000)`
  );
  const config = {
    matcherVersion: 'lms-test', parserVersion: 'lms-test', matchPriceTolerancePct: 10,
    dedupWindowHours: 48, matchDebug: false, apiKey: 'test-key', openaiApiKey: 'x', openaiModel: 'gpt-4o-mini', logLevel: 'silent',
  };
  const app = buildServer({
    config,
    pool,
    classifyAndParse: async () => ({
      ok: true,
      value: {
        message_class: 'buyer_request', demand_owner: 'sender', promotion: false, spam: false,
        transaction_type: 'SALE', area: 'Business Bay', project: null, building: null, property_type: null,
        bedrooms_min: 2, bedrooms_max: 2, budget_min: null, budget_max: null, furnishing: null, cash_buyer: null, confidence: 0.9,
      },
      warnings: [],
      usage: { model: 'gpt-4o-mini', promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0.001 },
    }),
  });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: '-100srcroute5', account_id: 'tg_main', message_id: '1', sender_id: '1', sender_name: 'John', text: 'My client wants a 2BR in Business Bay' },
  });
  assert.equal(res.json().status, 'MATCH');
  await pool.query(`DELETE FROM matching_dubai.stock_inventory WHERE stock_id = 'SRC-ROUTE-IT-1'`);
  await app.close();
});

test('monitoring on, route_modes=[DUBAI, RF] (multi-route, 2026-10-06) -> also reaches the real matcher (Dubai-eligible)', async () => {
  await seedSource('-100srcroute6', { monitoringEnabled: true, routeModes: ['DUBAI', 'RF'] });
  // A non-throwing fake here (unlike buildTestApp()'s) proves this
  // multi-market source actually reaches the AI stage instead of being
  // rejected by the routing gate -- BOTH is retired as a magic word, this
  // is just one of many possible combinations now.
  const okApp = buildServer({
    config: { matcherVersion: 'lms-test', parserVersion: 'lms-test', matchPriceTolerancePct: 10, dedupWindowHours: 48, matchDebug: false, apiKey: 'test-key', openaiApiKey: 'x', openaiModel: 'gpt-4o-mini', logLevel: 'silent' },
    pool,
    classifyAndParse: async () => ({ ok: false, reason: 'not_a_buyer_request', warnings: [], usage: null }),
  });
  const res = await okApp.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: '-100srcroute6', account_id: 'tg_main', message_id: '1', sender_id: '106', text: 'route both fixture text' },
  });
  assert.equal(res.json().status, 'PARSER_ERROR'); // reached AI (proves eligibility), AI just declined to classify it
  await okApp.close();
});
