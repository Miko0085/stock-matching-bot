'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAiOutput } = require('../../src/parser/schema');

test('TZ 25 example round-trips cleanly', () => {
  const { value, warnings } = parseAiOutput({
    message_class: 'buyer_request',
    demand_owner: 'sender',
    promotion: false,
    spam: false,
    transaction_type: 'SALE',
    area: 'Business Bay',
    project: 'The Edge',
    building: null,
    property_type: 'Apartment',
    bedrooms_min: 1,
    bedrooms_max: 1,
    budget_min: null,
    budget_max: 1300000,
    furnishing: null,
    cash_buyer: true,
    confidence: 0.96,
  });
  assert.deepEqual(warnings, []);
  assert.equal(value.message_class, 'buyer_request');
  assert.equal(value.demand_owner, 'sender');
  assert.equal(value.area, 'Business Bay');
  assert.equal(value.budget_max, 1300000);
  assert.equal(value.confidence, 0.96);
});

test('TZ 28 example: broker_solicitation + recipient + promotion', () => {
  const { value } = parseAiOutput({
    message_class: 'broker_solicitation',
    demand_owner: 'recipient',
    promotion: true,
    spam: false,
  });
  assert.equal(value.message_class, 'broker_solicitation');
  assert.equal(value.demand_owner, 'recipient');
  assert.equal(value.promotion, true);
});

test('an invalid message_class falls back to unknown and records a warning', () => {
  const { value, warnings } = parseAiOutput({ message_class: 'not_a_real_class' });
  assert.equal(value.message_class, 'unknown');
  assert.ok(warnings.includes('invalid_enum:message_class'));
});

test('an invalid demand_owner falls back to unknown and records a warning', () => {
  const { value, warnings } = parseAiOutput({ demand_owner: 'nobody' });
  assert.equal(value.demand_owner, 'unknown');
  assert.ok(warnings.includes('invalid_enum:demand_owner'));
});

test('missing message_class/demand_owner default to unknown, never buyer_request/sender by accident', () => {
  const { value } = parseAiOutput({});
  assert.equal(value.message_class, 'unknown');
  assert.equal(value.demand_owner, 'unknown');
});

test('"studio" as a bedroom bound coerces to 0', () => {
  const { value } = parseAiOutput({ bedrooms_min: 'studio', bedrooms_max: 'Studio' });
  assert.equal(value.bedrooms_min, 0);
  assert.equal(value.bedrooms_max, 0);
});

test('an open-ended "3BR+" shape (bedrooms_max null) is preserved as an open range', () => {
  const { value } = parseAiOutput({ bedrooms_min: 3, bedrooms_max: null });
  assert.equal(value.bedrooms_min, 3);
  assert.equal(value.bedrooms_max, null);
});

test('swapped bedrooms_min/max are corrected with a warning', () => {
  const { value, warnings } = parseAiOutput({ bedrooms_min: 4, bedrooms_max: 2 });
  assert.equal(value.bedrooms_min, 2);
  assert.equal(value.bedrooms_max, 4);
  assert.ok(warnings.includes('bedrooms_min_greater_than_bedrooms_max'));
});

test('swapped budget_min/max are corrected with a warning', () => {
  const { value, warnings } = parseAiOutput({ budget_min: 3000000, budget_max: 2000000 });
  assert.equal(value.budget_min, 2000000);
  assert.equal(value.budget_max, 3000000);
  assert.ok(warnings.includes('budget_min_greater_than_budget_max'));
});

test('a malformed number is dropped to null with a warning, never trusted as-is', () => {
  const { value, warnings } = parseAiOutput({ budget_max: 'not-a-number' });
  assert.equal(value.budget_max, null);
  assert.ok(warnings.includes('malformed_number:budget_max'));
});

test('confidence is clamped into [0, 1]', () => {
  assert.equal(parseAiOutput({ confidence: 1.5 }).value.confidence, 1);
  assert.equal(parseAiOutput({ confidence: -0.2 }).value.confidence, 0);
});

test('null raw input never throws, degrades to all-defaults', () => {
  assert.doesNotThrow(() => parseAiOutput(null));
  assert.doesNotThrow(() => parseAiOutput(undefined));
  assert.doesNotThrow(() => parseAiOutput('not an object'));
});

// Multi-area (spec sections 10-17): `areas` is the canonical internal
// representation; `area` stays for back-compat only.
test('areas: an explicit array is coerced, de-duplicated case-insensitively, order preserved', () => {
  const { value } = parseAiOutput({ area: 'Warsan', areas: ['Warsan', 'Al Furjan', 'warsan', ' Al Furjan '] });
  assert.deepEqual(value.areas, ['Warsan', 'Al Furjan']);
});

test('areas: falls back to a one-element array built from `area` when `areas` is absent', () => {
  const { value } = parseAiOutput({ area: 'Business Bay' });
  assert.deepEqual(value.areas, ['Business Bay']);
});

test('areas: empty when neither `area` nor `areas` is stated', () => {
  const { value } = parseAiOutput({});
  assert.deepEqual(value.areas, []);
});

test('areas: a bare string (not an array) is still accepted defensively', () => {
  const { value } = parseAiOutput({ areas: 'Business Bay' });
  assert.deepEqual(value.areas, ['Business Bay']);
});
