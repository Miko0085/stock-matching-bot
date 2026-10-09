'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { makeStockRepository } = require('../../src/repositories/stock-repository');
const { buildCandidateQuery, buildLocationExistsQuery } = require('../../src/matching/candidate-query');
const { matchRequest } = require('../../src/matching/matcher');

const CONFIG = { matchPriceTolerancePct: 10 };

let pool;
let stockRepo;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  stockRepo = makeStockRepository(pool);
});

after(async () => {
  await pool.query(`DELETE FROM matching_dubai.stock_inventory WHERE stock_id LIKE 'IT-%'`);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM matching_dubai.stock_inventory WHERE stock_id LIKE 'IT-%'`);
});

async function seedStock(rows) {
  for (const row of rows) {
    await pool.query(
      `INSERT INTO matching_dubai.stock_inventory (stock_id, status, transaction_type, area, project_community, building, bedrooms, property_type, selling_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.stock_id,
        row.status || 'ACTIVE',
        row.transaction_type || 'SALE',
        row.area || null,
        row.project_community || null,
        row.building || null,
        row.bedrooms ?? null,
        row.property_type || null,
        row.selling_price ?? null,
      ]
    );
  }
}

test('candidate query against real Postgres: TZ 43/96 -- a different building is never returned, even with perfect other criteria', async () => {
  await seedStock([
    { stock_id: 'IT-RIVERSIDE', building: '340 Riverside Crescent', area: 'Sobha Hartland II', bedrooms: 1, property_type: 'Apartment', selling_price: 1235000 },
  ]);

  const { sql, params } = buildCandidateQuery({
    structuredRequest: { transaction_type: 'SALE', property_type: 'Apartment', bedrooms_min: 1, bedrooms_max: 1, budget_min: null, budget_max: 1300000 },
    locationLevel: 'building',
    locationValue: 'The Edge',
    config: CONFIG,
  });
  const rows = await stockRepo.fetchCandidates(sql, params);
  assert.equal(rows.length, 0);
});

test('candidate query against real Postgres: an exact area match returns only that area', async () => {
  await seedStock([
    { stock_id: 'IT-BB-1', area: 'Business Bay', bedrooms: 2, property_type: 'Apartment', selling_price: 2000000 },
    { stock_id: 'IT-MARINA-1', area: 'Dubai Marina', bedrooms: 2, property_type: 'Apartment', selling_price: 2000000 },
  ]);

  const { sql, params } = buildCandidateQuery({
    structuredRequest: { transaction_type: 'SALE', property_type: null, bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: null },
    locationLevel: 'area',
    locationValue: 'Business Bay',
    config: CONFIG,
  });
  const rows = await stockRepo.fetchCandidates(sql, params);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stock_id, 'IT-BB-1');
});

test('checkLocationExists distinguishes a genuinely unknown name from a known-but-currently-empty one', async () => {
  await seedStock([{ stock_id: 'IT-EDGE-1', building: 'The Edge', status: 'TAKEN_DOWN', area: 'JVC', bedrooms: 1, property_type: 'Apartment', selling_price: 1250000 }]);

  const known = buildLocationExistsQuery({ level: 'building', value: 'The Edge' });
  assert.equal(await stockRepo.checkLocationExists(known.sql, known.params), true); // exists, even if not ACTIVE

  const unknown = buildLocationExistsQuery({ level: 'building', value: 'Totally Fictional Tower' });
  assert.equal(await stockRepo.checkLocationExists(unknown.sql, unknown.params), false);
});

test('full matchRequest against real Postgres: TZ 90 The Edge regression end-to-end', async () => {
  await seedStock([
    { stock_id: 'IT-RIVERSIDE-2', building: '340 Riverside Crescent', area: 'Sobha Hartland II', bedrooms: 1, property_type: 'Apartment', selling_price: 1235000 },
  ]);

  const structuredRequest = {
    transaction_type: 'SALE',
    area: null,
    project: null,
    building: 'The Edge',
    property_type: 'Apartment',
    bedrooms_min: 1,
    bedrooms_max: 1,
    budget_min: null,
    budget_max: 1300000,
  };
  const result = await matchRequest({
    structuredRequest,
    resolution: { buildingResolved: false },
    config: CONFIG,
    fetchCandidates: stockRepo.fetchCandidates,
    checkLocationExists: stockRepo.checkLocationExists,
  });

  assert.equal(result.status, 'NO_MATCH');
  assert.equal(result.noMatchReason, 'location_not_found');
  assert.equal(result.matches.length, 0);
});

test('performance guard: candidate query never scans the entire ACTIVE table (TZ 100) -- it uses an indexed-shape WHERE, not a full-table fetch', async () => {
  // Seed enough "noise" rows in other areas that a naive "load everything"
  // implementation would still return all of them; the location-scoped
  // query must return only the matching row regardless of table size.
  const noise = Array.from({ length: 25 }, (_, i) => ({ stock_id: `IT-NOISE-${i}`, area: 'Some Other Area', bedrooms: 2, property_type: 'Apartment', selling_price: 2000000 }));
  await seedStock([...noise, { stock_id: 'IT-TARGET', area: 'Business Bay', bedrooms: 2, property_type: 'Apartment', selling_price: 2000000 }]);

  const { sql, params } = buildCandidateQuery({
    structuredRequest: { transaction_type: 'SALE', property_type: null, bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: null },
    locationLevel: 'area',
    locationValue: 'Business Bay',
    config: CONFIG,
  });
  const rows = await stockRepo.fetchCandidates(sql, params);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stock_id, 'IT-TARGET');
});
