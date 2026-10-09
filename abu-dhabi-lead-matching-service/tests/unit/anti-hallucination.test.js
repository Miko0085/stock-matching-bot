'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripUnverifiableLocationFields } = require('../../src/parser/anti-hallucination');

test('real regression: a hallucinated area not present anywhere in the text is nulled', () => {
  const aiValue = { area: 'Dubai Marina', project: 'The Edge', building: null };
  const originalText = 'Urgently looking for a corner 1 BR at the Edge by Select Group. Budget 1,300,000 AED.';
  const result = stripUnverifiableLocationFields(aiValue, originalText);
  assert.equal(result.area, null);
  assert.equal(result.project, 'The Edge'); // literally present in the text -- kept
});

test('a value that genuinely appears in the text (case-insensitive) is kept', () => {
  const result = stripUnverifiableLocationFields({ area: 'business bay', project: null, building: null }, 'Need 2BR in Business Bay please');
  assert.equal(result.area, 'business bay');
});

test('null fields are never flagged as hallucinated', () => {
  const result = stripUnverifiableLocationFields({ area: null, project: null, building: null }, 'anything');
  assert.equal(result.area, null);
  assert.equal(result.project, null);
  assert.equal(result.building, null);
});

test('does not mutate unrelated fields', () => {
  const aiValue = { area: 'Nowhere Real', bedrooms_min: 2, budget_max: 100 };
  const result = stripUnverifiableLocationFields(aiValue, 'no location mentioned here');
  assert.equal(result.bedrooms_min, 2);
  assert.equal(result.budget_max, 100);
});

// Multi-area (spec sections 10-17): each named area is verified against the
// text independently -- a hallucinated one never taints a genuine one.
test('multi-area: a hallucinated SECOND area is dropped while a genuine first one is kept', () => {
  const aiValue = { area: 'Warsan', areas: ['Warsan', 'Dubai Marina'], project: null, building: null };
  const originalText = 'Looking for a 2BR in Warsan, budget 900k';
  const result = stripUnverifiableLocationFields(aiValue, originalText);
  assert.deepEqual(result.areas, ['Warsan']);
});

test('multi-area: every genuinely-named area survives verification', () => {
  const aiValue = { area: 'Warsan', areas: ['Warsan', 'Al Furjan'], project: null, building: null };
  const originalText = 'Looking for 3-4BR in Warsan, Al Furjan or Nad Al Sheba Gardens, budget up to 6M cash';
  const result = stripUnverifiableLocationFields(aiValue, originalText);
  assert.deepEqual(result.areas, ['Warsan', 'Al Furjan']);
});
