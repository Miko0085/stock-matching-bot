'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { buildServer } = require('../../src/api/server');

let pool;

const TEST_CHAT_ID = 'pocket-listing-test@g.us';
const OTHER_CHAT_ID = 'some-other-group@g.us';

before(async () => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  await pool.query(`DELETE FROM pocket_listing_ingest.processed_messages WHERE chat_id = ANY($1::text[])`, [[TEST_CHAT_ID, OTHER_CHAT_ID]]);
  await pool.query(`DELETE FROM matching_dubai.stock_inventory WHERE stock_id LIKE 'PKT-WA-%-TEST%' OR notes LIKE '%pocket-listing-ingest-test%'`);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM pocket_listing_ingest.processed_messages WHERE chat_id = ANY($1::text[])`, [[TEST_CHAT_ID, OTHER_CHAT_ID]]);
});

function buildTestApp(overrides = {}) {
  const config = {
    apiKey: 'test-key',
    webhookSecret: '',
    logLevel: 'silent',
    sourceChatIds: [TEST_CHAT_ID],
    openaiApiKey: 'test',
    openaiModel: 'test-model',
    ...overrides.config,
  };
  return buildServer({ pool, ...overrides, config });
}

function fakeClassifyAndParse(value) {
  return async () => ({ ok: true, value: { is_listing: false, city: null, area: null, building: null, property_type: null, bedrooms: null, bathrooms: null, selling_price: null, annual_rent: null, size_sqft: null, plot_size_sqft: null, furnishing: null, view: null, distress: false, confidence: null, ...value } });
}

let seq = 0;
function nextMessageId() {
  seq += 1;
  return `wh-it-${Date.now()}-${seq}`;
}

test('GET /health reports database connectivity', async () => {
  const app = buildTestApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().database, 'ok');
  await app.close();
});

test('POST /v1/webhooks/whatsapp requires X-API-Key', async () => {
  const app = buildTestApp();
  const res = await app.inject({ method: 'POST', url: '/v1/webhooks/whatsapp', payload: { chat_id: TEST_CHAT_ID, message_id: '1' } });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('a message from an unmonitored chat_id is ignored entirely -- no row, no log', async () => {
  const app = buildTestApp({ classifyAndParse: fakeClassifyAndParse({ is_listing: true, city: 'Dubai' }) });
  const messageId = nextMessageId();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/whatsapp',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: OTHER_CHAT_ID, message_id: messageId, text: 'irrelevant' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'IGNORED_CHAT');
  const { rows } = await pool.query('SELECT * FROM pocket_listing_ingest.processed_messages WHERE chat_id = $1', [OTHER_CHAT_ID]);
  assert.equal(rows.length, 0);
  await app.close();
});

test('a non-listing message (personal chat) is logged but creates no stock row', async () => {
  const app = buildTestApp({ classifyAndParse: fakeClassifyAndParse({ is_listing: false }) });
  const messageId = nextMessageId();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/whatsapp',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: TEST_CHAT_ID, message_id: messageId, text: 'Коллеги, созвон в 15:00', sender_name: 'pocket-listing-ingest-test' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'SKIPPED');
  assert.equal(res.json().reason, 'not_a_listing');

  const { rows } = await pool.query('SELECT * FROM pocket_listing_ingest.processed_messages WHERE source_message_id = $1', [`whatsapp:${TEST_CHAT_ID}:${messageId}`]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classified_as_listing, false);
  assert.equal(rows[0].skip_reason, 'not_a_listing');
  assert.equal(rows[0].stock_id, null);
  await app.close();
});

test('a genuine Dubai listing creates a NEEDS_REVIEW stock row and a log row pointing at it', async () => {
  const app = buildTestApp({
    classifyAndParse: fakeClassifyAndParse({
      is_listing: true,
      city: 'Dubai',
      area: 'Business Bay',
      building: 'Ohana - Jacob & Co',
      property_type: 'Apartment',
      bedrooms: 3,
      selling_price: 7750000,
      size_sqft: 2153,
    }),
  });
  const messageId = nextMessageId();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/whatsapp',
    headers: { 'x-api-key': 'test-key' },
    payload: {
      chat_id: TEST_CHAT_ID,
      message_id: messageId,
      text: '3BR + maid in Business Bay, Ohana - Jacob & Co, AED 7.75M',
      sender_name: 'pocket-listing-ingest-test',
      sender_id: '65842268078304@lid',
      sender_id_alt: '971501234567@s.whatsapp.net',
      posted_at: new Date().toISOString(),
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'MATCH');
  assert.match(body.stock_id, /^PKT-WA-\d{6}-\d{2}$/);

  const { rows: stockRows } = await pool.query('SELECT * FROM matching_dubai.stock_inventory WHERE stock_id = $1', [body.stock_id]);
  assert.equal(stockRows.length, 1);
  assert.equal(stockRows[0].status, 'NEEDS_REVIEW');
  assert.equal(stockRows[0].stock_source, 'POCKET_LISTING_WHATSAPP_LIVE');
  assert.equal(stockRows[0].area, 'Business Bay');
  assert.equal(Number(stockRows[0].selling_price), 7750000);
  // 2026-10-08 audit finding (PKT-WA-261008-02): broker/broker_contact
  // must come from the message's own sender, not go missing.
  assert.equal(stockRows[0].broker, 'pocket-listing-ingest-test');
  assert.equal(stockRows[0].broker_contact, 'https://wa.me/971501234567');

  const { rows: logRows } = await pool.query('SELECT * FROM pocket_listing_ingest.processed_messages WHERE source_message_id = $1', [`whatsapp:${TEST_CHAT_ID}:${messageId}`]);
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0].classified_as_listing, true);
  assert.equal(logRows[0].skip_reason, null);
  assert.equal(logRows[0].stock_id, body.stock_id);

  await pool.query('DELETE FROM matching_dubai.stock_inventory WHERE stock_id = $1', [body.stock_id]);
  await app.close();
});

test('a non-Dubai listing (Abu Dhabi/Sharjah) is logged with non_dubai_city and never written to any stock table', async () => {
  const app = buildTestApp({
    classifyAndParse: fakeClassifyAndParse({
      is_listing: true,
      city: 'Abu Dhabi',
      area: 'Al Reem Island',
      property_type: 'Apartment',
      bedrooms: 2,
      selling_price: 1800000,
    }),
  });
  const messageId = nextMessageId();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/whatsapp',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: TEST_CHAT_ID, message_id: messageId, text: '2BR in Al Reem Island, Abu Dhabi, AED 1.8M', sender_name: 'pocket-listing-ingest-test' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'SKIPPED');
  assert.equal(res.json().reason, 'non_dubai_city');

  const { rows } = await pool.query('SELECT * FROM pocket_listing_ingest.processed_messages WHERE source_message_id = $1', [`whatsapp:${TEST_CHAT_ID}:${messageId}`]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].skip_reason, 'non_dubai_city');
  assert.equal(rows[0].stock_id, null);
  await app.close();
});

test('a duplicate source_message_id is a no-op -- never re-processed, never a second OpenAI call', async () => {
  let callCount = 0;
  const app = buildTestApp({
    classifyAndParse: async (...args) => {
      callCount += 1;
      return fakeClassifyAndParse({ is_listing: false })(...args);
    },
  });
  const messageId = nextMessageId();
  const payload = { chat_id: TEST_CHAT_ID, message_id: messageId, text: 'test', sender_name: 'pocket-listing-ingest-test' };

  const first = await app.inject({ method: 'POST', url: '/v1/webhooks/whatsapp', headers: { 'x-api-key': 'test-key' }, payload });
  assert.equal(first.json().status, 'SKIPPED');

  const second = await app.inject({ method: 'POST', url: '/v1/webhooks/whatsapp', headers: { 'x-api-key': 'test-key' }, payload });
  assert.equal(second.json().status, 'DUPLICATE');

  assert.equal(callCount, 1, 'the second delivery must never call the AI parser again');
  await app.close();
});

test('an OpenAI failure writes NO processed_messages row -- a genuine webhook redelivery must be able to retry', async () => {
  const app = buildTestApp({ classifyAndParse: async () => ({ ok: false, reason: 'timeout' }) });
  const messageId = nextMessageId();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/whatsapp',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: TEST_CHAT_ID, message_id: messageId, text: 'test' },
  });
  assert.equal(res.json().status, 'PARSER_ERROR');

  const { rows } = await pool.query('SELECT * FROM pocket_listing_ingest.processed_messages WHERE source_message_id = $1', [`whatsapp:${TEST_CHAT_ID}:${messageId}`]);
  assert.equal(rows.length, 0);
  await app.close();
});

test('stock_id sequence increments correctly for two listings posted the same day', async () => {
  const postedAt = new Date().toISOString();
  const app = buildTestApp({
    classifyAndParse: fakeClassifyAndParse({ is_listing: true, city: 'Dubai', area: 'JVC', property_type: 'Apartment', bedrooms: 1, selling_price: 900000 }),
  });

  const first = await app.inject({ method: 'POST', url: '/v1/webhooks/whatsapp', headers: { 'x-api-key': 'test-key' }, payload: { chat_id: TEST_CHAT_ID, message_id: nextMessageId(), text: 'listing 1', posted_at: postedAt } });
  const second = await app.inject({ method: 'POST', url: '/v1/webhooks/whatsapp', headers: { 'x-api-key': 'test-key' }, payload: { chat_id: TEST_CHAT_ID, message_id: nextMessageId(), text: 'listing 2', posted_at: postedAt } });

  const firstId = first.json().stock_id;
  const secondId = second.json().stock_id;
  assert.notEqual(firstId, secondId);

  await pool.query('DELETE FROM matching_dubai.stock_inventory WHERE stock_id = ANY($1::text[])', [[firstId, secondId]]);
  await app.close();
});
