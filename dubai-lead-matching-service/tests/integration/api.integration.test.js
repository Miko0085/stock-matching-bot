'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { buildServer } = require('../../src/api/server');

let pool;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  // Cleans up on the way out too, not just before each test in this file --
  // otherwise seeded rows leak into the next integration test FILE sharing
  // the same disposable database (node:test runs files sequentially here,
  // --test-concurrency=1, but each file's own before/beforeEach only ever
  // runs at the start of ITS OWN tests).
  await pool.query(`DELETE FROM matching_dubai.match_results WHERE source_message_id LIKE 'api-it:%'`);
  await pool.query(`DELETE FROM matching_dubai.match_runs WHERE source_message_id LIKE 'api-it:%'`);
  await pool.query(`DELETE FROM matching_dubai.stock_inventory WHERE stock_id LIKE 'API-IT-%'`);
  await pool.query(`DELETE FROM matching_dubai.processed_events WHERE chat_id LIKE '-100api%'`);
  await pool.query(`DELETE FROM matching_dubai.message_interpretation_cache WHERE normalized_text LIKE '%api%' OR normalized_text LIKE '%business bay%'`);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM matching_dubai.match_results WHERE source_message_id LIKE 'api-it:%'`);
  await pool.query(`DELETE FROM matching_dubai.match_runs WHERE source_message_id LIKE 'api-it:%'`);
  await pool.query(`DELETE FROM matching_dubai.stock_inventory WHERE stock_id LIKE 'API-IT-%'`);
  // The cost-optimization pipeline's event dedup (matching_dubai.processed_events)
  // is PERMANENT (no time window) -- unlike match_runs above, a leftover row
  // from a previous run of this same file/fixture would make this test's
  // fixed chat_id+message_id look like a redelivered event and short-circuit
  // straight to DUPLICATE. Must be cleaned every run, not just on the way out.
  await pool.query(`DELETE FROM matching_dubai.processed_events WHERE chat_id LIKE '-100api%'`);
});

function buildTestApp({ classifyAndParse } = {}) {
  const config = {
    matcherVersion: 'lms-test', parserVersion: 'lms-test', matchPriceTolerancePct: 10,
    dedupWindowHours: 48, matchDebug: false, apiKey: 'test-key', openaiApiKey: 'x', openaiModel: 'gpt-4o-mini', logLevel: 'silent',
  };
  // This file's fixtures use synthetic chat_ids (`-100api...`) that are
  // never catalogued in ingest.sources -- opt out of the source-routing
  // gate (src/gates/source-routing.js) so these tests stay focused on the
  // classify/match/persist pipeline they're actually testing, not on
  // seeding a source catalog. Real production traffic still gets the real
  // check (see api.source-routing.integration.test.js).
  return buildServer({ config, pool, classifyAndParse, lookupSourceRoute: null });
}

test('GET /health returns ok without auth and without a live OpenAI call', async () => {
  const app = buildTestApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'ok');
  await app.close();
});

test('POST /v1/match without X-API-Key is rejected 401', async () => {
  const app = buildTestApp();
  const res = await app.inject({ method: 'POST', url: '/v1/match', payload: { request_id: 'x', source: { provider: 'telegram', original_text: 'hi' } } });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/match with an invalid body returns 400 INVALID_STRUCTURED_REQUEST', async () => {
  const app = buildTestApp();
  const res = await app.inject({ method: 'POST', url: '/v1/match', headers: { 'x-api-key': 'test-key' }, payload: { not_a_request: true } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'INVALID_STRUCTURED_REQUEST');
  await app.close();
});

test('POST /v1/match: TZ 91 area-only -> INSUFFICIENT_CRITERIA over the real API+DB path', async () => {
  const app = buildTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/match',
    headers: { 'x-api-key': 'test-key' },
    payload: { request_id: 'api-it:area-only', source: { provider: 'telegram', original_text: 'Business Bay' }, area: 'Business Bay' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'INSUFFICIENT_CRITERIA');
  await app.close();
});

test('POST /v1/match: a real match against seeded stock returns MATCH with source metadata intact (TZ 74)', async () => {
  await pool.query(
    `INSERT INTO matching_dubai.stock_inventory (stock_id, status, transaction_type, area, bedrooms, property_type, selling_price)
     VALUES ('API-IT-1','ACTIVE','SALE','Business Bay',2,'Apartment',2000000)`
  );
  const app = buildTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/match',
    headers: { 'x-api-key': 'test-key' },
    payload: {
      request_id: 'api-it:match-1',
      source: { provider: 'telegram', original_text: 'Need 2BR in Business Bay', source_url: 'https://t.me/x/1' },
      area: 'Business Bay',
      bedrooms_min: 2,
      bedrooms_max: 2,
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'MATCH');
  assert.equal(body.matches.length, 1);
  assert.equal(body.structured_request.source.original_text, 'Need 2BR in Business Bay');
  assert.equal(body.structured_request.source.source_url, 'https://t.me/x/1');
  await app.close();
});

test('POST /v1/webhooks/telegram: invalid payload (missing text) returns 400 before any AI call', async () => {
  let aiCalled = false;
  const app = buildTestApp({ classifyAndParse: async () => { aiCalled = true; return { ok: true, value: {}, warnings: [], usage: null }; } });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: '1', message_id: '1' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(aiCalled, false);
  await app.close();
});

test('POST /v1/webhooks/telegram: TZ 88 Emaar-style broker_solicitation is REJECTED end-to-end (fake AI simulating the correct classification)', async () => {
  const app = buildTestApp({
    classifyAndParse: async () => ({
      ok: true,
      value: {
        message_class: 'broker_solicitation', demand_owner: 'recipient', promotion: true, spam: false,
        transaction_type: null, area: null, project: null, building: null, property_type: null,
        bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: null, furnishing: null, cash_buyer: null, confidence: 0.9,
      },
      warnings: [],
      usage: null,
    }),
  });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: '-100api1', message_id: '900001', sender_id: '1', text: "Have a client looking to buy? Send us your client's requirements. 500+ units available." },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'REJECTED');
  await app.close();
});

test('POST /v1/webhooks/telegram: a genuine buyer request reaches MATCH end-to-end (fake AI simulating a correct sender-owned classification)', async () => {
  await pool.query(
    `INSERT INTO matching_dubai.stock_inventory (stock_id, status, transaction_type, area, bedrooms, property_type, selling_price)
     VALUES ('API-IT-2','ACTIVE','SALE','Business Bay',2,'Apartment',2000000)`
  );
  const app = buildTestApp({
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
    payload: { chat_id: '-100api2', message_id: '2', sender_id: '1', sender_name: 'John', text: 'My client is looking for a 2BR in Business Bay' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'MATCH');
  assert.equal(body.matches.length, 1);
  await app.close();
});
