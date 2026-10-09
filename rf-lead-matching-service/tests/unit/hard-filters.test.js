'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  dealTypeFilter, propertyTypeFilter, locationFilter, roomsFilter,
  bedroomsFilter, areaFilter, floorFilter, priceFilter, readinessFilter,
  evaluateHardFilters,
} = require('../../src/matching/hard-filters');

function baseRequest(overrides = {}) {
  return {
    transaction_type: null, property_type: null, rooms: null, rooms_sentinel: null,
    bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: null,
    area_sqm_min: null, area_sqm_max: null, floor_min: null, floor_max: null,
    readiness_year: null,
    ...overrides,
  };
}

function baseStock(overrides = {}) {
  return {
    deal_type: 'sale', property_type: 'Квартиры - вторичное жильё', property_type_excluded: false,
    district: 'ЮЗАО', complex: 'Событие', rooms: 3, rooms_sentinel: null, bedrooms: null,
    area_sqm: 80, floor: 5, price: 20000000, readiness_year: null,
    ...overrides,
  };
}

function allSettingsOn(overrides = {}) {
  const keys = ['joker_property_type_enabled', 'joker_rooms_enabled', 'joker_bedrooms_enabled', 'joker_area_enabled', 'joker_floor_enabled', 'joker_price_enabled', 'joker_readiness_enabled'];
  const settings = {};
  for (const k of keys) settings[k] = { value: true, enabled: true };
  settings.joker_price_tolerance_pct = { value: 10, enabled: true };
  return { ...settings, ...overrides };
}

test('dealTypeFilter: SALE request against sale stock passes; against rent stock fails; never gated by a toggle', () => {
  const request = baseRequest({ transaction_type: 'SALE' });
  assert.equal(dealTypeFilter(request, baseStock({ deal_type: 'sale' })).passes, true);
  assert.equal(dealTypeFilter(request, baseStock({ deal_type: 'rent' })).passes, false);
  assert.equal(dealTypeFilter(baseRequest(), baseStock()).active, false, 'not stated -> not active');
});

test('dealTypeFilter: RENT request against rent stock passes; against sale stock fails', () => {
  const request = baseRequest({ transaction_type: 'RENT' });
  assert.equal(dealTypeFilter(request, baseStock({ deal_type: 'rent' })).passes, true);
  assert.equal(dealTypeFilter(request, baseStock({ deal_type: 'sale' })).passes, false);
});

test('propertyTypeFilter: commercial stock is always excluded, independent of the joker_property_type_enabled toggle', () => {
  const result = propertyTypeFilter(baseRequest(), baseStock({ property_type_excluded: true }), allSettingsOn({ joker_property_type_enabled: { value: false } }));
  assert.equal(result.active, true);
  assert.equal(result.passes, false);
});

test('propertyTypeFilter: disabled via settings -> never active even when the buyer states it', () => {
  const request = baseRequest({ property_type: 'квартира' });
  const settings = allSettingsOn({ joker_property_type_enabled: { value: false } });
  const result = propertyTypeFilter(request, baseStock({ property_type: 'дом' }), settings);
  assert.equal(result.active, false, 'operator disabled this criterion -- must never block');
});

test('locationFilter: matches at the resolved level, never gated by a toggle', () => {
  assert.equal(locationFilter('district', 'ЮЗАО', baseStock({ district: 'ЮЗАО' })).passes, true);
  assert.equal(locationFilter('district', 'ЮЗАО', baseStock({ district: 'ВАО' })).passes, false);
  assert.equal(locationFilter(null, null, baseStock()).active, false);
});

test('roomsFilter: exact match required; STUDIO/FREE_PLAN sentinels handled explicitly, never conflated with rooms=0', () => {
  const settings = allSettingsOn();
  assert.equal(roomsFilter(baseRequest({ rooms: 3 }), baseStock({ rooms: 3 }), settings).passes, true);
  assert.equal(roomsFilter(baseRequest({ rooms: 3 }), baseStock({ rooms: 2 }), settings).passes, false);
  assert.equal(roomsFilter(baseRequest({ rooms: 3 }), baseStock({ rooms: null }), settings).passes, false, 'unverifiable -> blocks (rooms is the reliable field)');
  assert.equal(
    roomsFilter(baseRequest({ rooms_sentinel: 'STUDIO' }), baseStock({ rooms: null, rooms_sentinel: 'STUDIO' }), settings).passes,
    true
  );
  assert.equal(
    roomsFilter(baseRequest({ rooms_sentinel: 'STUDIO' }), baseStock({ rooms: 1, rooms_sentinel: null }), settings).passes,
    false,
    'a real 1-room listing must never satisfy a studio request'
  );
});

test('roomsFilter: disabled via settings -> never active', () => {
  const settings = allSettingsOn({ joker_rooms_enabled: { value: false } });
  const result = roomsFilter(baseRequest({ rooms: 3 }), baseStock({ rooms: 5 }), settings);
  assert.equal(result.active, false);
});

test('bedroomsFilter: missing stock data SKIPS (active:false), never blocks -- deliberate divergence from UAE given ~96% real-data sparsity', () => {
  const settings = allSettingsOn();
  const request = baseRequest({ bedrooms_min: 2, bedrooms_max: 2 });
  const result = bedroomsFilter(request, baseStock({ bedrooms: null }), settings);
  assert.equal(result.active, false, 'must skip, not block, when stock has no bedrooms value');
});

test('bedroomsFilter: when stock DOES have a value, it is still checked as a real range filter', () => {
  const settings = allSettingsOn();
  const request = baseRequest({ bedrooms_min: 2, bedrooms_max: 2 });
  assert.equal(bedroomsFilter(request, baseStock({ bedrooms: 2 }), settings).passes, true);
  assert.equal(bedroomsFilter(request, baseStock({ bedrooms: 4 }), settings).passes, false);
});

test('areaFilter/floorFilter: inclusive range, unverifiable stock blocks, disabled setting skips', () => {
  const settings = allSettingsOn();
  assert.equal(areaFilter(baseRequest({ area_sqm_min: 50, area_sqm_max: 100 }), baseStock({ area_sqm: 80 }), settings).passes, true);
  assert.equal(areaFilter(baseRequest({ area_sqm_min: 50, area_sqm_max: 100 }), baseStock({ area_sqm: 200 }), settings).passes, false);
  assert.equal(areaFilter(baseRequest({ area_sqm_min: 50, area_sqm_max: 100 }), baseStock({ area_sqm: null }), settings).passes, false);
  const disabled = allSettingsOn({ joker_area_enabled: { value: false } });
  assert.equal(areaFilter(baseRequest({ area_sqm_min: 50 }), baseStock({ area_sqm: null }), disabled).active, false);
});

test('priceFilter: tolerance applies only to the ceiling, floor is strict', () => {
  const settings = allSettingsOn();
  const request = baseRequest({ budget_max: 20000000 });
  assert.equal(priceFilter(request, baseStock({ price: 20000000 }), settings).passes, true);
  assert.equal(priceFilter(request, baseStock({ price: 21000000 }), settings).passes, true, '5% over is within 10% tolerance');
  assert.equal(priceFilter(request, baseStock({ price: 23000000 }), settings).passes, false, '>10% over is blocked');
  const floorRequest = baseRequest({ budget_min: 15000000 });
  assert.equal(priceFilter(floorRequest, baseStock({ price: 14000000 }), settings).passes, false, 'floor is never discounted');
});

test('readinessFilter: stock must be ready no later than the requested year', () => {
  const settings = allSettingsOn();
  const request = baseRequest({ readiness_year: 2027 });
  assert.equal(readinessFilter(request, baseStock({ readiness_year: 2025 }), settings).passes, true);
  assert.equal(readinessFilter(request, baseStock({ readiness_year: 2030 }), settings).passes, false);
});

test('evaluateHardFilters: a candidate passing everything is admitted; the first real failure is reported', () => {
  const settings = allSettingsOn();
  const request = baseRequest({ transaction_type: 'SALE', rooms: 3, budget_max: 20000000 });
  const goodStock = baseStock();
  const result = evaluateHardFilters(request, goodStock, { locationLevel: 'district', locationValue: 'ЮЗАО', settings });
  assert.equal(result.passed, true);

  const badStock = baseStock({ rooms: 5 });
  const failed = evaluateHardFilters(request, badStock, { locationLevel: 'district', locationValue: 'ЮЗАО', settings });
  assert.equal(failed.passed, false);
  assert.equal(failed.failedFilter, 'rooms');
});
