'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagnosticsFunnelQuery, buildRequestDiagnostics, buildMatchDiagnostics } = require('../../src/matching/diagnostics');

const CONFIG = { matchPriceTolerancePct: 10 };

function baseRequest(overrides = {}) {
  return {
    transaction_type: null,
    area: null,
    areas: [],
    project: null,
    building: null,
    property_type: null,
    bedrooms_min: null,
    bedrooms_max: null,
    budget_min: null,
    budget_max: null,
    bathrooms_min: null,
    bathrooms_max: null,
    size_sqft_min: null,
    size_sqft_max: null,
    plot_size_sqft_min: null,
    plot_size_sqft_max: null,
    furnishing: null,
    ...overrides,
  };
}

test('buildDiagnosticsFunnelQuery: RENT request scopes on annual_rent, never selling_price (shares transaction-semantics.js with the matcher)', () => {
  const { sql, params } = buildDiagnosticsFunnelQuery({
    structuredRequest: baseRequest({ transaction_type: 'RENT', budget_max: 150000 }),
    locationLevel: 'area',
    locationValues: ['Warsan'],
    config: CONFIG,
  });
  assert.match(sql, /transaction_type = \$\d+/);
  assert.ok(params.includes('RENT_YEARLY'));
  assert.match(sql, /annual_rent <= \$\d+/);
  assert.doesNotMatch(sql, /selling_price/);
});

test('buildDiagnosticsFunnelQuery: multi-area OR semantics match candidate-query.js', () => {
  const { sql, params } = buildDiagnosticsFunnelQuery({
    structuredRequest: baseRequest(),
    locationLevel: 'area',
    locationValues: ['Dubai Silicon Oasis', 'Warsan'],
    config: CONFIG,
  });
  assert.match(sql, /lower\(area\) = ANY\(ARRAY\[/);
  assert.ok(params.includes('Dubai Silicon Oasis'));
  assert.ok(params.includes('Warsan'));
});

test('buildDiagnosticsFunnelQuery: an unstated stage is a no-op -- its column mirrors the previous stage, no condition added', () => {
  const { sql } = buildDiagnosticsFunnelQuery({
    structuredRequest: baseRequest({ property_type: 'Apartment' }),
    locationLevel: 'area',
    locationValues: ['Business Bay'],
    config: CONFIG,
  });
  // bedrooms/budget/etc never stated -> no bedrooms/selling_price condition anywhere in the query.
  assert.doesNotMatch(sql, /\bbedrooms\b/);
  assert.doesNotMatch(sql, /selling_price/);
  assert.match(sql, /property_type/);
});

test('buildDiagnosticsFunnelQuery: data-gap columns are only added for a field the request actually constrains', () => {
  const { sql } = buildDiagnosticsFunnelQuery({
    structuredRequest: baseRequest({ furnishing: 'Furnished' }),
    locationLevel: 'area',
    locationValues: ['Business Bay'],
    config: CONFIG,
  });
  assert.match(sql, /furnishing_missing_value/);
  assert.match(sql, /furnishing_explicit_mismatch/);
  assert.doesNotMatch(sql, /bedrooms_missing_value/);
});

test('buildRequestDiagnostics: a genuine buyer missing all three matching-eligible fields is flagged correctly', () => {
  const result = buildRequestDiagnostics(baseRequest({ areas: ['Business Bay'] }));
  assert.ok(result.provided_fields.includes('area'));
  assert.deepEqual(result.missing_required_fields, ['budget', 'bedrooms', 'property_type']);
});

test('buildRequestDiagnostics: providing bedrooms removes it from missing_required_fields', () => {
  const result = buildRequestDiagnostics(baseRequest({ areas: ['Business Bay'], bedrooms_min: 2, bedrooms_max: 2 }));
  assert.deepEqual(result.missing_required_fields, ['budget', 'property_type']);
});

test('buildMatchDiagnostics: no funnel is run when nothing resolved (location_not_found path) -- stock stays a minimal shape', async () => {
  let called = false;
  const result = await buildMatchDiagnostics({
    structuredRequest: baseRequest({ areas: ['Nowhereville'] }),
    matchOutcome: { locationDiagnostics: { level: 'area', requested: ['Nowhereville'], resolved: [], unresolved: ['Nowhereville'], partial: false } },
    activeStockCount: 94,
    config: CONFIG,
    runFunnelQuery: async () => { called = true; return []; },
  });
  assert.equal(called, false);
  assert.equal(result.stock.active, 94);
  assert.equal(result.stock.after_transaction, null);
  assert.equal(result.first_zero_stage, null);
});

test('buildMatchDiagnostics: runs the funnel exactly once when a location resolved, and reports first_zero_stage/first_data_gap_stage', async () => {
  let callCount = 0;
  const result = await buildMatchDiagnostics({
    structuredRequest: baseRequest({ areas: ['Business Bay'], furnishing: 'Furnished' }),
    matchOutcome: { locationDiagnostics: { level: 'area', requested: ['Business Bay'], resolved: ['Business Bay'], unresolved: [], partial: false } },
    activeStockCount: 94,
    config: CONFIG,
    runFunnelQuery: async () => {
      callCount += 1;
      return [{ after_location: 5, after_transaction: 5, after_property_type: 5, after_bedrooms: 5, after_budget: 5, after_bathrooms: 5, after_size: 5, after_plot_size: 5, after_furnishing: 0, furnishing_candidates_before: 5, furnishing_missing_value: 5, furnishing_explicit_mismatch: 0 }];
    },
  });
  assert.equal(callCount, 1);
  assert.equal(result.stock.active, 94); // citywide ACTIVE count, passed through as-is
  assert.equal(result.stock.after_location, 5); // location-scoped funnel start
  assert.equal(result.stock.after_furnishing, 0);
  assert.equal(result.first_zero_stage, 'furnishing');
  assert.equal(result.first_data_gap_stage, 'furnishing');
  assert.deepEqual(result.missing_stock_data.furnishing, { field: 'furnishing', candidate_rows_before: 5, missing_value_rows: 5, explicit_mismatch_rows: 0 });
});

test('buildMatchDiagnostics: an explicit mismatch (not missing data) never gets flagged as a data gap', async () => {
  const result = await buildMatchDiagnostics({
    structuredRequest: baseRequest({ areas: ['Business Bay'], furnishing: 'Furnished' }),
    matchOutcome: { locationDiagnostics: { level: 'area', requested: ['Business Bay'], resolved: ['Business Bay'], unresolved: [], partial: false } },
    activeStockCount: 94,
    config: CONFIG,
    runFunnelQuery: async () => [{ after_location: 3, after_transaction: 3, after_property_type: 3, after_bedrooms: 3, after_budget: 3, after_bathrooms: 3, after_size: 3, after_plot_size: 3, after_furnishing: 0, furnishing_candidates_before: 3, furnishing_missing_value: 0, furnishing_explicit_mismatch: 3 }],
  });
  assert.equal(result.missing_stock_data.furnishing.missing_value_rows, 0);
  assert.equal(result.missing_stock_data.furnishing.explicit_mismatch_rows, 3);
  // first_data_gap_stage requires missing_value_rows > 0 -- a confirmed
  // mismatch is a real result, never disguised as a data gap.
  assert.equal(result.first_data_gap_stage, null);
});
