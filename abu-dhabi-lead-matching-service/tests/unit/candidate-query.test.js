'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidateQuery, buildLocationExistsQuery } = require('../../src/matching/candidate-query');

const CONFIG = { matchPriceTolerancePct: 10 };

function baseRequest(overrides = {}) {
  return {
    transaction_type: null,
    property_type: null,
    budget_min: null,
    budget_max: null,
    bedrooms_min: null,
    bedrooms_max: null,
    ...overrides,
  };
}

test('always filters status = ACTIVE', () => {
  const { sql } = buildCandidateQuery({ structuredRequest: baseRequest(), locationLevel: null, locationValue: null, config: CONFIG });
  assert.match(sql, /status = 'ACTIVE'/);
});

test('TZ 43/96: building level filters on building only -- never area/project_community', () => {
  const { sql, params } = buildCandidateQuery({
    structuredRequest: baseRequest(),
    locationLevel: 'building',
    locationValue: 'The Edge',
    config: CONFIG,
  });
  assert.match(sql, /lower\(building\) = lower\(\$\d+\)/);
  assert.doesNotMatch(sql, /project_community/);
  assert.doesNotMatch(sql, /\barea\b/);
  assert.ok(params.includes('The Edge'));
});

test('project level filters on project_community', () => {
  const { sql, params } = buildCandidateQuery({
    structuredRequest: baseRequest(),
    locationLevel: 'project',
    locationValue: 'Emaar Beachfront',
    config: CONFIG,
  });
  assert.match(sql, /lower\(project_community\) = lower\(\$\d+\)/);
  assert.ok(params.includes('Emaar Beachfront'));
});

test('area level filters on area', () => {
  const { sql, params } = buildCandidateQuery({
    structuredRequest: baseRequest(),
    locationLevel: 'area',
    locationValue: 'Business Bay',
    config: CONFIG,
  });
  assert.match(sql, /lower\(area\) = lower\(\$\d+\)/);
  assert.ok(params.includes('Business Bay'));
});

test('budget_max is pushed with the 10% tolerance applied', () => {
  const { sql, params } = buildCandidateQuery({
    structuredRequest: baseRequest({ budget_max: 2500000 }),
    locationLevel: null,
    locationValue: null,
    config: CONFIG,
  });
  assert.match(sql, /selling_price <= \$\d+/);
  assert.ok(params.includes(2750000));
});

test('budget_min is pushed WITHOUT tolerance (TZ 50-51 strict floor)', () => {
  const { sql, params } = buildCandidateQuery({
    structuredRequest: baseRequest({ budget_min: 2000000 }),
    locationLevel: null,
    locationValue: null,
    config: CONFIG,
  });
  assert.match(sql, /selling_price >= \$\d+/);
  assert.ok(params.includes(2000000));
  assert.ok(!params.includes(1800000));
});

test('bedrooms_min/max are pushed as a BETWEEN-shaped range', () => {
  const { sql, params } = buildCandidateQuery({
    structuredRequest: baseRequest({ bedrooms_min: 2, bedrooms_max: 3 }),
    locationLevel: null,
    locationValue: null,
    config: CONFIG,
  });
  assert.match(sql, /bedrooms >= \$\d+/);
  assert.match(sql, /bedrooms <= \$\d+/);
  assert.ok(params.includes(2));
  assert.ok(params.includes(3));
});

// P0 release blocker regression (spec section 4): SQL layer must map a
// RENT request onto the real RENT_YEARLY stock vocabulary and the
// annual_rent price column -- must never diverge from hard-filters.js.
test('TZ P0: a RENT request filters on transaction_type = RENT_YEARLY, not the literal request value', () => {
  const { sql, params } = buildCandidateQuery({
    structuredRequest: baseRequest({ transaction_type: 'RENT' }),
    locationLevel: null,
    locationValue: null,
    config: CONFIG,
  });
  assert.match(sql, /transaction_type = \$\d+/);
  assert.ok(params.includes('RENT_YEARLY'));
  assert.ok(!params.includes('RENT'));
});

test('TZ P0: a SALE request still filters on transaction_type = SALE', () => {
  const { sql, params } = buildCandidateQuery({
    structuredRequest: baseRequest({ transaction_type: 'SALE' }),
    locationLevel: null,
    locationValue: null,
    config: CONFIG,
  });
  assert.match(sql, /transaction_type = \$\d+/);
  assert.ok(params.includes('SALE'));
});

test('TZ P0: a RENT request with a budget compares against annual_rent, never selling_price', () => {
  const { sql, params } = buildCandidateQuery({
    structuredRequest: baseRequest({ transaction_type: 'RENT', budget_max: 150000 }),
    locationLevel: null,
    locationValue: null,
    config: CONFIG,
  });
  assert.match(sql, /annual_rent <= \$\d+/);
  assert.doesNotMatch(sql, /selling_price/);
  assert.ok(params.includes(165000)); // 150000 * 1.10 tolerance
});

test('TZ P0: a SALE request with a budget still compares against selling_price, never annual_rent', () => {
  const { sql, params } = buildCandidateQuery({
    structuredRequest: baseRequest({ transaction_type: 'SALE', budget_max: 2000000 }),
    locationLevel: null,
    locationValue: null,
    config: CONFIG,
  });
  assert.match(sql, /selling_price <= \$\d+/);
  assert.doesNotMatch(sql, /annual_rent/);
});

test('an unstated criterion adds no condition and no param at all', () => {
  const { sql, params } = buildCandidateQuery({ structuredRequest: baseRequest(), locationLevel: null, locationValue: null, config: CONFIG });
  assert.doesNotMatch(sql, /selling_price/);
  assert.doesNotMatch(sql, /bedrooms/);
  assert.doesNotMatch(sql, /property_type/);
  assert.equal(params.length, 0);
});

test('buildLocationExistsQuery maps project level to the project_community column', () => {
  const { sql, params } = buildLocationExistsQuery({ level: 'project', value: 'Emaar Beachfront' });
  assert.match(sql, /project_community/);
  assert.deepEqual(params, ['Emaar Beachfront']);
});

test('buildLocationExistsQuery ignores status/transaction_type/price -- a pure name-existence check', () => {
  const { sql } = buildLocationExistsQuery({ level: 'building', value: 'The Edge' });
  assert.doesNotMatch(sql, /status/);
  assert.doesNotMatch(sql, /transaction_type/);
});
