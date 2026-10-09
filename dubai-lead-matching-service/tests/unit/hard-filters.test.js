'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  transactionTypeFilter,
  propertyTypeFilter,
  locationFilter,
  budgetFilter,
  bedroomsFilter,
  evaluateHardFilters,
} = require('../../src/matching/hard-filters');

const CONFIG = { matchPriceTolerancePct: 10 };

function makeStock(overrides = {}) {
  return {
    stock_id: 'STK-1',
    status: 'ACTIVE',
    transaction_type: 'SALE',
    area: 'Business Bay',
    project_community: 'Business Bay',
    building: 'Peninsula Four',
    bedrooms: 2,
    property_type: 'Apartment',
    selling_price: 2500000,
    ...overrides,
  };
}

function makeRequest(overrides = {}) {
  return {
    transaction_type: 'SALE',
    property_type: 'Apartment',
    bedrooms_min: 2,
    bedrooms_max: 2,
    budget_min: null,
    budget_max: 2500000,
    ...overrides,
  };
}

test('transactionTypeFilter: inactive when not stated, hard-blocks on mismatch', () => {
  assert.deepEqual(transactionTypeFilter({ transaction_type: null }, makeStock()), { active: false, passes: true });
  assert.deepEqual(transactionTypeFilter({ transaction_type: 'RENT' }, makeStock({ transaction_type: 'SALE' })), {
    active: true,
    passes: false,
  });
});

// P0 release blocker regression: stock stores rentals as
// `transaction_type = 'RENT_YEARLY'` (confirmed live vocabulary), not the
// request's own 'RENT' value. Before the transaction-semantics fix, this
// bare-equality filter rejected every real RENT_YEARLY stock row for every
// RENT request, unconditionally.
test('transactionTypeFilter TZ P0: a RENT request is compatible with RENT_YEARLY stock', () => {
  const result = transactionTypeFilter({ transaction_type: 'RENT' }, makeStock({ transaction_type: 'RENT_YEARLY' }));
  assert.deepEqual(result, { active: true, passes: true });
});

test('transactionTypeFilter TZ P0: a SALE request is still incompatible with RENT_YEARLY stock', () => {
  const result = transactionTypeFilter({ transaction_type: 'SALE' }, makeStock({ transaction_type: 'RENT_YEARLY' }));
  assert.deepEqual(result, { active: true, passes: false });
});

test('propertyTypeFilter: unverifiable stock (no property_type on record) blocks', () => {
  const result = propertyTypeFilter({ property_type: 'Apartment' }, makeStock({ property_type: null }));
  assert.deepEqual(result, { active: true, passes: false });
});

test('propertyTypeFilter: TZ 43 real incident -- Townhouse never matches Apartment', () => {
  const result = propertyTypeFilter({ property_type: 'Townhouse' }, makeStock({ property_type: 'Apartment' }));
  assert.equal(result.passes, false);
});

test('locationFilter: TZ 43/96 -- a different building never passes when building is the active level', () => {
  const result = locationFilter('building', 'The Edge', makeStock({ building: '340 Riverside Crescent' }));
  assert.equal(result.active, true);
  assert.equal(result.passes, false);
});

test('locationFilter: project level compares against project_community', () => {
  const result = locationFilter('project', 'Emaar Beachfront', makeStock({ project_community: 'Emaar Beachfront' }));
  assert.equal(result.passes, true);
});

test('budgetFilter TZ 50-51: max-only applies the 10% ceiling tolerance', () => {
  assert.equal(budgetFilter(makeRequest({ budget_max: 2500000 }), makeStock({ selling_price: 2750000 }), CONFIG).passes, true); // exactly +10%
  assert.equal(budgetFilter(makeRequest({ budget_max: 2500000 }), makeStock({ selling_price: 2750001 }), CONFIG).passes, false);
});

test('budgetFilter TZ 50-51: min-only is a STRICT floor, no tolerance discount', () => {
  assert.equal(budgetFilter(makeRequest({ budget_min: 2000000, budget_max: null }), makeStock({ selling_price: 2000000 }), CONFIG).passes, true);
  assert.equal(budgetFilter(makeRequest({ budget_min: 2000000, budget_max: null }), makeStock({ selling_price: 1999999 }), CONFIG).passes, false);
});

test('budgetFilter TZ 51: min+max range -- floor strict, ceiling tolerant', () => {
  const request = makeRequest({ budget_min: 2000000, budget_max: 2500000 });
  assert.equal(budgetFilter(request, makeStock({ selling_price: 1999999 }), CONFIG).passes, false); // under floor
  assert.equal(budgetFilter(request, makeStock({ selling_price: 2750000 }), CONFIG).passes, true); // within ceiling tolerance
  assert.equal(budgetFilter(request, makeStock({ selling_price: 2750001 }), CONFIG).passes, false);
});

test('budgetFilter: inactive when neither bound stated', () => {
  assert.deepEqual(budgetFilter(makeRequest({ budget_min: null, budget_max: null }), makeStock(), CONFIG), { active: false, passes: true });
});

// P0 release blocker regression (spec section 4): RENT stock prices
// through `annual_rent`, not `selling_price` (NULL on every RENT_YEARLY
// row) -- comparing a RENT budget against selling_price always blocked,
// on top of the transaction_type mismatch above.
test('budgetFilter TZ P0-a: RENT request within budget survives against annual_rent, ignoring a null selling_price', () => {
  const request = makeRequest({ transaction_type: 'RENT', budget_min: null, budget_max: 150000 });
  const stock = makeStock({ transaction_type: 'RENT_YEARLY', selling_price: null, annual_rent: 140000 });
  assert.equal(budgetFilter(request, stock, CONFIG).passes, true);
});

test('budgetFilter TZ P0-b: RENT request over budget rejects based on annual_rent', () => {
  const request = makeRequest({ transaction_type: 'RENT', budget_min: null, budget_max: 150000 });
  const stock = makeStock({ transaction_type: 'RENT_YEARLY', selling_price: null, annual_rent: 180000 });
  assert.equal(budgetFilter(request, stock, CONFIG).passes, false);
});

test('budgetFilter TZ P0-c: SALE request compares against selling_price, ignoring a null annual_rent', () => {
  const request = makeRequest({ transaction_type: 'SALE', budget_min: null, budget_max: 2000000 });
  const stock = makeStock({ transaction_type: 'SALE', selling_price: 2000000, annual_rent: null });
  assert.equal(budgetFilter(request, stock, CONFIG).passes, true);
});

test('budgetFilter TZ P0-d: SALE never reads annual_rent, RENT never reads selling_price', () => {
  // SALE request against a row with a cheap selling_price but an expensive
  // annual_rent -- must pass on selling_price alone.
  const saleRequest = makeRequest({ transaction_type: 'SALE', budget_min: null, budget_max: 1000000 });
  const saleStock = makeStock({ transaction_type: 'SALE', selling_price: 900000, annual_rent: 99000000 });
  assert.equal(budgetFilter(saleRequest, saleStock, CONFIG).passes, true);

  // RENT request against a row with a cheap annual_rent but an expensive
  // selling_price -- must pass on annual_rent alone.
  const rentRequest = makeRequest({ transaction_type: 'RENT', budget_min: null, budget_max: 100000 });
  const rentStock = makeStock({ transaction_type: 'RENT_YEARLY', selling_price: 99000000, annual_rent: 90000 });
  assert.equal(budgetFilter(rentRequest, rentStock, CONFIG).passes, true);
});

test('bedroomsFilter TZ 52: exact request never accepts a neighboring count', () => {
  const request = makeRequest({ bedrooms_min: 2, bedrooms_max: 2 });
  assert.equal(bedroomsFilter(request, makeStock({ bedrooms: 2 })).passes, true);
  assert.equal(bedroomsFilter(request, makeStock({ bedrooms: 1 })).passes, false);
  assert.equal(bedroomsFilter(request, makeStock({ bedrooms: 3 })).passes, false);
});

test('bedroomsFilter TZ 53: a range (2-3BR) accepts stock within the inclusive range', () => {
  const request = makeRequest({ bedrooms_min: 2, bedrooms_max: 3 });
  assert.equal(bedroomsFilter(request, makeStock({ bedrooms: 2 })).passes, true);
  assert.equal(bedroomsFilter(request, makeStock({ bedrooms: 3 })).passes, true);
  assert.equal(bedroomsFilter(request, makeStock({ bedrooms: 4 })).passes, false);
});

test('bedroomsFilter TZ 53: "3BR+" (open-ended max) accepts anything >= min', () => {
  const request = makeRequest({ bedrooms_min: 3, bedrooms_max: null });
  assert.equal(bedroomsFilter(request, makeStock({ bedrooms: 5 })).passes, true);
  assert.equal(bedroomsFilter(request, makeStock({ bedrooms: 2 })).passes, false);
});

test('bedroomsFilter: a stock row with no bedroom count on record blocks when the criterion is active', () => {
  const request = makeRequest({ bedrooms_min: 2, bedrooms_max: 2 });
  assert.equal(bedroomsFilter(request, makeStock({ bedrooms: null })).passes, false);
});

test('bedroomsFilter: inactive when neither bound stated -- missing criterion never filters (TZ 95)', () => {
  assert.deepEqual(bedroomsFilter(makeRequest({ bedrooms_min: null, bedrooms_max: null }), makeStock({ bedrooms: 99 })), {
    active: false,
    passes: true,
  });
});

test('evaluateHardFilters: TZ 96 wrong-location-rescue -- wrong building rejected even with perfect price/bedrooms/type', () => {
  const request = makeRequest();
  const stock = makeStock({ building: 'Some Other Tower', selling_price: 2500000, bedrooms: 2, property_type: 'Apartment' });
  const result = evaluateHardFilters(request, stock, { locationLevel: 'building', locationValue: 'The Edge', config: CONFIG });
  assert.equal(result.passed, false);
  assert.equal(result.failedFilter, 'location');
});

test('evaluateHardFilters: a fully-compatible candidate passes every active filter', () => {
  const request = makeRequest();
  const stock = makeStock();
  const result = evaluateHardFilters(request, stock, { locationLevel: 'area', locationValue: 'Business Bay', config: CONFIG });
  assert.equal(result.passed, true);
  assert.equal(result.failedFilter, null);
});
