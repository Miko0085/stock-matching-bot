'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runWebhookPipeline } = require('../../src/services/pipeline');

// Default fake config: cutover OFF, matching the real seeded default --
// every test that doesn't override configRepo gets the EXACT pre-gate
// behavior, unchanged.
function makeConfigRepo({ cutoverEnabled = false, buyerSignalPolicy = 'REQUIRE_BOTH', whitelistThreshold = 1, propertySignalThreshold = 0, rules = {} } = {}) {
  return {
    async loadActiveV2Config() {
      return {
        settings: {
          v2_intake_cutover_enabled: { value: cutoverEnabled, enabled: true },
          buyer_signal_policy: { value: buyerSignalPolicy, enabled: true },
          whitelist_threshold: { value: whitelistThreshold, enabled: true },
          property_signal_threshold: { value: propertySignalThreshold, enabled: true },
        },
        rules: { BLACKLIST: [], WHITELIST: [], PROPERTY_SIGNAL: [], SEND_TO_AI: [], ...rules },
        configVersionId: 1,
      };
    },
  };
}

// Always-eligible by default -- most tests exercise gate/matching behavior,
// not routing.
function makeSourceRoutingGate({ eligible = true, reason = null } = {}) {
  return { lookupSourceRoute: async () => ({ found: true, eligible, reason }) };
}

function makeDeps(overrides = {}) {
  const insertedRuns = [];
  const insertedResults = [];
  return {
    deps: {
      pool: {},
      config: { parserVersion: 'abu-dhabi-test-parser-v1', matcherVersion: 'abu-dhabi-test-v1', aiCacheTtlDays: 14, telegramNotificationsEnabled: false, matchPriceTolerancePct: 10 },
      matchRepo: {
        insertNotImplementedRun: async (pool, args) => {
          insertedRuns.push({ ...args, result_status: 'NOT_IMPLEMENTED' });
          return { id: insertedRuns.length, created_at: new Date().toISOString() };
        },
        insertRejectedRun: async (pool, args) => {
          insertedRuns.push({ ...args, result_status: 'REJECTED' });
          return { id: insertedRuns.length, created_at: new Date().toISOString() };
        },
        checkDuplicate: async () => false,
        insertMatchRun: async (pool, args) => {
          insertedRuns.push({ ...args, result_status: args.resultStatus });
          return { id: insertedRuns.length, created_at: new Date().toISOString() };
        },
        upsertMatchResult: async (pool, args) => {
          insertedResults.push(args);
          return { id: insertedResults.length };
        },
      },
      configRepo: makeConfigRepo(),
      sourceRoutingGate: makeSourceRoutingGate(),
      interpretationCacheRepo: {
        findInterpretation: async () => null,
        recordInterpretation: async () => {},
      },
      aliasRepo: { loadAliasIndex: async () => ({}) },
      stockRepo: {
        fetchCandidates: async () => [],
        checkLocationExists: async () => false,
        getLatestStockSyncedAt: async () => null,
        getActiveStockCount: async () => 0,
      },
      classifyAndParse: async () => ({ ok: false, errorCode: 'PARSER_ERROR', reason: 'not_configured_in_test' }),
      telegramSender: { sendMatchNotification: async () => ({ ok: true, results: [] }) },
      logEvent: () => {},
      ...overrides,
    },
    insertedRuns,
    insertedResults,
  };
}

test('cutover OFF (the seeded default): every ABU_DHABI-routed event resolves to NOT_IMPLEMENTED, never a fabricated match', async () => {
  const { deps } = makeDeps();
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Looking for 2BR in Al Reem Island' },
    provider: 'telegram',
    deps,
  });
  assert.equal(result.status, 'NOT_IMPLEMENTED');
  assert.deepEqual(result.matches, []);
});

test('cutover OFF: every request still gets a durable, queryable outcome persisted', async () => {
  const { deps, insertedRuns } = makeDeps();
  await runWebhookPipeline({ rawPayload: { chat_id: '-100999', message_id: '1', text: 'test' }, provider: 'telegram', deps });
  assert.equal(insertedRuns.length, 1);
  assert.equal(insertedRuns[0].sourceMessageId, 'telegram:-100999:1');
  assert.equal(insertedRuns[0].originalText, 'test');
  assert.equal(insertedRuns[0].result_status, 'NOT_IMPLEMENTED');
});

test('ADR-046: account_id/chat_id from the raw payload reach insertMatchRun (previously destructured as dead params and dropped on the floor)', async () => {
  const { deps, insertedRuns } = makeDeps();
  await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'test', account_id: 'tg_main' },
    provider: 'telegram',
    deps,
  });
  assert.equal(insertedRuns[0].accountId, 'tg_main');
  assert.equal(insertedRuns[0].chatId, '-100999');
});

test('the Abu Dhabi pipeline never imports anything from the Dubai or RF contours (isolation, AGENTS.md section 0)', () => {
  const source = require('fs').readFileSync(require.resolve('../../src/services/pipeline.js'), 'utf8');
  const requireCalls = source.match(/require\(['"][^'"]+['"]\)/g) || [];
  const dubaiImports = requireCalls.filter((call) => call.includes('dubai-lead-matching-service'));
  const rfImports = requireCalls.filter((call) => call.includes('rf-lead-matching-service'));
  assert.deepEqual(dubaiImports, [], 'pipeline.js must never require() anything from the Dubai service path');
  assert.deepEqual(rfImports, [], 'pipeline.js must never require() anything from the RF service path');
});

// ---- Gate ACTIVE (v2_intake_cutover_enabled = true) -----------------------

test('cutover ON: a BLACKLIST hit is persisted as REJECTED with the real gate reason, never NOT_IMPLEMENTED', async () => {
  const { deps, insertedRuns } = makeDeps({
    configRepo: makeConfigRepo({
      cutoverEnabled: true,
      rules: { BLACKLIST: [{ id: 1, rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'renting out', enabled: true }] },
    }),
  });
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Renting out a 2BR in Al Reem' },
    provider: 'telegram',
    deps,
  });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'BLACKLIST');
  assert.equal(insertedRuns[0].result_status, 'REJECTED');
  assert.match(insertedRuns[0].reason, /GATE_REJECT: BLACKLIST/);
});

test('cutover ON: insufficient buyer signal (no rule hits at all) is persisted as REJECTED, not silently dropped', async () => {
  const { deps, insertedRuns } = makeDeps({ configRepo: makeConfigRepo({ cutoverEnabled: true }) });
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'just some random text with no signal' },
    provider: 'telegram',
    deps,
  });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'INSUFFICIENT_BUYER_SIGNAL');
  assert.equal(insertedRuns[0].result_status, 'REJECTED');
});

test('cutover ON: a real buyer-signal (WHITELIST) hit is approved by the gate and reaches the real AI parser -- a parser failure here is PARSER_ERROR, not the old placeholder NOT_IMPLEMENTED', async () => {
  const { deps, insertedRuns } = makeDeps({
    configRepo: makeConfigRepo({
      cutoverEnabled: true,
      rules: { WHITELIST: [{ id: 2, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'looking for my client', enabled: true }] },
    }),
  });
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Looking for my client a 3BR in Al Reem Island' },
    provider: 'telegram',
    deps,
  });
  assert.equal(result.status, 'PARSER_ERROR');
  assert.equal(insertedRuns[0].result_status, 'PARSER_ERROR');
});

// ---- Real matching ----------------------------------------------------

function makeGatedDeps(overrides = {}) {
  return makeDeps({
    configRepo: makeConfigRepo({
      cutoverEnabled: true,
      rules: { WHITELIST: [{ id: 2, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'looking for', enabled: true }] },
    }),
    ...overrides,
  });
}

test('source routing REJECT happens before anything else, even when cutover is off', async () => {
  const { deps, insertedRuns } = makeDeps({
    sourceRoutingGate: makeSourceRoutingGate({ eligible: false, reason: 'not_abu_dhabi_eligible' }),
  });
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Looking for 2BR' },
    provider: 'telegram',
    deps,
  });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'not_abu_dhabi_eligible');
  assert.match(insertedRuns[0].reason, /ROUTE_REJECT: not_abu_dhabi_eligible/);
});

test('a duplicate re-send of the same text within the window is persisted as DUPLICATE, not re-matched', async () => {
  const { deps, insertedRuns } = makeGatedDeps({
    matchRepo: {
      ...makeDeps().deps.matchRepo,
      checkDuplicate: async () => true,
      insertMatchRun: async (pool, args) => {
        insertedRuns.push({ ...args, result_status: args.resultStatus });
        return { id: insertedRuns.length, created_at: new Date().toISOString() };
      },
    },
  });
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Looking for 2BR' },
    provider: 'telegram',
    deps,
  });
  assert.equal(result.status, 'DUPLICATE');
  assert.equal(insertedRuns[0].result_status, 'DUPLICATE');
});

test('AI classifies the message as not a genuine buyer request -> NO_MATCH, never fabricated', async () => {
  const { deps, insertedRuns } = makeGatedDeps({
    classifyAndParse: async () => ({
      ok: true,
      value: { message_class: 'inventory_ad', demand_owner: 'sender', promotion: false, spam: false, transaction_type: 'SALE', area: null, areas: [], project: null, building: null, property_type: null, bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: null, furnishing: null, cash_buyer: null, confidence: 0.9 },
    }),
  });
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Looking for a client apartment' },
    provider: 'telegram',
    deps,
  });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.reason, 'ai_classified_not_buyer_request');
  assert.equal(insertedRuns[0].result_status, 'NO_MATCH');
});

test('a real MATCH persists the run, upserts one match_results row per survivor, and sends every successful match to Telegram', async () => {
  const stockRow = { stock_id: 'STK-1', status: 'ACTIVE', transaction_type: 'SALE', area: 'Al Reem Island', project_community: 'Al Reem Island', building: 'Sky Tower', bedrooms: 2, property_type: 'Apartment', selling_price: 1400000 };
  const sentMessages = [];
  const aliasIndex = { area: new Map([['alreemisland', { canonical: 'Al Reem Island' }]]) };
  const { deps, insertedRuns, insertedResults } = makeGatedDeps({
    classifyAndParse: async () => ({
      ok: true,
      value: { message_class: 'buyer_request', demand_owner: 'sender', promotion: false, spam: false, transaction_type: 'SALE', area: 'Al Reem Island', areas: ['Al Reem Island'], project: null, building: null, property_type: null, bedrooms_min: 2, bedrooms_max: 2, budget_min: null, budget_max: 1500000, furnishing: null, cash_buyer: null, confidence: 0.9 },
    }),
    aliasRepo: { loadAliasIndex: async () => aliasIndex },
    stockRepo: {
      fetchCandidates: async () => [stockRow],
      checkLocationExists: async () => true,
      getLatestStockSyncedAt: async () => new Date().toISOString(),
      getActiveStockCount: async () => 1,
    },
    telegramSender: {
      sendMatchNotification: async ({ messages }) => {
        sentMessages.push(...messages);
        return { ok: true, results: [] };
      },
    },
  });
  deps.config.telegramNotificationsEnabled = true;
  deps.config.telegramBotToken = 'test-token';
  deps.config.telegramMatchChatId = '-100111';
  deps.config.telegramMaxMessageLength = 3800;

  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Looking for a 2BR in Al Reem Island up to 1.5M' },
    provider: 'telegram',
    deps,
  });

  assert.equal(result.status, 'MATCH');
  assert.equal(result.matches.length, 1);
  assert.equal(insertedRuns[0].result_status, 'MATCH');
  assert.equal(insertedResults.length, 1);
  assert.equal(insertedResults[0].entry.stock.stock_id, 'STK-1');
  assert.ok(sentMessages.length > 0, 'every successful match must reach Telegram');
});
