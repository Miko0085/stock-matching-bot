'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runStructuredRequestPipeline } = require('../../src/services/pipeline');
const { buildLocationDictionary } = require('../../src/matching/location-dictionary');
const { buildAliasIndex } = require('../../../src/core/aliases');

// Qualified-buyer visibility (spec sections 34-39): both new notification
// flags default false and must never fire a real Telegram send unless an
// operator explicitly enables them -- and even then, only for the exact
// outcome each flag names (NO_MATCH / INSUFFICIENT_CRITERIA), never for
// MATCH/REJECTED/DUPLICATE. Uses the same t.mock.method(global, 'fetch')
// approach as telegram-sender.test.js -- pipeline.js calls
// notifications/telegram-sender.js's sendMatchNotification directly (not
// dependency-injected), which itself calls the global fetch.

const ALIAS_INDEX = buildAliasIndex([{ type: 'area', alias: 'Business Bay', canonical: 'Business Bay', enabled: true }]);

function makeDeps(overrides = {}) {
  const insertedRuns = [];
  const stockRepo = {
    fetchCandidates: async () => [],
    checkLocationExists: async () => true,
    getLatestStockSyncedAt: async () => null,
    getActiveStockCount: async () => 94,
  };
  const matchRepo = {
    checkDuplicate: async () => false,
    insertMatchRun: async (pool, row) => {
      insertedRuns.push(row);
      return { id: insertedRuns.length, created_at: new Date().toISOString() };
    },
    upsertMatchResult: async () => ({ id: 1 }),
  };
  const { config: configOverrides, ...restOverrides } = overrides;
  const deps = {
    config: {
      matchPriceTolerancePct: 10,
      parserVersion: 'v', matcherVersion: 'v',
      telegramNotificationsEnabled: false,
      telegramNotifyQualifiedNoMatch: false,
      telegramNotifyNeedsCriteria: false,
      telegramBotToken: 'test-token',
      telegramMatchChatId: '12345',
      telegramMaxMessageLength: 3800,
      ...configOverrides,
    },
    pool: {},
    stockRepo,
    matchRepo,
    getLocationDictionary: async () => buildLocationDictionary({ aliasIndex: ALIAS_INDEX }),
    logEvent: () => {},
    ...restOverrides,
  };
  return { deps, insertedRuns };
}

function noMatchRequest(overrides = {}) {
  return {
    request_id: 'r-nomatch-1',
    source: { provider: 'telegram', source_url: null, group_name: null, author_name: null, author_contact: null, original_text: 'Need 2BR Business Bay up to 2.5M' },
    transaction_type: 'SALE',
    area: 'Business Bay',
    project: null,
    building: null,
    property_type: null,
    bedrooms_min: 2,
    bedrooms_max: 2,
    budget_min: null,
    budget_max: 2500000,
    furnishing: null,
    cash_buyer: null,
    ai_confidence: null,
    bathrooms_min: null, bathrooms_max: null,
    size_sqft_min: null, size_sqft_max: null,
    plot_size_sqft_min: null, plot_size_sqft_max: null,
    ...overrides,
  };
}

function insufficientCriteriaRequest(overrides = {}) {
  return {
    request_id: 'r-insufficient-1',
    source: { provider: 'telegram', source_url: null, group_name: null, author_name: null, author_contact: null, original_text: 'Looking for a villa, distress only, cash buyer' },
    transaction_type: null,
    area: null,
    project: null,
    building: null,
    property_type: 'Villa',
    bedrooms_min: null,
    bedrooms_max: null,
    budget_min: null,
    budget_max: null,
    furnishing: null,
    cash_buyer: true,
    ai_confidence: null,
    bathrooms_min: null, bathrooms_max: null,
    size_sqft_min: null, size_sqft_max: null,
    plot_size_sqft_min: null, plot_size_sqft_max: null,
    ...overrides,
  };
}

test('default config (both flags false): a NO_MATCH outcome never triggers a Telegram send', async (t) => {
  let fetchCalled = false;
  t.mock.method(global, 'fetch', async () => { fetchCalled = true; return { ok: true, json: async () => ({ ok: true }) }; });
  const { deps } = makeDeps();
  const result = await runStructuredRequestPipeline({ structuredRequest: noMatchRequest(), deps });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(fetchCalled, false);
});

test('default config (both flags false): an INSUFFICIENT_CRITERIA outcome never triggers a Telegram send', async (t) => {
  let fetchCalled = false;
  t.mock.method(global, 'fetch', async () => { fetchCalled = true; return { ok: true, json: async () => ({ ok: true }) }; });
  const { deps } = makeDeps();
  const result = await runStructuredRequestPipeline({ structuredRequest: insufficientCriteriaRequest(), deps });
  assert.equal(result.status, 'INSUFFICIENT_CRITERIA');
  assert.equal(fetchCalled, false);
});

test('TELEGRAM_NOTIFY_QUALIFIED_NO_MATCH=true: a real NO_MATCH sends exactly one qualified-buyer message', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push(JSON.parse(options.body).text);
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const { deps } = makeDeps({ config: { telegramNotifyQualifiedNoMatch: true } });
  const result = await runStructuredRequestPipeline({ structuredRequest: noMatchRequest(), deps });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /🟡 QUALIFIED BUYER — NO CURRENT STOCK/);
});

test('TELEGRAM_NOTIFY_QUALIFIED_NO_MATCH=true: an INSUFFICIENT_CRITERIA outcome still never fires (wrong flag for this outcome)', async (t) => {
  let fetchCalled = false;
  t.mock.method(global, 'fetch', async () => { fetchCalled = true; return { ok: true, json: async () => ({ ok: true }) }; });
  const { deps } = makeDeps({ config: { telegramNotifyQualifiedNoMatch: true } });
  const result = await runStructuredRequestPipeline({ structuredRequest: insufficientCriteriaRequest(), deps });
  assert.equal(result.status, 'INSUFFICIENT_CRITERIA');
  assert.equal(fetchCalled, false);
});

test('TELEGRAM_NOTIFY_NEEDS_CRITERIA=true: a real INSUFFICIENT_CRITERIA sends exactly one needs-criteria message', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push(JSON.parse(options.body).text);
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const { deps } = makeDeps({ config: { telegramNotifyNeedsCriteria: true } });
  const result = await runStructuredRequestPipeline({ structuredRequest: insufficientCriteriaRequest(), deps });
  assert.equal(result.status, 'INSUFFICIENT_CRITERIA');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /🟠 BUYER LEAD — NEEDS MORE CRITERIA/);
});

test('TELEGRAM_NOTIFY_NEEDS_CRITERIA=true: a real NO_MATCH outcome still never fires (wrong flag for this outcome)', async (t) => {
  let fetchCalled = false;
  t.mock.method(global, 'fetch', async () => { fetchCalled = true; return { ok: true, json: async () => ({ ok: true }) }; });
  const { deps } = makeDeps({ config: { telegramNotifyNeedsCriteria: true } });
  const result = await runStructuredRequestPipeline({ structuredRequest: noMatchRequest(), deps });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(fetchCalled, false);
});

test('both flags true, no Telegram credentials configured: neither notification path sends anything (credential guard still applies)', async (t) => {
  let fetchCalled = false;
  t.mock.method(global, 'fetch', async () => { fetchCalled = true; return { ok: true, json: async () => ({ ok: true }) }; });
  const { deps } = makeDeps({ config: { telegramNotifyQualifiedNoMatch: true, telegramNotifyNeedsCriteria: true, telegramBotToken: '', telegramMatchChatId: '' } });
  await runStructuredRequestPipeline({ structuredRequest: noMatchRequest(), deps });
  await runStructuredRequestPipeline({ structuredRequest: insufficientCriteriaRequest(), deps });
  assert.equal(fetchCalled, false);
});
