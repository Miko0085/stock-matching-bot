'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAiOutput } = require('../../src/parser/schema');

test('parseAiOutput: a genuine listing is parsed with all fields', () => {
  const { value, warnings } = parseAiOutput({
    is_listing: true,
    city: 'Dubai',
    area: 'Business Bay',
    building: 'Ohana - Jacob & Co',
    property_type: 'Apartment',
    bedrooms: 3,
    bathrooms: 3,
    selling_price: 7750000,
    annual_rent: null,
    size_sqft: 2153,
    plot_size_sqft: null,
    furnishing: null,
    view: 'Full Sea & Sunset View',
    distress: false,
    confidence: 0.9,
  });
  assert.equal(value.is_listing, true);
  assert.equal(value.city, 'Dubai');
  assert.equal(value.area, 'Business Bay');
  assert.equal(value.bedrooms, 3);
  assert.equal(value.selling_price, 7750000);
  assert.deepEqual(warnings, []);
});

test('parseAiOutput: is_listing=false never throws and defaults everything else to null/false', () => {
  const { value } = parseAiOutput({ is_listing: false });
  assert.equal(value.is_listing, false);
  assert.equal(value.city, null);
  assert.equal(value.area, null);
  assert.equal(value.distress, false);
});

test('parseAiOutput: malformed/missing input never throws', () => {
  assert.doesNotThrow(() => parseAiOutput(null));
  assert.doesNotThrow(() => parseAiOutput(undefined));
  assert.doesNotThrow(() => parseAiOutput('not an object'));
  assert.doesNotThrow(() => parseAiOutput({}));
});

test('parseAiOutput: an invalid property_type enum is dropped to null with a warning, never trusted as-is', () => {
  const { value, warnings } = parseAiOutput({ is_listing: true, property_type: 'Spaceship' });
  assert.equal(value.property_type, null);
  assert.ok(warnings.includes('invalid_enum:property_type'));
});

test('parseAiOutput: an invalid furnishing enum is dropped to null with a warning', () => {
  const { value, warnings } = parseAiOutput({ is_listing: true, furnishing: 'Maybe' });
  assert.equal(value.furnishing, null);
  assert.ok(warnings.includes('invalid_enum:furnishing'));
});

test('parseAiOutput: a currency-formatted numeric string is coerced defensively, not rejected', () => {
  const { value, warnings } = parseAiOutput({ is_listing: true, selling_price: '7,750,000' });
  assert.equal(value.selling_price, 7750000);
  assert.deepEqual(warnings, []);
});

test('parseAiOutput: distress and is_listing are real booleans, accepting string forms defensively', () => {
  assert.equal(parseAiOutput({ is_listing: 'true', distress: 'yes' }).value.is_listing, true);
  assert.equal(parseAiOutput({ is_listing: 'false', distress: 'no' }).value.distress, false);
});

test('parseAiOutput: confidence is clamped into [0, 1]', () => {
  assert.equal(parseAiOutput({ confidence: 1.5 }).value.confidence, 1);
  assert.equal(parseAiOutput({ confidence: -0.5 }).value.confidence, 0);
  assert.equal(parseAiOutput({ confidence: null }).value.confidence, null);
});
