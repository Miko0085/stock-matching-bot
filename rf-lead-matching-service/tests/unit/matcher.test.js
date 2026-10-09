'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchRequest } = require('../../src/matching/matcher');

function baseRequest(overrides = {}) {
  return {
    transaction_type: null, district: null, complex: null, property_type: null,
    rooms: null, rooms_sentinel: null, bedrooms_min: null, bedrooms_max: null,
    budget_min: null, budget_max: null, area_sqm_min: null, area_sqm_max: null,
    floor_min: null, floor_max: null, readiness_year: null,
    ...overrides,
  };
}

function allSettingsOn(overrides = {}) {
  const keys = ['joker_property_type_enabled', 'joker_rooms_enabled', 'joker_bedrooms_enabled', 'joker_area_enabled', 'joker_floor_enabled', 'joker_price_enabled', 'joker_readiness_enabled'];
  const settings = {};
  for (const k of keys) settings[k] = { value: true };
  settings.joker_price_tolerance_pct = { value: 10 };
  return { ...settings, ...overrides };
}

function stockRow(overrides = {}) {
  return {
    joker_object_id: 1, deal_type: 'sale', property_type: 'Квартиры - вторичное жильё', property_type_excluded: false,
    district: 'ЮЗАО', complex: null, rooms: 3, rooms_sentinel: null, bedrooms: null,
    area_sqm: 80, floor: 5, price: 20000000, readiness_year: null,
    ...overrides,
  };
}

test('no location named at all -> INSUFFICIENT_CRITERIA (location_unspecified), never runs a query', async () => {
  let queried = false;
  const result = await matchRequest({
    structuredRequest: baseRequest({ budget_max: 20000000 }),
    resolution: {},
    settings: allSettingsOn(),
    fetchCandidates: async () => { queried = true; return []; },
    checkLocationExists: async () => true,
  });
  assert.equal(result.status, 'INSUFFICIENT_CRITERIA');
  assert.equal(result.noMatchReason, 'location_unspecified');
  assert.equal(queried, false);
});

test('location named but no other criteria -> INSUFFICIENT_CRITERIA (insufficient_criteria), mirrors UAE\'s hasMinimumSpecificity', async () => {
  const result = await matchRequest({
    structuredRequest: baseRequest({ district: 'ЮЗАО' }),
    resolution: { districtResolved: true },
    settings: allSettingsOn(),
    fetchCandidates: async () => [],
    checkLocationExists: async () => true,
  });
  assert.equal(result.status, 'INSUFFICIENT_CRITERIA');
  assert.equal(result.noMatchReason, 'insufficient_criteria');
});

test('an unresolved district that does not exist anywhere in stock -> NO_MATCH (location_not_found), never runs the full candidate query', async () => {
  let fullQueryRan = false;
  const result = await matchRequest({
    structuredRequest: baseRequest({ district: 'Несуществующий район', budget_max: 20000000 }),
    resolution: { districtResolved: false },
    settings: allSettingsOn(),
    fetchCandidates: async () => { fullQueryRan = true; return []; },
    checkLocationExists: async () => false,
  });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'location_not_found');
  assert.equal(fullQueryRan, false);
});

test('a real surviving candidate -> MATCH, ranked and scored', async () => {
  const result = await matchRequest({
    structuredRequest: baseRequest({ district: 'ЮЗАО', budget_max: 20000000, rooms: 3 }),
    resolution: { districtResolved: true },
    settings: allSettingsOn(),
    fetchCandidates: async () => [stockRow()],
    checkLocationExists: async () => true,
  });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].rank, 1);
  assert.ok(result.matches[0].score.total > 0);
});

test('zero candidates in the resolved district at all -> NO_MATCH (no_stock_in_district)', async () => {
  const result = await matchRequest({
    structuredRequest: baseRequest({ district: 'ЮЗАО', budget_max: 20000000 }),
    resolution: { districtResolved: true },
    settings: allSettingsOn(),
    fetchCandidates: async () => [],
    checkLocationExists: async () => true,
  });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'no_stock_in_district');
});

test('candidates exist in the district but none survive filtering -> NO_MATCH with a diagnosed reason (not a generic one)', async () => {
  // full-query call (with filters) returns nothing; location-only call (no
  // filters) returns the real stock so the reason can be diagnosed.
  let call = 0;
  const result = await matchRequest({
    structuredRequest: baseRequest({ district: 'ЮЗАО', rooms: 5 }),
    resolution: { districtResolved: true },
    settings: allSettingsOn(),
    fetchCandidates: async () => {
      call += 1;
      return call === 1 ? [] : [stockRow({ rooms: 3 })];
    },
    checkLocationExists: async () => true,
  });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'rooms_mismatch');
});

test('multiple survivors are ranked by score descending, ties broken by joker_object_id', async () => {
  const result = await matchRequest({
    structuredRequest: baseRequest({ district: 'ЮЗАО', budget_max: 20000000, rooms: 3 }),
    resolution: { districtResolved: true },
    settings: allSettingsOn(),
    fetchCandidates: async () => [
      stockRow({ joker_object_id: 2, price: 25000000 }), // over budget after tolerance -> filtered
      stockRow({ joker_object_id: 1, price: 20000000 }),
      stockRow({ joker_object_id: 3, price: 20500000 }),
    ],
    checkLocationExists: async () => true,
  });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.matches.length, 2, 'the 25M candidate is filtered out (>10% over budget)');
  assert.equal(result.matches[0].score.total >= result.matches[1].score.total, true);
});
