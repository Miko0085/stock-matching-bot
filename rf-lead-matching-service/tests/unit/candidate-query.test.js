'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidateQuery, buildLocationExistsQuery } = require('../../src/matching/candidate-query');

function baseRequest(overrides = {}) {
  return {
    transaction_type: null, property_type: null, rooms: null, rooms_sentinel: null,
    bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: null,
    area_sqm_min: null, area_sqm_max: null, floor_min: null, floor_max: null,
    readiness_year: null,
    ...overrides,
  };
}

function allSettingsOn(overrides = {}) {
  const keys = ['joker_property_type_enabled', 'joker_rooms_enabled', 'joker_area_enabled', 'joker_floor_enabled', 'joker_price_enabled', 'joker_readiness_enabled'];
  const settings = {};
  for (const k of keys) settings[k] = { value: true };
  settings.joker_price_tolerance_pct = { value: 10 };
  return { ...settings, ...overrides };
}

test('buildCandidateQuery: always filters available=true and property_type_excluded=false', () => {
  const { sql } = buildCandidateQuery({ structuredRequest: baseRequest(), locationLevel: null, locationValue: null, settings: allSettingsOn() });
  assert.match(sql, /available = true/);
  assert.match(sql, /property_type_excluded = false/);
  assert.match(sql, /FROM matching_moscow\.stock_inventory/);
});

test('buildCandidateQuery: filters at the resolved location level only (complex XOR district)', () => {
  const complexQuery = buildCandidateQuery({ structuredRequest: baseRequest(), locationLevel: 'complex', locationValue: 'Событие', settings: allSettingsOn() });
  assert.match(complexQuery.sql, /lower\(complex\) = lower\(\$1\)/);
  assert.deepEqual(complexQuery.params, ['Событие']);

  const districtQuery = buildCandidateQuery({ structuredRequest: baseRequest(), locationLevel: 'district', locationValue: 'ЮЗАО', settings: allSettingsOn() });
  assert.match(districtQuery.sql, /lower\(district\) = lower\(\$1\)/);
  assert.doesNotMatch(districtQuery.sql, /complex/);
});

test('buildCandidateQuery: a disabled criterion is never pushed into SQL, even when the request states it', () => {
  const settings = allSettingsOn({ joker_rooms_enabled: { value: false } });
  const { sql } = buildCandidateQuery({ structuredRequest: baseRequest({ rooms: 3 }), locationLevel: null, locationValue: null, settings });
  assert.doesNotMatch(sql, /\brooms\s*=/);
});

test('buildCandidateQuery: rooms_sentinel and rooms are mutually exclusive conditions', () => {
  const settings = allSettingsOn();
  const studio = buildCandidateQuery({ structuredRequest: baseRequest({ rooms_sentinel: 'STUDIO' }), locationLevel: null, locationValue: null, settings });
  assert.match(studio.sql, /rooms_sentinel = \$1/);
  assert.doesNotMatch(studio.sql, /\brooms\s*=\s*\$/);
});

test('buildCandidateQuery: bedrooms is NEVER pushed into SQL, even when enabled and stated -- stays a JS-only graceful check', () => {
  const { sql } = buildCandidateQuery({ structuredRequest: baseRequest({ bedrooms_min: 2 }), locationLevel: null, locationValue: null, settings: allSettingsOn() });
  assert.doesNotMatch(sql, /bedrooms/);
});

test('buildCandidateQuery: price tolerance is applied to the ceiling only', () => {
  const { sql, params } = buildCandidateQuery({ structuredRequest: baseRequest({ budget_max: 20000000, budget_min: 10000000 }), locationLevel: null, locationValue: null, settings: allSettingsOn() });
  assert.match(sql, /price <= \$\d+/);
  assert.match(sql, /price >= \$\d+/);
  assert.ok(params.includes(22000000), 'ceiling includes the 10% tolerance');
  assert.ok(params.includes(10000000), 'floor has no tolerance applied');
});

test('buildCandidateQuery: deal type (buy/rent) is always pushed into SQL, never gated by a toggle', () => {
  const { sql, params } = buildCandidateQuery({ structuredRequest: baseRequest({ transaction_type: 'SALE' }), locationLevel: null, locationValue: null, settings: {} });
  assert.match(sql, /lower\(deal_type\) = \$1/);
  assert.deepEqual(params, ['sale']);
});

test('buildCandidateQuery: a RENT request pushes deal_type = rent into SQL', () => {
  const { sql, params } = buildCandidateQuery({ structuredRequest: baseRequest({ transaction_type: 'RENT' }), locationLevel: null, locationValue: null, settings: {} });
  assert.match(sql, /lower\(deal_type\) = \$1/);
  assert.deepEqual(params, ['rent']);
});

test('buildLocationExistsQuery: ignores everything except the location column itself', () => {
  const { sql, params } = buildLocationExistsQuery({ level: 'district', value: 'ЮЗАО' });
  assert.match(sql, /lower\(district\) = lower\(\$1\)/);
  assert.deepEqual(params, ['ЮЗАО']);
});
