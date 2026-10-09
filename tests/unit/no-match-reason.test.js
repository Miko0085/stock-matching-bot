'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { determineNoMatchReason } = require('../../src/core/no-match-reason');
const {
  computeScore,
  isBudgetWithinTolerance,
  isBedroomsAcceptable,
  isPropertyTypeAcceptable,
} = require('../../src/core/scoring');
const { DEFAULT_CONFIG } = require('../../src/core/config');
const { makeStock } = require('../../tests/fixtures/stock');

const now = new Date();
const freshSync = now.toISOString();

const request = {
  area: 'Business Bay',
  building: 'Peninsula Four',
  bedrooms: 2,
  propertyType: 'Apartment',
  budgetMin: null,
  budgetMax: 2500000,
  furnishing: 'Furnished',
};

function scoreAgainst(stock) {
  return {
    stock,
    score: computeScore(request, stock, DEFAULT_CONFIG),
    // Mirrors matcher.js's real pipeline (ADR-018/ADR-019/ADR-025) —
    // determineNoMatchReason reads these flags, not the raw scores, for
    // all_candidates_over_budget/bedrooms_mismatch/property_type_mismatch.
    priceOutOfRange: !isBudgetWithinTolerance(request, stock, DEFAULT_CONFIG),
    bedroomsOutOfRange: !isBedroomsAcceptable(request, stock),
    propertyTypeOutOfRange: !isPropertyTypeAcceptable(request, stock),
  };
}

test('parser_missing_fields takes precedence over everything else', () => {
  const reason = determineNoMatchReason({
    parserWarnings: ['parser_missing_fields'],
    stockSyncedAt: freshSync,
    staleHours: 36,
    now,
    candidates: [],
    scored: [],
  });
  assert.equal(reason, 'parser_missing_fields');
});

test('stale stock sync is reported before other diagnostics', () => {
  const stale = new Date(now.getTime() - 100 * 60 * 60 * 1000).toISOString();
  const reason = determineNoMatchReason({
    parserWarnings: [],
    stockSyncedAt: stale,
    staleHours: 36,
    now,
    candidates: [makeStock()],
    scored: [scoreAgainst(makeStock())],
  });
  assert.equal(reason, 'stock_not_synced');
});

test('no stock at all reports no_stock_in_location', () => {
  const reason = determineNoMatchReason({
    parserWarnings: [],
    stockSyncedAt: freshSync,
    staleHours: 36,
    now,
    candidates: [],
    scored: [],
  });
  assert.equal(reason, 'no_stock_in_location');
});

test('unresolved building with no textual match reports building_not_resolved', () => {
  const candidates = [makeStock({ building: 'Different Tower' })];
  const reason = determineNoMatchReason({
    parserWarnings: [],
    areaProvided: true,
    areaResolved: true,
    areaRawValue: 'Business Bay',
    buildingProvided: true,
    buildingResolved: false,
    buildingRawValue: 'Ghost Tower',
    stockSyncedAt: freshSync,
    staleHours: 36,
    now,
    candidates,
    scored: candidates.map(scoreAgainst),
  });
  assert.equal(reason, 'building_not_resolved');
});

test('all candidates bedrooms mismatch reports bedrooms_mismatch', () => {
  const candidates = [makeStock({ building: 'Peninsula Four', bedrooms: 3 })];
  const reason = determineNoMatchReason({
    parserWarnings: [],
    areaProvided: true,
    areaResolved: true,
    buildingProvided: true,
    buildingResolved: true,
    stockSyncedAt: freshSync,
    staleHours: 36,
    now,
    candidates,
    scored: candidates.map(scoreAgainst),
  });
  assert.equal(reason, 'bedrooms_mismatch');
});

test('all candidates property type mismatch reports property_type_mismatch', () => {
  const candidates = [makeStock({ property_type: 'Villa' })];
  const reason = determineNoMatchReason({
    parserWarnings: [],
    areaProvided: true,
    areaResolved: true,
    buildingProvided: true,
    buildingResolved: true,
    stockSyncedAt: freshSync,
    staleHours: 36,
    now,
    candidates,
    scored: candidates.map(scoreAgainst),
  });
  assert.equal(reason, 'property_type_mismatch');
});

test('all candidates over budget tolerance reports all_candidates_over_budget', () => {
  const candidates = [makeStock({ selling_price: 5000000 })];
  const reason = determineNoMatchReason({
    parserWarnings: [],
    areaProvided: true,
    areaResolved: true,
    buildingProvided: true,
    buildingResolved: true,
    stockSyncedAt: freshSync,
    staleHours: 36,
    now,
    candidates,
    scored: candidates.map(scoreAgainst),
  });
  assert.equal(reason, 'all_candidates_over_budget');
});

test('otherwise falls back to score_below_threshold', () => {
  const candidates = [makeStock({ furnishing: 'Unfurnished', bedrooms: 2 })];
  // Force a low but nonzero score across all buckets by mismatching only furnishing,
  // which alone is not enough to trip any of the specific reasons above.
  const reason = determineNoMatchReason({
    parserWarnings: [],
    areaProvided: true,
    areaResolved: true,
    buildingProvided: true,
    buildingResolved: true,
    stockSyncedAt: freshSync,
    staleHours: 36,
    now,
    candidates,
    scored: candidates.map(scoreAgainst),
  });
  assert.equal(reason, 'score_below_threshold');
});
