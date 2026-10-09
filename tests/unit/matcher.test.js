'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchRequest } = require('../../src/core/matcher');
const { buildAliasIndex } = require('../../src/core/aliases');
const { DEFAULT_CONFIG } = require('../../src/core/config');
const { aliasRows } = require('../../tests/fixtures/aliases');
const { makeStock, fiveMatchingStock } = require('../../tests/fixtures/stock');
const { makeParsedRequest } = require('../../tests/fixtures/requests');

const aliasIndex = buildAliasIndex(aliasRows);
const now = new Date();

test('CRITICAL: five successful stock matches are all returned and persisted', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest(),
    aliasIndex,
    stockCandidates: fiveMatchingStock,
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });

  assert.equal(result.matchesCount, 5);
  assert.equal(result.successfulMatches.length, 5);
  const ids = result.successfulMatches.map((m) => m.stock.stock_id).sort();
  assert.deepEqual(ids, ['STK-1001', 'STK-1002', 'STK-1003', 'STK-1004', 'STK-1005']);
  assert.notEqual(result.resultStatus, 'NO_MATCH');
});

test('alias P4 resolves before matching against canonical stock building', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({ building: 'P4' }),
    aliasIndex,
    stockCandidates: [makeStock()],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.successfulMatches.length, 1);
  assert.equal(result.scored[0].score.location, 30);
});

test('alias BB resolves area before matching', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({ area: 'BB', building: null }),
    aliasIndex,
    stockCandidates: [makeStock()],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.scored[0].score.location, 30);
});

test('results are ranked best score first', () => {
  const stock = [
    makeStock({ stock_id: 'LOW', selling_price: 2900000 }),
    makeStock({ stock_id: 'HIGH', selling_price: 2500000 }),
  ];
  const result = matchRequest({
    parsedRequest: makeParsedRequest(),
    aliasIndex,
    stockCandidates: stock,
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.scored[0].stock.stock_id, 'HIGH');
  assert.equal(result.scored[0].rank, 1);
});

test('NO_MATCH when no candidates score above threshold', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest(),
    aliasIndex,
    stockCandidates: [makeStock({ bedrooms: 5, property_type: 'Villa', area: 'JVC' })],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.successfulMatches.length, 0);
  assert.ok(result.noMatchReason);
});

test('no active stock at all yields no_stock_in_location', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest(),
    aliasIndex,
    stockCandidates: [],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.noMatchReason, 'no_stock_in_location');
});

test('unresolved area alias yields area_not_resolved', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({ area: 'Nowhere Land', building: null }),
    aliasIndex,
    stockCandidates: [makeStock()],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.noMatchReason, 'area_not_resolved');
});

test('a request with no usable criteria never produces a false positive match', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({
      area: null,
      building: null,
      bedrooms: null,
      property_type: null,
    }),
    parserWarnings: ['parser_missing_fields'],
    aliasIndex,
    stockCandidates: [makeStock()],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'parser_missing_fields');
  assert.equal(result.successfulMatches.length, 0);
});

test('REGRESSION (2026-09-14): buying_intent=false is never overridden by a coincidentally-present area', () => {
  // Real production incident: "Ищу соседку в однокомнатную квартиру...
  // Район JVC" (looking for a roommate, not a buyer/renter). The AI
  // correctly returned buying_intent:false (is_request at the time), but it
  // still extracted area="JVC" since the district is literally named in the
  // text — that alone used to be enough to skip the parser_missing_fields
  // gate and score it as a STRONG_MATCH against real JVC stock.
  const result = matchRequest({
    parsedRequest: makeParsedRequest({
      buying_intent: false,
      area: 'Business Bay',
      building: null,
      bedrooms: null,
      property_type: null,
      budget_min: null,
      budget_max: null,
      furnishing: null,
    }),
    aliasIndex,
    stockCandidates: [makeStock()],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'not_a_request');
  assert.equal(result.successfulMatches.length, 0);
});

test('ADR-017: promotion=true blocks a match even with a full set of extracted criteria', () => {
  // A seller/broker post advertising their own listing can still incidentally
  // extract clean area/bedrooms/budget fields — promotion must win over that.
  const result = matchRequest({
    parsedRequest: makeParsedRequest({ promotion: true }),
    aliasIndex,
    stockCandidates: [makeStock()],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'promotion_listing');
  assert.equal(result.successfulMatches.length, 0);
});

test('ADR-017: spam=true blocks a match, and takes priority over promotion', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({ spam: true, promotion: true }),
    aliasIndex,
    stockCandidates: [makeStock()],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'spam_content');
  assert.equal(result.successfulMatches.length, 0);
});

test('ADR-017: seeking_info=true (a question or complaint, not a stated requirement) blocks a match', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({ seeking_info: true }),
    aliasIndex,
    stockCandidates: [makeStock()],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'seeking_info');
  assert.equal(result.successfulMatches.length, 0);
});

test('ADR-018: a price far over budget is never rescued by perfect location/bedrooms/type/furnishing scores', () => {
  // Before ADR-018, budget was only 20 of 100 weighted points -- a listing
  // wildly over budget could still clear the 70-point MATCH threshold on
  // location(30)+bedrooms(25)+propertyType(15)+furnishing(10)=80 alone.
  // This is the exact real-world complaint the fix addresses: "иногда цена
  // сильно отличается от запроса и стока."
  const result = matchRequest({
    parsedRequest: makeParsedRequest({ budget_max: 2500000 }),
    aliasIndex,
    stockCandidates: [makeStock({ selling_price: 5000000 })], // 100% over budget
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'all_candidates_over_budget');
  assert.equal(result.successfulMatches.length, 0);
});

test('ADR-018: a price within the tolerance band still matches normally', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({ budget_max: 2500000 }),
    aliasIndex,
    stockCandidates: [makeStock({ selling_price: 2625000 })], // 5% over — within the 10% tolerance
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.notEqual(result.resultStatus, 'NO_MATCH');
});

test('ADR-019: a bedroom mismatch is never rescued by perfect location/type/budget/furnishing scores', () => {
  // Real production incident: a request for a 5-bedroom villa (budget up
  // to 10M, no area stated) was shown 4-bedroom and 3-bedroom villas at
  // 75/100 MATCH each -- exactly location(30)+propertyType(15)+budget(20)+
  // furnishing(10), zero bedroom credit, still clearing the 70-point
  // threshold. Reproduced here with the same shape (no area requested, so
  // location scores full credit; property type/budget/furnishing all
  // align) and a 1-bedroom-off stock candidate.
  const result = matchRequest({
    parsedRequest: makeParsedRequest({
      area: null,
      building: null,
      bedrooms: 5,
      property_type: 'Villa',
      budget_min: null,
      budget_max: 10000000,
      furnishing: null,
    }),
    aliasIndex,
    stockCandidates: [makeStock({ property_type: 'Villa', bedrooms: 4, selling_price: 6550000 })],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'bedrooms_mismatch');
  assert.equal(result.successfulMatches.length, 0);
});

test('ADR-019: an exact bedroom match still succeeds normally', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({
      area: null,
      building: null,
      bedrooms: 5,
      property_type: 'Villa',
      budget_min: null,
      budget_max: 10000000,
      furnishing: null,
    }),
    aliasIndex,
    stockCandidates: [makeStock({ property_type: 'Villa', bedrooms: 5, selling_price: 6550000 })],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.notEqual(result.resultStatus, 'NO_MATCH');
});

test('ADR-025 REGRESSION: a Townhouse request is never rescued by perfect location/bedrooms/budget/furnishing scores against Apartment stock', () => {
  // Real production incident: a Townhouse request with no stated area/beds
  // fanned out to dozens of Apartment listings, all at 85/100 STRONG_MATCH
  // -- exactly location(30)+bedrooms(25)+budget(20)+furnishing(10), zero
  // property-type credit, still clearing the 85-point STRONG_MATCH
  // threshold. Reproduced here with the same shape (no area/bedrooms
  // requested, so both score full credit) against real Apartment stock.
  const result = matchRequest({
    parsedRequest: makeParsedRequest({
      area: null,
      building: null,
      bedrooms: null,
      property_type: 'Townhouse',
      budget_min: null,
      budget_max: null,
      furnishing: null,
    }),
    aliasIndex,
    stockCandidates: [makeStock({ property_type: 'Apartment', bedrooms: 2, selling_price: 3530000 })],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'property_type_mismatch');
  assert.equal(result.successfulMatches.length, 0);
});

test('ADR-025 REGRESSION: a budget RANGE request is never matched against stock far under the stated minimum (real incident: 3-7M range vs 890K apartment)', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({
      area: null,
      building: null,
      bedrooms: null,
      property_type: 'Townhouse',
      budget_min: 3000000,
      budget_max: 7000000,
      furnishing: null,
    }),
    aliasIndex,
    stockCandidates: [makeStock({ property_type: 'Townhouse', bedrooms: null, selling_price: 890000 })],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'all_candidates_over_budget');
  assert.equal(result.successfulMatches.length, 0);
});

test('ADR-025: a matching property type still succeeds normally', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({
      area: null,
      building: null,
      bedrooms: null,
      property_type: 'Townhouse',
      budget_min: null,
      budget_max: null,
      furnishing: null,
    }),
    aliasIndex,
    stockCandidates: [makeStock({ property_type: 'Townhouse', bedrooms: 3, selling_price: 5000000 })],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.notEqual(result.resultStatus, 'NO_MATCH');
});

test('ADR-020 REGRESSION: property_type alone never matches nationwide (real incident: villa plot, 5 named areas, unparseable budget)', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({
      area: null,
      building: null,
      bedrooms: null,
      property_type: 'Villa',
      budget_min: null,
      budget_max: null,
      furnishing: null,
    }),
    // matcher.js doesn't call request-schema.js itself — parserWarnings is
    // what validateParsedRequest() would have produced upstream in the
    // real pipeline; simulated here the same way the n8n glue wires them.
    parserWarnings: ['parser_missing_fields'],
    aliasIndex,
    // Several villas across different areas — before the fix, EVERY one
    // of these would have scored 100/100 STRONG_MATCH.
    stockCandidates: [
      makeStock({ stock_id: 'V1', property_type: 'Villa', area: 'Mohammed Bin Rashid City', selling_price: 21945000 }),
      makeStock({ stock_id: 'V2', property_type: 'Villa', area: 'Dubailand', selling_price: 6550000 }),
      makeStock({ stock_id: 'V3', property_type: 'Villa', area: 'Al Barsha', selling_price: 9000000 }),
    ],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'parser_missing_fields');
  assert.equal(result.successfulMatches.length, 0);
});

test('a RENT request against SALE-only stock yields transaction_type_mismatch, never a false-positive match', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({ transaction_type: 'RENT' }),
    aliasIndex,
    stockCandidates: [makeStock()],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.equal(result.resultStatus, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'transaction_type_mismatch');
  assert.equal(result.successfulMatches.length, 0);
});

test('a request with no transaction_type stated is not blocked by the transaction-type gate', () => {
  const result = matchRequest({
    parsedRequest: makeParsedRequest({ transaction_type: null }),
    aliasIndex,
    stockCandidates: [makeStock()],
    config: DEFAULT_CONFIG,
    stockSyncedAt: now.toISOString(),
    now,
  });
  assert.notEqual(result.resultStatus, 'NO_MATCH');
});

test('stale stock sync yields stock_not_synced', () => {
  const staleDate = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const result = matchRequest({
    parsedRequest: makeParsedRequest(),
    aliasIndex,
    stockCandidates: [makeStock()],
    config: DEFAULT_CONFIG,
    stockSyncedAt: staleDate.toISOString(),
    now,
  });
  assert.equal(result.noMatchReason, 'stock_not_synced');
});
