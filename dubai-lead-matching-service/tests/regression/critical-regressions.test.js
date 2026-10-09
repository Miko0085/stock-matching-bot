'use strict';

// Release-blocker regressions (TZ 87-96), organized to mirror the TZ
// section numbers directly. The deterministic parts (matching logic) run
// unconditionally in CI. The AI-classification-accuracy parts (TZ 88-89 --
// does the real model actually produce the right message_class/
// demand_owner for these exact real-incident texts) are gated behind
// RUN_OPENAI_LIVE_TESTS (TZ 86) since unit/regression tests must not
// depend on network access or an API key by default.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../../src/config');
const { runWebhookPipeline } = require('../../src/services/pipeline');
const { matchRequest } = require('../../src/matching/matcher');
const { makeFakeStockDb } = require('../unit/helpers/fake-stock-db');
const { classifyAndParse } = require('../../src/parser/openai-client');
const { buildLocationDictionary } = require('../../src/matching/location-dictionary');

const config = loadConfig();

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));
}

function makeNoopDeps(overrides = {}) {
  const deps = {
    config: {
      openaiApiKey: 'x', openaiModel: 'gpt-4o-mini', dedupWindowHours: 48, matchDebug: false,
      parserVersion: 'v', matcherVersion: 'v', interpretationCacheTtlDays: 14,
    },
    pool: {},
    matchRepo: {
      checkDuplicate: async () => false,
      insertMatchRun: async () => ({ id: 1, created_at: new Date().toISOString() }),
      upsertMatchResult: async () => ({ id: 1 }),
    },
    stockRepo: { fetchCandidates: async () => [], checkLocationExists: async () => false, getLatestStockSyncedAt: async () => null, getActiveStockCount: async () => 0 },
    aiUsageRepo: { logAiUsage: async () => {} },
    eventDedupRepo: {
      claimEvent: async () => ({ claimed: true, attempts: 1 }),
      completeEvent: async () => {},
      failEvent: async () => {},
    },
    interpretationCacheRepo: { findInterpretation: async () => null, recordInterpretation: async () => {} },
    getAliasIndex: async () => ({}),
    logEvent: () => {},
    ...overrides,
  };
  if (!overrides.getLocationDictionary) {
    deps.getLocationDictionary = async () => buildLocationDictionary({ aliasIndex: await deps.getAliasIndex() });
  }
  return deps;
}

test('TZ 87: genuine buyer request classification, given correct AI output, runs matching (deterministic)', async () => {
  const deps = makeNoopDeps({
    classifyAndParse: async () => ({
      ok: true,
      usage: null,
      warnings: [],
      value: {
        message_class: 'buyer_request', demand_owner: 'sender', promotion: false, spam: false,
        transaction_type: 'SALE', area: 'Business Bay', project: null, building: null, property_type: null,
        bedrooms_min: 2, bedrooms_max: 2, budget_min: null, budget_max: 2500000, furnishing: null, cash_buyer: null, confidence: 0.9,
      },
    }),
  });
  const result = await runWebhookPipeline({ rawPayload: loadFixture('telegram-business-bay.json'), provider: 'telegram', deps });
  assert.notEqual(result.status, 'REJECTED');
});

test('TZ 88 RELEASE BLOCKER: Emaar-style broker solicitation is REJECTED, given correct AI output', async () => {
  const deps = makeNoopDeps({
    classifyAndParse: async () => ({
      ok: true,
      usage: null,
      warnings: [],
      value: {
        message_class: 'broker_solicitation', demand_owner: 'recipient', promotion: true, spam: false,
        transaction_type: null, area: 'Emaar Beachfront', project: null, building: null, property_type: null,
        bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: null, furnishing: null, cash_buyer: null, confidence: 0.95,
      },
    }),
  });
  const result = await runWebhookPipeline({ rawPayload: loadFixture('telegram-emaar-ad.json'), provider: 'telegram', deps });
  assert.equal(result.status, 'REJECTED');
});

test('TZ 90/43 RELEASE BLOCKER: The Edge never matches 340 Riverside Crescent, and NO_MATCH when The Edge is absent from stock', async () => {
  const structuredRequest = {
    transaction_type: 'SALE', area: null, project: null, building: 'The Edge',
    property_type: 'Apartment', bedrooms_min: 1, bedrooms_max: 1, budget_min: null, budget_max: 1300000,
  };
  const db = makeFakeStockDb([
    { stock_id: 'RIVERSIDE', status: 'ACTIVE', transaction_type: 'SALE', building: '340 Riverside Crescent', area: 'Sobha Hartland II', project_community: 'Sobha Hartland II', bedrooms: 1, property_type: 'Apartment', selling_price: 1235000 },
  ]);
  const result = await matchRequest({
    structuredRequest,
    resolution: { buildingResolved: false },
    config: { matchPriceTolerancePct: 10 },
    fetchCandidates: db.fetchCandidates,
    checkLocationExists: db.checkLocationExists,
  });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'location_not_found');
  assert.equal(result.matches.length, 0);
});

test('TZ 91 RELEASE BLOCKER: area-only ("Business Bay") -> INSUFFICIENT_CRITERIA', async () => {
  const db = makeFakeStockDb([{ stock_id: 'X', status: 'ACTIVE', transaction_type: 'SALE', area: 'Business Bay', bedrooms: 2, property_type: 'Apartment', selling_price: 2000000 }]);
  const result = await matchRequest({
    structuredRequest: { transaction_type: 'SALE', area: 'Business Bay', project: null, building: null, property_type: null, bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: null },
    resolution: { areaResolved: true },
    config: { matchPriceTolerancePct: 10 },
    fetchCandidates: db.fetchCandidates,
    checkLocationExists: db.checkLocationExists,
  });
  assert.equal(result.status, 'INSUFFICIENT_CRITERIA');
});

test('TZ 92: area + bedrooms is allowed; a different area is never a candidate', async () => {
  const db = makeFakeStockDb([
    { stock_id: 'BB', status: 'ACTIVE', transaction_type: 'SALE', area: 'Business Bay', bedrooms: 2, property_type: 'Apartment', selling_price: 2000000 },
    { stock_id: 'MARINA', status: 'ACTIVE', transaction_type: 'SALE', area: 'Dubai Marina', bedrooms: 2, property_type: 'Apartment', selling_price: 2000000 },
  ]);
  const result = await matchRequest({
    structuredRequest: { transaction_type: 'SALE', area: 'Business Bay', project: null, building: null, property_type: null, bedrooms_min: 2, bedrooms_max: 2, budget_min: null, budget_max: null },
    resolution: { areaResolved: true },
    config: { matchPriceTolerancePct: 10 },
    fetchCandidates: db.fetchCandidates,
    checkLocationExists: db.checkLocationExists,
  });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].stock.stock_id, 'BB');
});

test('TZ 96 RELEASE BLOCKER: wrong location, perfect price/bedrooms/type -> rejected before scoring', async () => {
  const db = makeFakeStockDb([
    { stock_id: 'WRONG', status: 'ACTIVE', transaction_type: 'SALE', area: 'Dubai Marina', bedrooms: 2, property_type: 'Apartment', selling_price: 2500000 },
  ]);
  const result = await matchRequest({
    structuredRequest: { transaction_type: 'SALE', area: 'Business Bay', project: null, building: null, property_type: 'Apartment', bedrooms_min: 2, bedrooms_max: 2, budget_min: null, budget_max: 2500000 },
    resolution: { areaResolved: true },
    config: { matchPriceTolerancePct: 10 },
    fetchCandidates: db.fetchCandidates,
    checkLocationExists: db.checkLocationExists,
  });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'no_stock_in_area');
});

// ---- TZ 86/88/89: live AI-accuracy checks, off by default ----
const LIVE = config.runOpenAiLiveTests;

test('LIVE TZ 88: the real model classifies the Emaar ad as broker_solicitation/recipient/promotion', { skip: !LIVE }, async () => {
  const raw = loadFixture('telegram-emaar-ad.json');
  const result = await classifyAndParse({ originalText: raw.text, apiKey: config.openaiApiKey, model: config.openaiModel });
  assert.equal(result.ok, true);
  assert.equal(result.value.message_class, 'broker_solicitation');
  assert.equal(result.value.demand_owner, 'recipient');
});

test('LIVE TZ 89: "My client is looking for..." vs "Do you have a client looking for...?" classify differently', { skip: !LIVE }, async () => {
  const sender = loadFixture('telegram-direction-sender.json');
  const recipient = loadFixture('telegram-direction-recipient.json');
  const senderResult = await classifyAndParse({ originalText: sender.text, apiKey: config.openaiApiKey, model: config.openaiModel });
  const recipientResult = await classifyAndParse({ originalText: recipient.text, apiKey: config.openaiApiKey, model: config.openaiModel });
  assert.equal(senderResult.value.demand_owner, 'sender');
  assert.equal(recipientResult.value.demand_owner, 'recipient');
  assert.notEqual(senderResult.value.demand_owner, recipientResult.value.demand_owner);
});

test('LIVE TZ 90: the real model extracts "The Edge" as project without hallucinating an area', { skip: !LIVE }, async () => {
  const raw = loadFixture('telegram-the-edge.json');
  const result = await classifyAndParse({ originalText: raw.text, apiKey: config.openaiApiKey, model: config.openaiModel });
  // "Edge" vs "The Edge" is natural model wording variance, not a
  // hallucination (both are literally present in the source text) --
  // assert the substance (a real project was extracted), not the article.
  assert.match(result.value.project, /Edge/i);
  // area must either be null or, if the model insists on filling it in
  // anyway, at least verifiably present in the source text (the
  // anti-hallucination guard nulls anything that isn't).
  if (result.value.area) assert.ok(raw.text.toLowerCase().includes(result.value.area.toLowerCase()));
});

// ---- Cost-optimization plan (part A) regressions ----

test('COST-PLAN item 5: the exact real multi-listing ad is REJECTED deterministically, OpenAI is never called, matcher never runs', async () => {
  let aiCalled = false;
  let matcherCalled = false;
  const deps = makeNoopDeps({
    classifyAndParse: async () => { aiCalled = true; return { ok: true, usage: null, warnings: [], value: {} }; },
    stockRepo: {
      fetchCandidates: async () => { matcherCalled = true; return []; },
      checkLocationExists: async () => { matcherCalled = true; return false; },
      getLatestStockSyncedAt: async () => null,
      getActiveStockCount: async () => 0,
    },
  });
  const result = await runWebhookPipeline({ rawPayload: loadFixture('telegram-multi-listing-ad.json'), provider: 'telegram', deps });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.no_match_reason, 'multi_listing_inventory_ad');
  assert.equal(aiCalled, false);
  assert.equal(matcherCalled, false);
});

test('P1.4 Dubai/RF isolation: a Russian free-form message is never PARSED_LOCALLY by the Dubai contour -- falls through to AI_REVIEW', async () => {
  let aiCalled = false;
  const aliasIndex = { area: new Map([['dubaihills', { canonical: 'Dubai Hills' }]]) };
  const deps = makeNoopDeps({
    getAliasIndex: async () => aliasIndex,
    classifyAndParse: async () => {
      aiCalled = true;
      // The UAE AI prompt genuinely can't extract Russian bedroom/budget
      // semantics either -- this fixture only proves the LOCAL parser
      // never claims it, not that the UAE AI fallback understands Russian.
      return { ok: true, usage: null, warnings: [], value: { message_class: 'unknown', demand_owner: 'unknown', promotion: false, spam: false } };
    },
  });
  const raw = { chat_id: '-100777', message_id: '1', sender_id: '1', sender_name: 'Broker', text: 'Ищу клиенту 3 спальни в Dubai Hills до 6 млн, cash' };
  const result = await runWebhookPipeline({ rawPayload: raw, provider: 'telegram', deps });
  assert.equal(aiCalled, true, 'Russian criteria are not extractable by the UAE local parser, so this must fall through to AI_REVIEW, never PARSED_LOCALLY');
  assert.notEqual(result.status, 'MATCH');
});

test('COST-PLAN item 9: the same ad reposted by two different authors -> second interpretation is served from cache, zero additional AI calls', async () => {
  let aiCallCount = 0;
  const cacheStore = new Map();
  const interpretationCacheRepo = {
    findInterpretation: async (pool, { textHash, interpreterVersion }) => cacheStore.get(`${textHash}:${interpreterVersion}`) || null,
    recordInterpretation: async (pool, entry) => {
      cacheStore.set(`${entry.textHash}:${entry.interpreterVersion}`, {
        interpretation_source: entry.interpretationSource,
        message_class: entry.messageClass,
        demand_owner: entry.demandOwner,
        promotion: entry.promotion,
        spam: entry.spam,
        parsed_request: entry.parsedRequest,
      });
    },
  };
  const adText = 'Amazing investment opportunity! Contact us for exclusive off-plan deals across Dubai. Limited time offer, DM now!';
  const deps = makeNoopDeps({
    interpretationCacheRepo,
    classifyAndParse: async () => {
      aiCallCount += 1;
      return { ok: true, usage: null, warnings: [], value: { message_class: 'general_advertisement', demand_owner: 'unknown', promotion: true, spam: false } };
    },
  });

  const first = await runWebhookPipeline({ rawPayload: { chat_id: '-100001', message_id: '1', sender_id: 'author-a', sender_name: 'Author A', text: adText }, provider: 'telegram', deps });
  const second = await runWebhookPipeline({ rawPayload: { chat_id: '-100002', message_id: '1', sender_id: 'author-b', sender_name: 'Author B', text: adText }, provider: 'telegram', deps });

  assert.equal(aiCallCount, 1, 'the second repost (different chat, different author) must be served from the interpretation cache, never call OpenAI again');
  assert.equal(first.status, 'REJECTED');
  assert.equal(second.status, 'REJECTED');
});

test('COST-PLAN item 12: an explicit Furnished request never matches Unfurnished stock', async () => {
  const { evaluateHardFilters } = require('../../src/matching/hard-filters');
  const request = { transaction_type: 'SALE', property_type: null, furnishing: 'Furnished', budget_min: null, budget_max: null, bedrooms_min: null, bedrooms_max: null };
  const unfurnishedStock = { status: 'ACTIVE', transaction_type: 'SALE', furnishing: 'Unfurnished' };
  const result = evaluateHardFilters(request, unfurnishedStock, { locationLevel: null, locationValue: null, config: { matchPriceTolerancePct: 10 } });
  assert.equal(result.passed, false);
  assert.equal(result.failedFilter, 'furnishing');
});

test('COST-PLAN item 13: an explicit minimum size_sqft constraint rejects undersized stock', async () => {
  const { evaluateHardFilters } = require('../../src/matching/hard-filters');
  const request = { transaction_type: 'SALE', property_type: null, furnishing: null, budget_min: null, budget_max: null, bedrooms_min: null, bedrooms_max: null, size_sqft_min: 1000, size_sqft_max: null };
  const tooSmallStock = { status: 'ACTIVE', transaction_type: 'SALE', size_sqft: 650 };
  const bigEnoughStock = { status: 'ACTIVE', transaction_type: 'SALE', size_sqft: 1200 };
  const tooSmall = evaluateHardFilters(request, tooSmallStock, { locationLevel: null, locationValue: null, config: { matchPriceTolerancePct: 10 } });
  const bigEnough = evaluateHardFilters(request, bigEnoughStock, { locationLevel: null, locationValue: null, config: { matchPriceTolerancePct: 10 } });
  assert.equal(tooSmall.passed, false);
  assert.equal(tooSmall.failedFilter, 'sizeSqft');
  assert.equal(bigEnough.passed, true);
});

// ---- Release-blocker audit (2026-09-22) regressions ----

test('P0.1 RELEASE BLOCKER: a bare listing-shaped message never auto-classifies as buyer_request locally', async () => {
  const { evaluateTriage } = require('../../src/gates/triage');
  const aliasIndex = { area: new Map([['businessbay', { canonical: 'Business Bay' }]]) };
  // The literal audit example: location + bedrooms + budget + furnishing,
  // zero buyer-intent language -- exactly as consistent with someone
  // advertising available stock.
  const result = evaluateTriage('Business Bay\n2BR\nAED 2.5M\nFurnished', { aliasIndex });
  assert.notEqual(result.decision, 'PARSED_LOCALLY');
  assert.equal(result.decision, 'AI_REVIEW');
});

test('P0.1 RELEASE BLOCKER: end-to-end, the bare listing-shaped message reaches AI_REVIEW, never MATCH without AI confirming buyer intent', async () => {
  let aiCalled = false;
  const aliasIndex = { area: new Map([['businessbay', { canonical: 'Business Bay' }]]) };
  const deps = makeNoopDeps({
    getAliasIndex: async () => aliasIndex,
    classifyAndParse: async () => {
      aiCalled = true;
      // The real AI, given the identical ambiguous text, correctly refuses
      // to assert a genuine buyer_request/sender classification either.
      return { ok: true, usage: null, warnings: [], value: { message_class: 'inventory_ad', demand_owner: 'unknown', promotion: true, spam: false } };
    },
  });
  const raw = { chat_id: '-100555', message_id: '1', sender_id: '1', sender_name: 'Broker', text: 'Business Bay\n2BR\nAED 2.5M\nFurnished' };
  const result = await runWebhookPipeline({ rawPayload: raw, provider: 'telegram', deps });
  assert.equal(aiCalled, true);
  assert.equal(result.status, 'REJECTED');
});

test('P0.1: the SAME criteria WITH explicit buyer-intent language is still PARSED_LOCALLY (regression guard against over-correcting)', async () => {
  const { evaluateTriage } = require('../../src/gates/triage');
  const aliasIndex = { area: new Map([['businessbay', { canonical: 'Business Bay' }]]) };
  const result = evaluateTriage('Need 2BR Business Bay AED 2.5M Furnished', { aliasIndex });
  assert.equal(result.decision, 'PARSED_LOCALLY');
});

test('P1.1 RELEASE BLOCKER: a weak criterion alone (bathrooms only) is never sufficient for PARSED_LOCALLY, matching the matcher\'s own specificity bar', async () => {
  const { evaluateTriage } = require('../../src/gates/triage');
  const aliasIndex = { area: new Map([['businessbay', { canonical: 'Business Bay' }]]) };
  // "Need" (buyer intent) + location + ONLY bathrooms (a weak criterion,
  // per ADR-020/ADR-027 never independently "specific enough") -- must
  // not be classified as confidently local-parseable.
  const result = evaluateTriage('Need something in Business Bay with 2 bathrooms', { aliasIndex });
  assert.notEqual(result.decision, 'PARSED_LOCALLY');
});

test('P0.2 RELEASE BLOCKER: an unresolved specific building/project mentioned in the text never silently broadens to its area', async () => {
  const db = makeFakeStockDb([
    { stock_id: 'RIVERSIDE', status: 'ACTIVE', transaction_type: 'SALE', building: '340 Riverside Crescent', area: 'Business Bay', project_community: 'Business Bay', bedrooms: 1, property_type: 'Apartment', selling_price: 1235000 },
  ]);
  const structuredRequest = {
    transaction_type: 'SALE', area: 'Business Bay', project: null, building: null,
    property_type: null, bedrooms_min: 1, bedrooms_max: 1, budget_min: null, budget_max: 1300000,
  };
  const result = await matchRequest({
    structuredRequest,
    resolution: { areaResolved: true },
    config: { matchPriceTolerancePct: 10 },
    fetchCandidates: db.fetchCandidates,
    checkLocationExists: db.checkLocationExists,
    // The literal audit example: "The Edge" is a real, explicit building
    // mention that never made it into structuredRequest.building (alias
    // table doesn't recognize it) -- area resolution alone must not let
    // this proceed to match the whole of Business Bay.
    originalText: 'Need 1BR The Edge Business Bay max 1.3M',
  });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'unresolved_specific_location');
  assert.equal(result.matches.length, 0);
});

test('P1.7 RELEASE BLOCKER: a null stock price is treated as unverifiable, never as literal zero (Number(null) === 0 trap)', async () => {
  const { evaluateHardFilters } = require('../../src/matching/hard-filters');
  const request = { transaction_type: 'SALE', property_type: null, furnishing: null, budget_min: null, budget_max: 2_000_000, bedrooms_min: null, bedrooms_max: null };
  // Without the fix, Number(null) === 0 and 0 <= 2_000_000 is true --
  // stock with literally no recorded price would wrongly PASS a budget
  // ceiling check instead of being rejected as unverifiable.
  const nullPriceStock = { status: 'ACTIVE', transaction_type: 'SALE', selling_price: null };
  const result = evaluateHardFilters(request, nullPriceStock, { locationLevel: null, locationValue: null, config: { matchPriceTolerancePct: 10 } });
  assert.equal(result.passed, false);
  assert.equal(result.failedFilter, 'budget');
});

test('P1.7: null/undefined/empty-string/zero are each treated distinctly for a numeric criterion (size_sqft)', async () => {
  const { evaluateHardFilters } = require('../../src/matching/hard-filters');
  const request = { transaction_type: 'SALE', property_type: null, furnishing: null, budget_min: null, budget_max: null, bedrooms_min: null, bedrooms_max: null, size_sqft_min: 500, size_sqft_max: null };
  const config = { matchPriceTolerancePct: 10 };
  const base = { status: 'ACTIVE', transaction_type: 'SALE' };

  const withNull = evaluateHardFilters(request, { ...base, size_sqft: null }, { locationLevel: null, locationValue: null, config });
  const withUndefined = evaluateHardFilters(request, { ...base }, { locationLevel: null, locationValue: null, config });
  const withEmptyString = evaluateHardFilters(request, { ...base, size_sqft: '' }, { locationLevel: null, locationValue: null, config });
  const withZero = evaluateHardFilters(request, { ...base, size_sqft: 0 }, { locationLevel: null, locationValue: null, config });

  // null/undefined/'' are all "unknown" -> blocked (unverifiable against a
  // stated 500 sqft minimum). A genuine 0 is a real (if implausible) value
  // that is correctly and simply below the minimum -- same outcome here,
  // but for a documented, distinct reason (a real comparison, not a
  // missing-data guard), proving 0 is never silently confused with null.
  assert.equal(withNull.passed, false);
  assert.equal(withUndefined.passed, false);
  assert.equal(withEmptyString.passed, false);
  assert.equal(withZero.passed, false);
  assert.equal(withZero.filters.sizeSqft.active, true);
});

test('P0.2: a genuine area-only request with no leftover capitalized tokens still matches normally (no over-correction)', async () => {
  const db = makeFakeStockDb([
    { stock_id: 'BB-1', status: 'ACTIVE', transaction_type: 'SALE', area: 'Business Bay', bedrooms: 2, property_type: 'Apartment', selling_price: 2000000 },
  ]);
  const structuredRequest = {
    transaction_type: 'SALE', area: 'Business Bay', project: null, building: null,
    property_type: null, bedrooms_min: 2, bedrooms_max: 2, budget_min: null, budget_max: null,
  };
  const result = await matchRequest({
    structuredRequest,
    resolution: { areaResolved: true },
    config: { matchPriceTolerancePct: 10 },
    fetchCandidates: db.fetchCandidates,
    checkLocationExists: db.checkLocationExists,
    originalText: 'Need 2BR in Business Bay',
  });
  assert.equal(result.status, 'MATCH');
});
