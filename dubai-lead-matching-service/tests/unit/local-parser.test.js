'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLocally, detectBedrooms, detectBudget, detectNumericRange } = require('../../src/parser/local-parser');

function areaAlias(name) {
  return { area: new Map([[name.toLowerCase().replace(/\s+/g, ''), { canonical: name }]]) };
}

test('detectBedrooms: 2BR / 2-3BR / 3BR+ / Studio', () => {
  assert.deepEqual(detectBedrooms('need 2br apartment'), { min: 2, max: 2 });
  assert.deepEqual(detectBedrooms('looking for 2-3BR'), { min: 2, max: 3 });
  assert.deepEqual(detectBedrooms('3BR+ villa'), { min: 3, max: null });
  assert.deepEqual(detectBedrooms('studio please'), { min: 0, max: 0 });
});

test('detectBudget: bare single amount defaults to budget_max only (never budget_min)', () => {
  assert.deepEqual(detectBudget('AED 2.5M'), { min: null, max: 2_500_000 });
});

test('detectBudget: "max"/"up to" cue -> budget_max', () => {
  assert.deepEqual(detectBudget('max 2.5M'), { min: null, max: 2_500_000 });
  assert.deepEqual(detectBudget('up to 2.7m'), { min: null, max: 2_700_000 });
});

// P1 release blocker (spec sections 32/50-56): detectNumericRange used to
// use a comma-blind `\d+` token, silently truncating "1,100 sqft" down to
// "100 sqft" (the regex engine skipped the un-matchable "1," and matched
// starting at "100"). Every numeric shape below must now round-trip
// exactly, matching detectBudget's AMOUNT_RE, which was already safe.
test('detectNumericRange: comma-grouped thousands are never truncated (real incident: "1,100 sqft" -> 100)', () => {
  assert.deepEqual(detectNumericRange('unit is 1,100 sqft', ['sq\\.?\\s*ft', 'sqft']), { min: 1100, max: 1100 });
  assert.deepEqual(detectNumericRange('unit is 2,500 sqft', ['sq\\.?\\s*ft', 'sqft']), { min: 2500, max: 2500 });
  assert.deepEqual(detectNumericRange('plot is 10,000 sqft', ['sq\\.?\\s*ft', 'sqft']), { min: 10000, max: 10000 });
});

test('detectNumericRange: a plain concatenated number (no separator) still parses whole, not truncated the other way', () => {
  assert.deepEqual(detectNumericRange('unit is 1100 sqft', ['sq\\.?\\s*ft', 'sqft']), { min: 1100, max: 1100 });
});

test('detectNumericRange: a space used as the thousands separator is also accepted', () => {
  assert.deepEqual(detectNumericRange('unit is 1 100 sqft', ['sq\\.?\\s*ft', 'sqft']), { min: 1100, max: 1100 });
});

test('detectNumericRange: comma-grouped numbers also work inside a range and with max/min cues', () => {
  assert.deepEqual(detectNumericRange('900-1,100 sqft', ['sq\\.?\\s*ft', 'sqft']), { min: 900, max: 1100 });
  assert.deepEqual(detectNumericRange('max 1,100 sqft', ['sq\\.?\\s*ft', 'sqft']), { min: null, max: 1100 });
  assert.deepEqual(detectNumericRange('min 1,100 sqft', ['sq\\.?\\s*ft', 'sqft']), { min: 1100, max: null });
});

test('detectNumericRange: end-to-end via parseLocally -- size_sqft_max reflects the full comma-grouped value', () => {
  const result = parseLocally('Looking for 2BR apartment, 1,100 sqft, budget 2M AED', {});
  assert.equal(result.value.size_sqft_max, 1100);
});

test('P1.4 UAE/RF isolation: Russian budget phrasing ("до X млн") is NOT understood by the UAE parser', () => {
  // This file is the Dubai contour's local parser ONLY. Russian buyer
  // phrases/units belong to the separate RF contour's own parser -- a
  // Russian amount phrase must not be extracted here, not even
  // coincidentally, or UAE and RF semantics would quietly merge again.
  assert.equal(detectBudget('до 6 млн'), null);
});

test('P0.1 release blocker: strong buyer-intent phrases are recognized (EN only)', () => {
  const { detectStrongBuyerIntent } = require('../../src/parser/local-parser');
  assert.equal(detectStrongBuyerIntent('Need a 2BR in Business Bay'), true);
  assert.equal(detectStrongBuyerIntent('My client is looking for a villa'), true);
  assert.equal(detectStrongBuyerIntent('WTB 2BR Business Bay'), true);
  assert.equal(detectStrongBuyerIntent('Business Bay 2BR AED 2.5M Furnished'), false);
});

test('parseLocally: "Need 2BR Business Bay max 2.5M cash" -- fully local-parseable', () => {
  const result = parseLocally('Need 2BR Business Bay max 2.5M cash', { aliasIndex: areaAlias('Business Bay') });
  assert.equal(result.hedge, false);
  assert.equal(result.hasLocation, true);
  assert.equal(result.value.area, 'Business Bay');
  assert.equal(result.value.bedrooms_min, 2);
  assert.equal(result.value.bedrooms_max, 2);
  assert.equal(result.value.budget_max, 2_500_000);
  assert.equal(result.value.cash_buyer, true);
  assert.equal(result.value.message_class, 'buyer_request');
  assert.equal(result.value.demand_owner, 'sender');
});

test('parseLocally: "My client needs P4 2BR up to 2.7m" -- building alias resolved from index', () => {
  const aliasIndex = { building: new Map([['p4', { canonical: 'Peninsula Four' }]]) };
  const result = parseLocally('My client needs P4 2BR up to 2.7m', { aliasIndex });
  assert.equal(result.hasLocation, true);
  assert.equal(result.value.building, 'P4');
  assert.equal(result.value.bedrooms_min, 2);
  assert.equal(result.value.budget_max, 2_700_000);
});

test('P1.4 UAE/RF isolation: a pure-Russian free-form request extracts no RF-only criteria in the UAE parser', () => {
  const result = parseLocally('Ищу клиенту 3 спальни в Dubai Hills до 6 млн, cash', { aliasIndex: areaAlias('Dubai Hills') });
  // The English area name "Dubai Hills" is still found (UAE area alias
  // matching is language-agnostic text matching, not Russian semantics),
  // but the Russian bedroom count ("3 спальни") and Russian budget phrase
  // ("до 6 млн") must NOT be extracted -- those belong to the RF parser.
  assert.equal(result.value.area, 'Dubai Hills');
  assert.equal(result.value.bedrooms_min, null);
  assert.equal(result.value.bedrooms_max, null);
  assert.equal(result.value.budget_max, null);
  // "cash" is an English word and is still recognized -- that's fine,
  // it's UAE vocabulary that happens to appear in a mixed-language message.
  assert.equal(result.value.cash_buyer, true);
});

test('parseLocally: a hedge phrase forces ambiguity even with a location present', () => {
  const result = parseLocally(
    'Client is considering something around the canal, maybe BB or Downtown, can stretch depending on the payment plan',
    { aliasIndex: areaAlias('Business Bay') }
  );
  assert.equal(result.hedge, true);
  assert.equal(result.value, null);
});

test('parseLocally: no location at all -> hasLocation false, not enough to skip AI', () => {
  const result = parseLocally('Need 2BR max 2.5M cash', { aliasIndex: {} });
  assert.equal(result.hasLocation, false);
});

test('parseLocally: never infers a value that is not explicitly present', () => {
  const result = parseLocally('Need something in Business Bay', { aliasIndex: areaAlias('Business Bay') });
  assert.equal(result.value.bedrooms_min, null);
  assert.equal(result.value.budget_max, null);
  assert.equal(result.value.property_type, null);
});
