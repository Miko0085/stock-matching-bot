'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateParsedRequest } = require('../../src/core/request-schema');
const { makeParsedRequest } = require('../../tests/fixtures/requests');

test('valid structured request passes through unchanged', () => {
  const { value, warnings } = validateParsedRequest(makeParsedRequest());
  assert.equal(value.area, 'Business Bay');
  assert.equal(value.bedrooms, 2);
  assert.equal(value.transaction_type, 'SALE');
  assert.deepEqual(warnings, []);
});

test('missing optional fields default to null without errors', () => {
  const { value, errors } = validateParsedRequest({
    buying_intent: true,
    area: 'Business Bay',
  });
  assert.equal(value.building, null);
  assert.equal(value.budget_max, null);
  assert.equal(value.furnishing, null);
  assert.deepEqual(errors, []);
});

test('malformed number is rejected to null with a warning', () => {
  const { value, warnings } = validateParsedRequest(
    makeParsedRequest({ budget_max: 'not-a-number' })
  );
  assert.equal(value.budget_max, null);
  assert.ok(warnings.includes('malformed_number:budget_max'));
});

test('hallucinated unsupported enum is rejected by the validator', () => {
  const { value, warnings } = validateParsedRequest(
    makeParsedRequest({ transaction_type: 'LEASE_TO_OWN' })
  );
  assert.equal(value.transaction_type, null);
  assert.ok(warnings.includes('invalid_enum:transaction_type'));
});

test('nulls are accepted where appropriate', () => {
  const { value, errors } = validateParsedRequest(
    makeParsedRequest({ budget_min: null, furnishing: null, cash_buyer: null })
  );
  assert.equal(value.budget_min, null);
  assert.equal(value.furnishing, null);
  assert.equal(value.cash_buyer, null);
  assert.deepEqual(errors, []);
});

test('studio bedrooms normalize to 0', () => {
  const { value } = validateParsedRequest(makeParsedRequest({ bedrooms: 'Studio' }));
  assert.equal(value.bedrooms, 0);
});

test('a request with no usable criteria is flagged as parser_missing_fields', () => {
  const { warnings } = validateParsedRequest({ buying_intent: true });
  assert.ok(warnings.includes('parser_missing_fields'));
});

test('ADR-020 REGRESSION: property_type alone is not enough — real incident (villa plot, 5 named areas the schema could not hold, "Market Price" budget)', () => {
  // Real production incident: a "villa plot" request named 5 specific
  // areas (Al Khawaneej, Al Barsha, Al Warsan, Al Awir, Al Warqa) our
  // single `area` field can't represent, so the parser returned area:
  // null; budget was stated as "Market Price" (unparseable, budget_max:
  // null). Only property_type: "Villa" survived. That alone used to be
  // enough to pass this gate, and with every other field null, "unknown
  // doesn't penalize" scored it 100/100 against every villa in the entire
  // stock (74 STRONG_MATCH Telegram messages for one ambiguous post).
  const { warnings } = validateParsedRequest({
    buying_intent: true,
    area: null,
    building: null,
    bedrooms: null,
    property_type: 'Villa',
    budget_min: null,
    budget_max: null,
  });
  assert.ok(warnings.includes('parser_missing_fields'));
});

test('ADR-027 REGRESSION: a budget-only request (no area/building/bedrooms) IS flagged as missing fields', () => {
  // Real production incident: a WhatsApp request with no area, no
  // bedrooms, no property type, and only "Budget: up to 100,000,000 AED"
  // (effectively unbounded) matched 74 listings -- apartments, villas, an
  // office studio -- across every area in the stock, all at 100/100. A
  // budget ceiling narrows nothing about location or property type, the
  // same failure mode ADR-020 already fixed for property_type alone.
  // Budget was briefly counted as sufficient criteria here (see git
  // history) specifically to fix a "budget-only should count" gap; this
  // incident is why that was wrong and got reverted.
  const { warnings } = validateParsedRequest({
    buying_intent: true,
    area: null,
    building: null,
    bedrooms: null,
    property_type: null,
    budget_min: null,
    budget_max: 100000000,
  });
  assert.ok(warnings.includes('parser_missing_fields'));
});

test('area, building, or bedrooms alone is each sufficient — no budget/property_type needed', () => {
  const base = { buying_intent: true, area: null, building: null, bedrooms: null, property_type: null };
  assert.ok(!validateParsedRequest({ ...base, area: 'Business Bay' }).warnings.includes('parser_missing_fields'));
  assert.ok(!validateParsedRequest({ ...base, building: 'Peninsula Four' }).warnings.includes('parser_missing_fields'));
  assert.ok(!validateParsedRequest({ ...base, bedrooms: 2 }).warnings.includes('parser_missing_fields'));
});

test('buying_intent defaults to true (permissive) when the parser omits it', () => {
  const { value, warnings } = validateParsedRequest({ area: 'Business Bay' });
  assert.equal(value.buying_intent, true);
  assert.ok(warnings.includes('missing:buying_intent'));
});

test('seeking_info/promotion/spam default to false (conservative) when omitted', () => {
  const { value, warnings } = validateParsedRequest(makeParsedRequest());
  assert.equal(value.seeking_info, false);
  assert.equal(value.promotion, false);
  assert.equal(value.spam, false);
  assert.deepEqual(warnings, []);
});

test('the four classification labels are coerced independently of each other', () => {
  const { value, warnings } = validateParsedRequest(
    makeParsedRequest({ buying_intent: false, seeking_info: true, promotion: false, spam: false })
  );
  assert.equal(value.buying_intent, false);
  assert.equal(value.seeking_info, true);
  assert.equal(value.promotion, false);
  assert.equal(value.spam, false);
  assert.deepEqual(warnings, []);
});

test('a non-boolean classification label falls back to its default with a warning', () => {
  const { value, warnings } = validateParsedRequest(makeParsedRequest({ promotion: 'maybe' }));
  assert.equal(value.promotion, false);
  assert.ok(warnings.includes('malformed_boolean:promotion'));
});

test('swapped budget bounds are corrected', () => {
  const { value, warnings } = validateParsedRequest(
    makeParsedRequest({ budget_min: 3000000, budget_max: 2000000 })
  );
  assert.equal(value.budget_min, 2000000);
  assert.equal(value.budget_max, 3000000);
  assert.ok(warnings.includes('budget_min_greater_than_budget_max'));
});
