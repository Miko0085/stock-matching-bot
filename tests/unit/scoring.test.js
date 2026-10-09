'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeScore,
  classifyScore,
  isBudgetWithinTolerance,
  isBedroomsAcceptable,
  isPropertyTypeAcceptable,
} = require('../../src/core/scoring');
const { DEFAULT_CONFIG } = require('../../src/core/config');
const { makeStock } = require('../../tests/fixtures/stock');

const baseRequest = {
  area: 'Business Bay',
  building: 'Peninsula Four',
  bedrooms: 2,
  propertyType: 'Apartment',
  budgetMin: null,
  budgetMax: 2500000,
  furnishing: 'Furnished',
};

test('exact building + all criteria match scores 100', () => {
  const score = computeScore(baseRequest, makeStock(), DEFAULT_CONFIG);
  assert.equal(score.total, 100);
});

test('same area but different building gives partial location credit', () => {
  const score = computeScore(
    baseRequest,
    makeStock({ building: 'Some Other Tower' }),
    DEFAULT_CONFIG
  );
  assert.equal(score.location, 18); // 30 * 0.6
});

test('wrong area scores zero location', () => {
  const score = computeScore(
    baseRequest,
    makeStock({ area: 'JVC', building: 'Some Other Tower' }),
    DEFAULT_CONFIG
  );
  assert.equal(score.location, 0);
});

test('bedrooms mismatch scores zero bedrooms component', () => {
  const score = computeScore(baseRequest, makeStock({ bedrooms: 3 }), DEFAULT_CONFIG);
  assert.equal(score.bedrooms, 0);
});

test('unknown request bedrooms does not penalize', () => {
  const score = computeScore({ ...baseRequest, bedrooms: null }, makeStock(), DEFAULT_CONFIG);
  assert.equal(score.bedrooms, 25);
});

test('property type mismatch scores zero', () => {
  const score = computeScore(
    baseRequest,
    makeStock({ property_type: 'Villa' }),
    DEFAULT_CONFIG
  );
  assert.equal(score.propertyType, 0);
});

test('furnishing explicit mismatch scores zero', () => {
  const score = computeScore(
    baseRequest,
    makeStock({ furnishing: 'Unfurnished' }),
    DEFAULT_CONFIG
  );
  assert.equal(score.furnishing, 0);
});

test('missing request furnishing does not penalize', () => {
  const score = computeScore({ ...baseRequest, furnishing: null }, makeStock(), DEFAULT_CONFIG);
  assert.equal(score.furnishing, 10);
});

test('missing stock furnishing does not crash and does not penalize', () => {
  assert.doesNotThrow(() => {
    const score = computeScore(baseRequest, makeStock({ furnishing: null }), DEFAULT_CONFIG);
    assert.equal(score.furnishing, 10);
  });
});

test('budget tolerance bands for a 2,500,000 budget', () => {
  const within = computeScore(baseRequest, makeStock({ selling_price: 2500000 }), DEFAULT_CONFIG);
  assert.equal(within.budget, 20);

  const over5 = computeScore(baseRequest, makeStock({ selling_price: 2625000 }), DEFAULT_CONFIG);
  assert.equal(over5.budget, 12);

  const over10Edge = computeScore(
    baseRequest,
    makeStock({ selling_price: 2750000 }),
    DEFAULT_CONFIG
  );
  assert.equal(over10Edge.budget, 5);

  const overTolerance = computeScore(
    baseRequest,
    makeStock({ selling_price: 2750001 }),
    DEFAULT_CONFIG
  );
  assert.equal(overTolerance.budget, 0);
});

test('ADR-018: isBudgetWithinTolerance allows exactly at the tolerance edge, blocks one unit past it', () => {
  assert.equal(
    isBudgetWithinTolerance(baseRequest, makeStock({ selling_price: 2750000 }), DEFAULT_CONFIG),
    true
  );
  assert.equal(
    isBudgetWithinTolerance(baseRequest, makeStock({ selling_price: 2750001 }), DEFAULT_CONFIG),
    false
  );
});

test('ADR-018: a price far beyond tolerance is blocked regardless of how small the overage looks in absolute terms', () => {
  assert.equal(
    isBudgetWithinTolerance(baseRequest, makeStock({ selling_price: 5000000 }), DEFAULT_CONFIG),
    false
  );
});

test('ADR-018: no stated budget_max/budget_min never blocks — unknown does not penalize', () => {
  const noBudgetRequest = { ...baseRequest, budgetMax: null, budgetMin: null };
  assert.equal(
    isBudgetWithinTolerance(noBudgetRequest, makeStock({ selling_price: 99000000 }), DEFAULT_CONFIG),
    true
  );
});

test('ADR-018: a stock row with no price never blocks (nothing to judge)', () => {
  assert.equal(
    isBudgetWithinTolerance(baseRequest, makeStock({ selling_price: null }), DEFAULT_CONFIG),
    true
  );
});

// AUDIT item #7: Number(null) === 0 -- with a budget_max-only request the
// old code happened to still return true (0 never exceeds a positive
// ceiling), which is why the test above never caught this. A budget_MIN-
// only request is where the coercion actually flips the outcome: 0 (from
// the coerced null) reads as "way under the minimum" and used to wrongly
// hard-block a candidate whose price is simply unrecorded, contradicting
// this same function's own "no stock price never blocks" rule one test
// above.
test('AUDIT #7 regression: a null-priced stock row never blocks a budget_min-only request either (Number(null) === 0 trap)', () => {
  const minOnlyRequest = { ...baseRequest, budgetMax: null, budgetMin: 2000000 };
  assert.equal(
    isBudgetWithinTolerance(minOnlyRequest, makeStock({ selling_price: null }), DEFAULT_CONFIG),
    true
  );
});

test('AUDIT #7 regression: an undefined or empty-string selling_price is treated the same as null, never blocks', () => {
  const minOnlyRequest = { ...baseRequest, budgetMax: null, budgetMin: 2000000 };
  assert.equal(isBudgetWithinTolerance(minOnlyRequest, makeStock({ selling_price: undefined }), DEFAULT_CONFIG), true);
  assert.equal(isBudgetWithinTolerance(minOnlyRequest, makeStock({ selling_price: '' }), DEFAULT_CONFIG), true);
});

test('ADR-018: a budget_min-only request blocks a price too far under the minimum', () => {
  const minOnlyRequest = { ...baseRequest, budgetMax: null, budgetMin: 2000000 };
  assert.equal(
    isBudgetWithinTolerance(minOnlyRequest, makeStock({ selling_price: 1800000 }), DEFAULT_CONFIG), // 10% under
    true
  );
  assert.equal(
    isBudgetWithinTolerance(minOnlyRequest, makeStock({ selling_price: 1799999 }), DEFAULT_CONFIG),
    false
  );
});

test('ADR-019: isBedroomsAcceptable requires an exact match — 1 bedroom off is not acceptable', () => {
  assert.equal(isBedroomsAcceptable(baseRequest, makeStock({ bedrooms: 2 })), true);
  assert.equal(isBedroomsAcceptable(baseRequest, makeStock({ bedrooms: 3 })), false);
  assert.equal(isBedroomsAcceptable(baseRequest, makeStock({ bedrooms: 1 })), false);
});

test('ADR-019: no stated request bedrooms never blocks — unknown does not penalize', () => {
  const noBedroomsRequest = { ...baseRequest, bedrooms: null };
  assert.equal(isBedroomsAcceptable(noBedroomsRequest, makeStock({ bedrooms: 99 })), true);
});

test('ADR-019: a stock row with no recorded bedroom count cannot be verified and blocks', () => {
  assert.equal(isBedroomsAcceptable(baseRequest, makeStock({ bedrooms: null })), false);
});

test('ADR-025: real incident — a Townhouse/Villa request is never acceptable against Apartment stock', () => {
  const townhouseRequest = { ...baseRequest, propertyType: 'Townhouse' };
  const villaRequest = { ...baseRequest, propertyType: 'Villa' };
  assert.equal(isPropertyTypeAcceptable(townhouseRequest, makeStock({ property_type: 'Apartment' })), false);
  assert.equal(isPropertyTypeAcceptable(villaRequest, makeStock({ property_type: 'Apartment' })), false);
});

test('ADR-025: a matching property type is acceptable', () => {
  assert.equal(isPropertyTypeAcceptable(baseRequest, makeStock({ property_type: 'Apartment' })), true);
});

test('ADR-025: no stated request property type never blocks — unknown does not penalize', () => {
  const noTypeRequest = { ...baseRequest, propertyType: null };
  assert.equal(isPropertyTypeAcceptable(noTypeRequest, makeStock({ property_type: 'Villa' })), true);
});

test('ADR-025: a stock row with no recorded property type cannot be verified and blocks', () => {
  assert.equal(isPropertyTypeAcceptable(baseRequest, makeStock({ property_type: null })), false);
});

test('ADR-025: a real incident — a stated budget RANGE blocks stock far under the minimum, not just far over the maximum', () => {
  // Real incident: request budget 3,000,000 - 7,000,000 AED; actual stock
  // shown was priced at 890,000 AED (well under the minimum) because the
  // old check only ever validated ONE bound when both were present.
  const rangeRequest = { ...baseRequest, budgetMin: 3000000, budgetMax: 7000000 };
  assert.equal(isBudgetWithinTolerance(rangeRequest, makeStock({ selling_price: 890000 }), DEFAULT_CONFIG), false);
  assert.equal(isBudgetWithinTolerance(rangeRequest, makeStock({ selling_price: 5000000 }), DEFAULT_CONFIG), true);
  // Still blocks far over the maximum too — the ceiling check is preserved.
  assert.equal(isBudgetWithinTolerance(rangeRequest, makeStock({ selling_price: 15000000 }), DEFAULT_CONFIG), false);
});

test('ADR-025: a stated budget range respects the tolerance band at the minimum edge', () => {
  const rangeRequest = { ...baseRequest, budgetMin: 3000000, budgetMax: 7000000 };
  assert.equal(isBudgetWithinTolerance(rangeRequest, makeStock({ selling_price: 2700000 }), DEFAULT_CONFIG), true); // exactly 10% under
  assert.equal(isBudgetWithinTolerance(rangeRequest, makeStock({ selling_price: 2699999 }), DEFAULT_CONFIG), false);
});

test('classifyScore boundaries: 69/70/84/85/100', () => {
  assert.equal(classifyScore(69, DEFAULT_CONFIG), 'NO_MATCH');
  assert.equal(classifyScore(70, DEFAULT_CONFIG), 'MATCH');
  assert.equal(classifyScore(84, DEFAULT_CONFIG), 'MATCH');
  assert.equal(classifyScore(85, DEFAULT_CONFIG), 'STRONG_MATCH');
  assert.equal(classifyScore(100, DEFAULT_CONFIG), 'STRONG_MATCH');
});
