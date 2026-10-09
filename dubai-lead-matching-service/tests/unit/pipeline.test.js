'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runWebhookPipeline, isEligibleForMatching, deriveRejectionReason } = require('../../src/services/pipeline');
const { buildLocationDictionary } = require('../../src/matching/location-dictionary');

function makeDeps(overrides = {}) {
  const insertedRuns = [];
  const upsertedResults = [];
  const loggedUsage = [];

  const matchRepo = {
    checkDuplicate: async () => false,
    insertMatchRun: async (pool, row) => {
      insertedRuns.push(row);
      return { id: insertedRuns.length, created_at: new Date().toISOString() };
    },
    upsertMatchResult: async (pool, row) => {
      upsertedResults.push(row);
      return { id: upsertedResults.length };
    },
  };

  const stockRepo = {
    fetchCandidates: async () => [],
    checkLocationExists: async () => false,
    getLatestStockSyncedAt: async () => null,
    getActiveStockCount: async () => 0,
  };

  const aiUsageRepo = { logAiUsage: async (pool, args) => loggedUsage.push(args) };

  const eventDedupRepo = {
    claimEvent: async () => ({ claimed: true, attempts: 1 }),
    completeEvent: async () => {},
    failEvent: async () => {},
  };
  const interpretationCacheRepo = {
    findInterpretation: async () => null,
    recordInterpretation: async () => {},
  };

  const deps = {
    config: {
      openaiApiKey: 'x', openaiModel: 'gpt-4o-mini', dedupWindowHours: 48, matchDebug: false,
      parserVersion: 'v', matcherVersion: 'v', interpretationCacheTtlDays: 14,
    },
    pool: {},
    matchRepo,
    stockRepo,
    aiUsageRepo,
    eventDedupRepo,
    interpretationCacheRepo,
    getAliasIndex: async () => ({}),
    classifyAndParse: async () => ({ ok: true, value: makeAiValue(), warnings: [], usage: null }),
    logEvent: () => {},
    ...overrides,
  };
  // Composed from getAliasIndex (not a separate default) so a test that
  // only overrides getAliasIndex (the overwhelming majority) still gets a
  // location dictionary that actually reflects it, without every call site
  // needing its own getLocationDictionary override.
  if (!overrides.getLocationDictionary) {
    deps.getLocationDictionary = async () => buildLocationDictionary({ aliasIndex: await deps.getAliasIndex() });
  }

  return { deps, insertedRuns, upsertedResults, loggedUsage };
}

function makeAiValue(overrides = {}) {
  return {
    message_class: 'buyer_request',
    demand_owner: 'sender',
    promotion: false,
    spam: false,
    transaction_type: 'SALE',
    area: 'Business Bay',
    project: null,
    building: null,
    property_type: null,
    bedrooms_min: 2,
    bedrooms_max: 2,
    budget_min: null,
    budget_max: null,
    furnishing: null,
    cash_buyer: null,
    confidence: 0.9,
    ...overrides,
  };
}

function telegramRaw(overrides = {}) {
  return {
    chat_id: '-100123',
    message_id: '1',
    sender_id: '1',
    sender_name: 'John',
    text: 'My client is looking for a 2BR in Business Bay',
    ...overrides,
  };
}

test('isEligibleForMatching: TZ 26-27 -- only buyer_request + sender, not promotion/spam', () => {
  assert.equal(isEligibleForMatching(makeAiValue()), true);
  assert.equal(isEligibleForMatching(makeAiValue({ message_class: 'broker_solicitation' })), false);
  assert.equal(isEligibleForMatching(makeAiValue({ demand_owner: 'recipient' })), false);
  assert.equal(isEligibleForMatching(makeAiValue({ promotion: true })), false);
  assert.equal(isEligibleForMatching(makeAiValue({ spam: true })), false);
});

test('deriveRejectionReason priority: spam > advertisement > recipient_owned_demand > not_buyer_request', () => {
  assert.equal(deriveRejectionReason(makeAiValue({ spam: true })), 'spam');
  assert.equal(deriveRejectionReason(makeAiValue({ message_class: 'inventory_ad' })), 'advertisement');
  assert.equal(deriveRejectionReason(makeAiValue({ demand_owner: 'recipient' })), 'recipient_owned_demand');
  assert.equal(deriveRejectionReason(makeAiValue({ message_class: 'other' })), 'not_buyer_request');
});

test('TZ 88 CRITICAL regression: Emaar-style broker_solicitation is REJECTED deterministically, without ever calling OpenAI', async () => {
  let aiCalled = false;
  const { deps, insertedRuns } = makeDeps({
    classifyAndParse: async () => {
      aiCalled = true;
      return { ok: true, value: makeAiValue({ message_class: 'broker_solicitation', demand_owner: 'recipient', promotion: true }), warnings: [], usage: null };
    },
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'Have a client looking to buy? Send us your client\'s requirements.' }), provider: 'telegram', deps });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.no_match_reason, 'broker_solicitation');
  assert.equal(aiCalled, false, 'the deterministic triage must reject this without ever calling OpenAI');
  assert.equal(insertedRuns.length, 1);
  assert.equal(insertedRuns[0].resultStatus, 'REJECTED');
  assert.equal(insertedRuns[0].triageDecision, 'REJECT');
});

test('a genuine buyer request (sender-owned) proceeds to the matcher and persists MATCH', async () => {
  const { deps } = makeDeps({
    stockRepo: {
      fetchCandidates: async () => [{ stock_id: 'STK-1', status: 'ACTIVE', transaction_type: 'SALE', area: 'Business Bay', project_community: 'Business Bay', building: 'P4', bedrooms: 2, property_type: 'Apartment', selling_price: 2000000 }],
      checkLocationExists: async () => true,
      getLatestStockSyncedAt: async () => null,
      getActiveStockCount: async () => 1,
    },
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw(), provider: 'telegram', deps });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.matches.length, 1);
});

test('a duplicate message is persisted as DUPLICATE and never reaches the AI', async () => {
  let aiCalled = false;
  const { deps, insertedRuns } = makeDeps({
    matchRepo: {
      checkDuplicate: async () => true,
      insertMatchRun: async (pool, row) => {
        insertedRuns.push(row);
        return { id: 1, created_at: new Date().toISOString() };
      },
      upsertMatchResult: async () => ({ id: 1 }),
    },
    classifyAndParse: async () => {
      aiCalled = true;
      return { ok: true, value: makeAiValue(), warnings: [], usage: null };
    },
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw(), provider: 'telegram', deps });
  assert.equal(result.status, 'DUPLICATE');
  assert.equal(aiCalled, false);
  assert.equal(insertedRuns[0].resultStatus, 'DUPLICATE');
});

test('a message rejected by deterministic triage never reaches OpenAI (event/content dedup still run first, cheaply)', async () => {
  let aiCalled = false;
  const { deps, insertedRuns } = makeDeps({
    classifyAndParse: async () => {
      aiCalled = true;
      return { ok: true, value: makeAiValue(), warnings: [], usage: null };
    },
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'Looking for a roommate to share my flat' }), provider: 'telegram', deps });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.no_match_reason, 'non_property_request');
  assert.equal(aiCalled, false);
  assert.equal(insertedRuns[0].triageDecision, 'REJECT');
});

test('event dedup stops a redelivered webhook before content dedup, triage, or AI ever run', async () => {
  let aiCalled = false;
  let contentDedupCalled = false;
  const { deps, insertedRuns } = makeDeps({
    eventDedupRepo: { claimEvent: async () => ({ claimed: false, reason: 'completed' }), completeEvent: async () => {}, failEvent: async () => {} },
    matchRepo: {
      checkDuplicate: async () => {
        contentDedupCalled = true;
        return false;
      },
      insertMatchRun: async (pool, row) => {
        insertedRuns.push(row);
        return { id: insertedRuns.length, created_at: new Date().toISOString() };
      },
      upsertMatchResult: async () => ({ id: 1 }),
    },
    classifyAndParse: async () => {
      aiCalled = true;
      return { ok: true, value: makeAiValue(), warnings: [], usage: null };
    },
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw(), provider: 'telegram', deps });
  assert.equal(result.status, 'DUPLICATE');
  assert.equal(result.no_match_reason, 'duplicate_event');
  assert.equal(contentDedupCalled, false);
  assert.equal(aiCalled, false);
});

test('P0.3 RELEASE BLOCKER: an exception mid-processing marks the event failEvent (retryable), never completeEvent', async () => {
  let completeCalled = false;
  let failCalled = false;
  const { deps } = makeDeps({
    eventDedupRepo: {
      claimEvent: async () => ({ claimed: true, attempts: 1 }),
      completeEvent: async () => { completeCalled = true; },
      failEvent: async () => { failCalled = true; },
    },
    matchRepo: {
      checkDuplicate: async () => false,
      insertMatchRun: async () => { throw new Error('simulated DB outage'); },
      upsertMatchResult: async () => ({ id: 1 }),
    },
  });
  await assert.rejects(
    () => runWebhookPipeline({ rawPayload: telegramRaw(), provider: 'telegram', deps }),
    /simulated DB outage/
  );
  assert.equal(failCalled, true, 'a crash must mark the event retryable');
  assert.equal(completeCalled, false, 'a crash must never be reported as a completed outcome');
});

test('P0.3: a successful outcome (including a REJECTED/DUPLICATE persisted result) always calls completeEvent, never failEvent', async () => {
  let completeCalled = false;
  let failCalled = false;
  const { deps } = makeDeps({
    eventDedupRepo: {
      claimEvent: async () => ({ claimed: true, attempts: 1 }),
      completeEvent: async () => { completeCalled = true; },
      failEvent: async () => { failCalled = true; },
    },
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw(), provider: 'telegram', deps });
  assert.ok(['MATCH', 'NO_MATCH', 'INSUFFICIENT_CRITERIA'].includes(result.status), `expected a completed outcome, got ${result.status}`);
  assert.equal(completeCalled, true);
  assert.equal(failCalled, false);
});

test('multi-listing inventory ad is REJECTED deterministically, without ever calling OpenAI', async () => {
  let aiCalled = false;
  const { deps, insertedRuns } = makeDeps({
    classifyAndParse: async () => {
      aiCalled = true;
      return { ok: true, value: makeAiValue({ message_class: 'inventory_ad', demand_owner: 'unknown', promotion: true }), warnings: [], usage: null };
    },
  });
  const multiListingText = [
    '3BR Apartment for Sale | The Isle, Dubai Harbour',
    'Premium 3-bedroom residence with stunning Palm views.',
    '📍 Dubai Harbour',
    '📐 173.82 sqm',
    '💰 Sale Price: AED 10.5 Millions',
    '---',
    '📍JVT | Maya Residences 5 | 2BR | Store | Community View',
    '1226 sqft',
    'Handover: Ready',
    'Price AED 1.82M',
  ].join('\n');
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: multiListingText }), provider: 'telegram', deps });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.no_match_reason, 'multi_listing_inventory_ad');
  assert.equal(aiCalled, false);
  assert.equal(insertedRuns[0].triageDecision, 'REJECT');
});

test('a confident local parse (location + criteria found via alias index) skips OpenAI entirely and matches', async () => {
  let aiCalled = false;
  const aliasIndex = {
    area: new Map([['businessbay', { canonical: 'Business Bay' }]]),
  };
  const { deps } = makeDeps({
    getAliasIndex: async () => aliasIndex,
    classifyAndParse: async () => {
      aiCalled = true;
      return { ok: true, value: makeAiValue(), warnings: [], usage: null };
    },
    stockRepo: {
      fetchCandidates: async () => [{ stock_id: 'STK-1', status: 'ACTIVE', transaction_type: 'SALE', area: 'Business Bay', project_community: 'Business Bay', building: 'P4', bedrooms: 2, property_type: 'Apartment', selling_price: 2000000 }],
      checkLocationExists: async () => true,
      getLatestStockSyncedAt: async () => null,
      getActiveStockCount: async () => 1,
    },
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'Need 2BR Business Bay max 2.5M cash' }), provider: 'telegram', deps });
  assert.equal(aiCalled, false, 'a confidently local-parseable buyer request must never call OpenAI');
  assert.equal(result.status, 'MATCH');
});

// ---- AUDIT item #2: unresolved-specific-location escalation, end-to-end ----

test('AUDIT #2: "The Edge" unresolved locally escalates to AI_REVIEW, and AI extracting it as project never broad-matches Business Bay', async () => {
  let aiCalled = false;
  const aliasIndex = { area: new Map([['businessbay', { canonical: 'Business Bay' }]]) };
  const { deps, insertedRuns } = makeDeps({
    getAliasIndex: async () => aliasIndex,
    classifyAndParse: async () => {
      aiCalled = true;
      return {
        ok: true,
        value: makeAiValue({ area: null, project: 'The Edge', bedrooms_min: 1, bedrooms_max: 1, budget_max: 1300000 }),
        warnings: [],
        usage: null,
      };
    },
    stockRepo: {
      // "The Edge" is not in stock at all -- checkLocationExists correctly
      // reports false, so the EXISTING unresolved-project safeguard
      // (resolveLocationLevel's "not resolved" -> location_not_found path)
      // rejects it. fetchCandidates must never even be asked for the whole
      // of Business Bay.
      fetchCandidates: async () => { throw new Error('must never query candidates for an unresolved specific location'); },
      checkLocationExists: async () => false,
      getLatestStockSyncedAt: async () => null,
      getActiveStockCount: async () => 0,
    },
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'Need 1BR The Edge Business Bay max 1.3M' }), provider: 'telegram', deps });
  assert.equal(aiCalled, true, 'local parse must escalate to AI_REVIEW instead of guessing');
  assert.equal(insertedRuns[0].triageDecision, 'AI_REVIEW');
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.no_match_reason, 'location_not_found');
});

for (const [label, text] of [
  ['Cash Buyer', 'Need 2BR Business Bay Cash Buyer'],
  ['Urgent', 'Need 2BR Business Bay Urgent'],
  ['High Floor', 'Need 2BR Business Bay High Floor'],
  ['Canal View', 'Need Apartment Business Bay Canal View'],
]) {
  test(`AUDIT #2: "${label}" escalates to AI_REVIEW but is never falsely NO_MATCHed as unresolved_specific_location once AI confirms no project`, async () => {
    const aliasIndex = { area: new Map([['businessbay', { canonical: 'Business Bay' }]]) };
    const { deps } = makeDeps({
      getAliasIndex: async () => aliasIndex,
      classifyAndParse: async () => ({
        ok: true,
        // AI reviews the full text and correctly declines to extract a
        // project/building -- "Cash Buyer"/"Urgent"/"High Floor"/"Canal
        // View" are ordinary buyer language, not a project name.
        value: makeAiValue({ area: 'Business Bay', project: null, building: null, bedrooms_min: 2, bedrooms_max: 2 }),
        warnings: [],
        usage: null,
      }),
      stockRepo: {
        fetchCandidates: async () => [{ stock_id: 'STK-1', status: 'ACTIVE', transaction_type: 'SALE', area: 'Business Bay', project_community: 'Business Bay', building: 'P4', bedrooms: 2, property_type: 'Apartment', selling_price: 2000000 }],
        checkLocationExists: async () => true,
        getLatestStockSyncedAt: async () => null,
        getActiveStockCount: async () => 1,
      },
    });
    const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text }), provider: 'telegram', deps });
    assert.notEqual(result.no_match_reason, 'unresolved_specific_location');
    assert.equal(result.status, 'MATCH');
  });
}

test('an OpenAI failure persists PARSER_ERROR and never crashes the pipeline', async () => {
  const { deps, insertedRuns } = makeDeps({
    classifyAndParse: async () => ({ ok: false, errorCode: 'PARSER_ERROR', reason: 'timeout' }),
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw(), provider: 'telegram', deps });
  assert.equal(result.status, 'PARSER_ERROR');
  assert.equal(insertedRuns[0].originalText, telegramRaw().text); // TZ 104-105: raw message is never lost
});

test('AI usage is logged for a successful classification call', async () => {
  const { deps, loggedUsage } = makeDeps({
    classifyAndParse: async () => ({ ok: true, value: makeAiValue(), warnings: [], usage: { model: 'gpt-4o-mini', promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0.001 } }),
  });
  await runWebhookPipeline({ rawPayload: telegramRaw(), provider: 'telegram', deps });
  assert.equal(loggedUsage.length, 1);
  assert.equal(loggedUsage[0].usage.totalTokens, 15);
});
