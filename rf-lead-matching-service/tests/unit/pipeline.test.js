'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runWebhookPipeline } = require('../../src/services/pipeline');

// Default fake config: cutover OFF, matching the real seeded default
// (migration 0029) -- every test that doesn't override configRepo gets
// the EXACT pre-gate behavior, unchanged.
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

// Always-eligible by default -- most tests are exercising gate/matching
// behavior, not routing, and every real source in production already has
// route_mode=RF/BOTH by the time this pipeline runs for it.
function makeSourceRoutingGate({ eligible = true, reason = null } = {}) {
  return { lookupSourceRoute: async () => ({ found: true, eligible, reason }) };
}

function makeDeps(overrides = {}) {
  const insertedRuns = [];
  const insertedResults = [];
  return {
    deps: {
      pool: {},
      config: { parserVersion: 'rf-test-parser-v1', matcherVersion: 'rf-test-v1', aiCacheTtlDays: 14, telegramNotificationsEnabled: false },
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
      aliasCache: { loadAliasIndex: async () => ({}) },
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

test('cutover OFF (the seeded default): every RF-routed event still resolves to NOT_IMPLEMENTED, never a fabricated match -- unchanged from before the gate existed', async () => {
  const { deps } = makeDeps();
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Ищу 2-комнатную в Москва до 15 млн' },
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

test('the RF pipeline never imports anything from the Dubai contour', () => {
  const source = require('fs').readFileSync(require.resolve('../../src/services/pipeline.js'), 'utf8');
  const requireCalls = source.match(/require\(['"][^'"]+['"]\)/g) || [];
  const dubaiImports = requireCalls.filter((call) => call.includes('lead-matching-service'));
  assert.deepEqual(dubaiImports, [], 'RF pipeline must never require() anything from the Dubai service path');
});

// ---- Gate ACTIVE (v2_intake_cutover_enabled = true) -- 2026-09-29 --------

test('cutover ON: a BLACKLIST hit is persisted as REJECTED with the real gate reason, never NOT_IMPLEMENTED', async () => {
  const { deps, insertedRuns } = makeDeps({
    configRepo: makeConfigRepo({
      cutoverEnabled: true,
      rules: { BLACKLIST: [{ id: 1, rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true }] },
    }),
  });
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Сдам квартиру в центре' },
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
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'просто случайный текст без сигналов' },
    provider: 'telegram',
    deps,
  });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'INSUFFICIENT_BUYER_SIGNAL');
  assert.equal(insertedRuns[0].result_status, 'REJECTED');
});

test('cutover ON: a real buyer-signal (WHITELIST) hit is APPROVED by the gate and now reaches the real AI parser (2026-09-29) -- a parser failure here is PARSER_ERROR, not the old placeholder NOT_IMPLEMENTED', async () => {
  const { deps, insertedRuns } = makeDeps({
    configRepo: makeConfigRepo({
      cutoverEnabled: true,
      rules: { WHITELIST: [{ id: 2, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу для клиента', enabled: true }] },
    }),
  });
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Ищу для клиента 3-комнатную в ЮЗАО' },
    provider: 'telegram',
    deps,
  });
  assert.equal(result.status, 'PARSER_ERROR');
  assert.equal(insertedRuns[0].result_status, 'PARSER_ERROR');
});

test('cutover ON with REQUIRE_ANY policy: a WHITELIST-only hit is enough to reach the AI parser (property_signal_threshold=0 default matches Moscow\'s own seeded config)', async () => {
  const { deps, insertedRuns } = makeDeps({
    configRepo: makeConfigRepo({
      cutoverEnabled: true,
      buyerSignalPolicy: 'REQUIRE_ANY',
      propertySignalThreshold: 0,
      rules: { WHITELIST: [{ id: 2, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'хочу купить', enabled: true }] },
    }),
  });
  await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Хочу купить квартиру' },
    provider: 'telegram',
    deps,
  });
  assert.equal(insertedRuns[0].result_status, 'PARSER_ERROR');
});

// ---- Real matching (2026-09-29) -------------------------------------------

function makeGatedDeps(overrides = {}) {
  return makeDeps({
    configRepo: makeConfigRepo({
      cutoverEnabled: true,
      rules: { WHITELIST: [{ id: 2, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу', enabled: true }] },
    }),
    ...overrides,
  });
}

test('source routing REJECT happens before anything else, even when cutover is off', async () => {
  const { deps, insertedRuns } = makeDeps({
    sourceRoutingGate: makeSourceRoutingGate({ eligible: false, reason: 'not_rf_eligible' }),
  });
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Ищу 2-комнатную' },
    provider: 'telegram',
    deps,
  });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'not_rf_eligible');
  assert.match(insertedRuns[0].reason, /ROUTE_REJECT: not_rf_eligible/);
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
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Ищу 2-комнатную' },
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
      value: { message_class: 'inventory_ad', demand_owner: 'sender', promotion: false, spam: false, district: null, complex: null, property_type: null, rooms: null, rooms_sentinel: null, bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: null, area_sqm_min: null, area_sqm_max: null, floor_min: null, floor_max: null, readiness_year: null, transaction_type: 'SALE', cash_buyer: null, confidence: 0.9 },
    }),
  });
  const result = await runWebhookPipeline({
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Ищу для клиента квартиру' },
    provider: 'telegram',
    deps,
  });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.reason, 'ai_classified_not_buyer_request');
  assert.equal(insertedRuns[0].result_status, 'NO_MATCH');
});

test('a real MATCH persists the run, upserts one match_results row per survivor, and sends every successful match to Telegram', async () => {
  const stockRow = { joker_object_id: 555, district: 'Юго-Западный округ', complex: null, deal_type: 'sale', property_type_excluded: false, property_type: 'Квартира', rooms: 2, rooms_sentinel: null, bedrooms: null, area_sqm: 55, floor: 3, price: 14000000, readiness_year: null };
  const sentMessages = [];
  const { deps, insertedRuns, insertedResults } = makeGatedDeps({
    classifyAndParse: async () => ({
      ok: true,
      value: { message_class: 'buyer_request', demand_owner: 'sender', promotion: false, spam: false, district: 'ЮЗАО', complex: null, property_type: null, rooms: 2, rooms_sentinel: null, bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: 15000000, area_sqm_min: null, area_sqm_max: null, floor_min: null, floor_max: null, readiness_year: null, transaction_type: 'SALE', cash_buyer: null, confidence: 0.9 },
    }),
    aliasCache: {
      loadAliasIndex: async () => ({ district: new Map([['юзао', { canonical: 'Юго-Западный округ', parentArea: null }]]) }),
    },
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
    rawPayload: { chat_id: '-100999', message_id: '1', text: 'Ищу 2-комнатную в ЮЗАО до 15 млн' },
    provider: 'telegram',
    deps,
  });

  assert.equal(result.status, 'MATCH');
  assert.equal(result.matches.length, 1);
  assert.equal(insertedRuns[0].result_status, 'MATCH');
  assert.equal(insertedResults.length, 1);
  assert.equal(insertedResults[0].entry.stock.joker_object_id, 555);
  assert.ok(sentMessages.length > 0, 'every successful match must reach Telegram');
});
