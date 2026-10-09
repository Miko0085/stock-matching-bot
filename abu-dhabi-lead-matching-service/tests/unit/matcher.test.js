'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchRequest } = require('../../src/matching/matcher');
const { makeFakeStockDb } = require('./helpers/fake-stock-db');

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

function baseRequest(overrides = {}) {
  return {
    transaction_type: 'SALE',
    area: null,
    project: null,
    building: null,
    property_type: null,
    bedrooms_min: null,
    bedrooms_max: null,
    budget_min: null,
    budget_max: null,
    ...overrides,
  };
}

const fullResolution = { areaResolved: true, projectResolved: true, buildingResolved: true, propertyTypeResolved: true };

async function runMatch(structuredRequest, stockRows, resolution = fullResolution) {
  const db = makeFakeStockDb(stockRows);
  return matchRequest({
    structuredRequest,
    resolution,
    config: CONFIG,
    fetchCandidates: db.fetchCandidates,
    checkLocationExists: db.checkLocationExists,
  });
}

test('TZ 91 regression: area-only request -> INSUFFICIENT_CRITERIA, never reaches candidate retrieval', () => {
  return runMatch(baseRequest({ area: 'Business Bay' }), [makeStock()]).then((result) => {
    assert.equal(result.status, 'INSUFFICIENT_CRITERIA');
    assert.equal(result.noMatchReason, 'insufficient_criteria');
    assert.equal(result.matches.length, 0);
  });
});

// Renamed from 'location_missing' (spec sections 17-18): distinguishes a
// buyer who genuinely named no location at all (a real buyer, just missing
// criteria for automatic matching) from 'location_not_found' (a buyer who
// DID name a location, but it wasn't recognized) -- the two must never be
// conflated.
test('no location at all -> INSUFFICIENT_CRITERIA / location_unspecified', () => {
  return runMatch(baseRequest({ budget_max: 2500000 }), [makeStock()]).then((result) => {
    assert.equal(result.status, 'INSUFFICIENT_CRITERIA');
    assert.equal(result.noMatchReason, 'location_unspecified');
  });
});

test('TZ 92: area + bedrooms is allowed and finds a match', () => {
  return runMatch(baseRequest({ area: 'Business Bay', bedrooms_min: 2, bedrooms_max: 2 }), [makeStock()]).then((result) => {
    assert.equal(result.status, 'MATCH');
    assert.equal(result.matches.length, 1);
  });
});

test('TZ 43/90/96 CRITICAL regression: The Edge never matches 340 Riverside Crescent', () => {
  const request = baseRequest({ building: 'The Edge', property_type: 'Apartment', bedrooms_min: 1, bedrooms_max: 1, budget_max: 1300000 });
  const stock = [
    makeStock({ stock_id: 'RIVERSIDE', building: '340 Riverside Crescent', area: 'Sobha Hartland II', project_community: 'Sobha Hartland II', bedrooms: 1, property_type: 'Apartment', selling_price: 1235000 }),
  ];
  // Unresolved building name ("The Edge" has no alias and no textual hit
  // in the fake stock) -> location_not_found, per TZ 46-47's "never fall
  // back to a broader pool."
  return runMatch(request, stock, { ...fullResolution, buildingResolved: false }).then((result) => {
    assert.equal(result.status, 'NO_MATCH');
    assert.equal(result.noMatchReason, 'location_not_found');
    assert.equal(result.matches.length, 0);
    assert.ok(!result.matches.some((m) => m.stock.stock_id === 'RIVERSIDE'));
  });
});

test('TZ 43: if The Edge DOES exist in stock, it matches correctly (proves the gate is about wrong buildings, not all buildings)', () => {
  const request = baseRequest({ building: 'The Edge', property_type: 'Apartment', bedrooms_min: 1, bedrooms_max: 1, budget_max: 1300000 });
  const stock = [
    makeStock({ stock_id: 'THE-EDGE-UNIT', building: 'The Edge', area: 'Jumeirah Village Circle', project_community: 'The Edge', bedrooms: 1, property_type: 'Apartment', selling_price: 1250000 }),
    makeStock({ stock_id: 'RIVERSIDE', building: '340 Riverside Crescent', bedrooms: 1, property_type: 'Apartment', selling_price: 1235000 }),
  ];
  return runMatch(request, stock, fullResolution).then((result) => {
    assert.equal(result.status, 'MATCH');
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].stock.stock_id, 'THE-EDGE-UNIT');
  });
});

test('TZ 96 CRITICAL regression: wrong location is rejected even with perfect price/bedrooms/type -- never rescued by score', () => {
  const request = baseRequest({ area: 'Business Bay', property_type: 'Apartment', bedrooms_min: 2, bedrooms_max: 2, budget_max: 2500000 });
  const stock = [makeStock({ stock_id: 'WRONG-AREA', area: 'Dubai Marina', project_community: 'Dubai Marina', bedrooms: 2, property_type: 'Apartment', selling_price: 2500000 })];
  return runMatch(request, stock, fullResolution).then((result) => {
    assert.equal(result.status, 'NO_MATCH');
    assert.equal(result.noMatchReason, 'no_stock_in_area');
    assert.equal(result.matches.length, 0);
  });
});

test('TZ 93: budget tolerance edges -- 2.50 pass, 2.60 pass, 2.75 pass, 2.76 reject', () => {
  const request = baseRequest({ area: 'Business Bay', bedrooms_min: 2, bedrooms_max: 2, budget_max: 2500000 });
  return Promise.all(
    [
      [2500000, 'MATCH'],
      [2600000, 'MATCH'],
      [2750000, 'MATCH'],
      [2760000, 'NO_MATCH'],
    ].map(([price, expected]) =>
      runMatch(request, [makeStock({ selling_price: price })], fullResolution).then((result) => {
        assert.equal(result.status, expected, `price ${price} expected ${expected}, got ${result.status}`);
      })
    )
  );
});

test('TZ 94: bedrooms exactness -- 2BR pass, 1BR reject, 3BR reject', () => {
  const request = baseRequest({ area: 'Business Bay', bedrooms_min: 2, bedrooms_max: 2, budget_max: 2500000 });
  return Promise.all(
    [
      [2, 'MATCH'],
      [1, 'NO_MATCH'],
      [3, 'NO_MATCH'],
    ].map(([bedrooms, expected]) =>
      runMatch(request, [makeStock({ bedrooms })], fullResolution).then((result) => {
        assert.equal(result.status, expected, `bedrooms ${bedrooms} expected ${expected}, got ${result.status}`);
      })
    )
  );
});

test('TZ 95: missing bedrooms criterion never filters and never scores it', () => {
  const request = baseRequest({ area: 'Business Bay', budget_max: 2500000 });
  return runMatch(request, [makeStock({ bedrooms: 7 })], fullResolution).then((result) => {
    assert.equal(result.status, 'MATCH');
    assert.equal(result.matches[0].score.components.bedrooms, undefined);
  });
});

test('TZ 95: missing budget criterion never filters and never scores it', () => {
  const request = baseRequest({ area: 'Business Bay', bedrooms_min: 2, bedrooms_max: 2 });
  return runMatch(request, [makeStock({ selling_price: 99999999 })], fullResolution).then((result) => {
    assert.equal(result.status, 'MATCH');
    assert.equal(result.matches[0].score.components.budget, undefined);
  });
});

test('TZ 40: a resolved but currently-empty building yields no_stock_in_building', () => {
  const request = baseRequest({ building: 'Peninsula Four', bedrooms_min: 2, bedrooms_max: 2 });
  return runMatch(request, [makeStock({ building: 'Peninsula Four', bedrooms: 5 })], fullResolution).then((result) => {
    assert.equal(result.status, 'NO_MATCH');
    assert.equal(result.noMatchReason, 'bedrooms_mismatch');
  });
});

test('every valid match is returned -- never truncated to Top-N (TZ 69, 114)', () => {
  const request = baseRequest({ area: 'Business Bay', bedrooms_min: 2, bedrooms_max: 2 });
  const stock = Array.from({ length: 7 }, (_, i) => makeStock({ stock_id: `STK-${i}`, selling_price: 2000000 + i * 1000 }));
  return runMatch(request, stock, fullResolution).then((result) => {
    assert.equal(result.status, 'MATCH');
    assert.equal(result.matches.length, 7);
  });
});

test('transaction_type mismatch is a hard filter, diagnosed correctly when it is the sole blocker', () => {
  const request = baseRequest({ transaction_type: 'RENT', area: 'Business Bay', bedrooms_min: 2, bedrooms_max: 2 });
  return runMatch(request, [makeStock({ transaction_type: 'SALE' })], fullResolution).then((result) => {
    assert.equal(result.status, 'NO_MATCH');
    assert.equal(result.noMatchReason, 'transaction_mismatch');
  });
});

test('property_type mismatch (real incident: Townhouse vs Apartment) never rescued by perfect location/budget/bedrooms', () => {
  const request = baseRequest({ area: 'Business Bay', property_type: 'Townhouse', bedrooms_min: 2, bedrooms_max: 2, budget_max: 2500000 });
  return runMatch(request, [makeStock({ property_type: 'Apartment' })], fullResolution).then((result) => {
    assert.equal(result.status, 'NO_MATCH');
    assert.equal(result.noMatchReason, 'property_type_mismatch');
  });
});

// Multi-area regressions (spec sections 10-17, Case 01/Case 02 from the
// live forensic audit): several acceptable areas are OR conditions, never a
// reason to discard the lead.
test('multi-area: stock in the SECOND named area still produces a MATCH', () => {
  const request = baseRequest({ area: null, bedrooms_min: 2, bedrooms_max: 2, budget_max: 2500000 });
  const resolution = {
    ...fullResolution,
    areaOptions: [
      { raw: 'Dubai Silicon Oasis', canonical: 'Dubai Silicon Oasis', resolved: true },
      { raw: 'Warsan', canonical: 'Warsan', resolved: true },
    ],
  };
  return runMatch(request, [makeStock({ area: 'Warsan', project_community: 'Warsan' })], resolution).then((result) => {
    assert.equal(result.status, 'MATCH');
    assert.equal(result.matches.length, 1);
    assert.deepEqual(result.locationDiagnostics.requested, ['Dubai Silicon Oasis', 'Warsan']);
    assert.equal(result.locationDiagnostics.partial, false);
  });
});

test('multi-area: partial resolution still matches against the resolved subset, keeping the unresolved option in diagnostics', () => {
  const request = baseRequest({ area: null, bedrooms_min: 2, bedrooms_max: 2, budget_max: 2500000 });
  const resolution = {
    ...fullResolution,
    areaOptions: [
      { raw: 'DSO', canonical: 'Dubai Silicon Oasis', resolved: true },
      { raw: 'Bur Dubai', canonical: null, resolved: false },
    ],
  };
  return runMatch(request, [makeStock({ area: 'Dubai Silicon Oasis', project_community: 'Dubai Silicon Oasis' })], resolution).then((result) => {
    assert.equal(result.status, 'MATCH');
    assert.deepEqual(result.locationDiagnostics.resolved, ['Dubai Silicon Oasis']);
    assert.deepEqual(result.locationDiagnostics.unresolved, ['Bur Dubai']);
    assert.equal(result.locationDiagnostics.partial, true);
  });
});

test('multi-area: partial resolution with zero stock in the resolved subset -> partial_location_resolution_no_match (distinct from a full no-stock verdict)', () => {
  const request = baseRequest({ area: null, bedrooms_min: 2, bedrooms_max: 2, budget_max: 2500000 });
  const resolution = {
    ...fullResolution,
    areaOptions: [
      { raw: 'DSO', canonical: 'Dubai Silicon Oasis', resolved: true },
      { raw: 'Bur Dubai', canonical: null, resolved: false },
    ],
  };
  return runMatch(request, [makeStock({ area: 'Some Other Area', project_community: 'Some Other Area' })], resolution).then((result) => {
    assert.equal(result.status, 'NO_MATCH');
    assert.equal(result.noMatchReason, 'partial_location_resolution_no_match');
  });
});

test('multi-area: every named option unresolved but one exists literally in stock -> proceeds on raw names, never on a broader pool', () => {
  const request = baseRequest({ area: null, bedrooms_min: 2, bedrooms_max: 2, budget_max: 2500000 });
  const resolution = {
    ...fullResolution,
    areaOptions: [
      { raw: 'Jabal Ali Village', canonical: null, resolved: false },
      { raw: 'Nad Al Sheba Gardens', canonical: null, resolved: false },
    ],
  };
  return runMatch(request, [makeStock({ area: 'Jabal Ali Village', project_community: 'Jabal Ali Village' })], resolution).then((result) => {
    assert.equal(result.status, 'MATCH');
  });
});

test('multi-area: every named option unresolved AND none exists in stock at all -> NO_MATCH location_not_found', () => {
  const request = baseRequest({ area: null, bedrooms_min: 2, bedrooms_max: 2, budget_max: 2500000 });
  const resolution = {
    ...fullResolution,
    areaOptions: [
      { raw: 'Tilal Al Furjan', canonical: null, resolved: false },
      { raw: 'Jabal Ali Village', canonical: null, resolved: false },
      { raw: 'Nad Al Sheba Gardens', canonical: null, resolved: false },
    ],
  };
  return runMatch(request, [makeStock({ area: 'Completely Unrelated Area' })], resolution).then((result) => {
    assert.equal(result.status, 'NO_MATCH');
    assert.equal(result.noMatchReason, 'location_not_found');
  });
});
