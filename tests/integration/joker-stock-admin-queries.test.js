'use strict';

// Write-side /stock queries for the four Joker-fed markets (2026-10-07,
// "all regions" request -- extends the Dubai/Abu Dhabi editor to Moscow/
// Oman/Saudi/Turkey). Covers at least two of the four writable schemas to
// prove the allow-list genuinely spans more than one, same discipline as
// the Dubai/Abu Dhabi integration tests.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getPool, ensureMigrated } = require('./helpers/setup');
const jokerStockAdmin = require('../../dashboard/joker-stock-admin-queries');

before(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  const pool = getPool();
  for (const schema of ['matching_moscow', 'matching_oman']) {
    await pool.query(`DELETE FROM ${schema}.stock_inventory WHERE joker_object_id BETWEEN 900000 AND 999999`);
  }
});

async function insertJokerStock(pool, schema, jokerObjectId, overrides = {}) {
  const s = { include_in_matching: true, price: 1000000, district: 'Пресненский', ...overrides };
  await pool.query(
    `INSERT INTO ${schema}.stock_inventory (joker_object_id, include_in_matching, price, district)
     VALUES ($1, $2, $3, $4)`,
    [jokerObjectId, s.include_in_matching, s.price, s.district]
  );
}

test('assertValidSchema (via public functions): a non-allow-listed schema is rejected, never interpolated into a query string', async () => {
  const pool = getPool();
  await assert.rejects(() => jokerStockAdmin.updateIncludeInMatching(pool, { schema: 'matching_dubai', jokerObjectId: 1, includeInMatching: true }));
  await assert.rejects(() => jokerStockAdmin.getStockRow(pool, { schema: 'not_a_real_schema; DROP TABLE matching_moscow.stock_inventory; --', jokerObjectId: 1 }));
});

test('updateIncludeInMatching: toggles the flag by joker_object_id', async () => {
  const pool = getPool();
  await insertJokerStock(pool, 'matching_moscow', 900001, { include_in_matching: true });

  const result = await jokerStockAdmin.updateIncludeInMatching(pool, { schema: 'matching_moscow', jokerObjectId: 900001, includeInMatching: false });
  assert.equal(result.ok, true);

  const row = await jokerStockAdmin.getStockRow(pool, { schema: 'matching_moscow', jokerObjectId: 900001 });
  assert.equal(row.include_in_matching, false);
});

test('updateIncludeInMatching: an unknown joker_object_id is rejected', async () => {
  const pool = getPool();
  const result = await jokerStockAdmin.updateIncludeInMatching(pool, { schema: 'matching_moscow', jokerObjectId: 999999, includeInMatching: true });
  assert.equal(result.ok, false);
});

test('updateIncludeInMatching: works against matching_oman too', async () => {
  const pool = getPool();
  await insertJokerStock(pool, 'matching_oman', 900002, { include_in_matching: true });
  const result = await jokerStockAdmin.updateIncludeInMatching(pool, { schema: 'matching_oman', jokerObjectId: 900002, includeInMatching: false });
  assert.equal(result.ok, true);
  const row = await jokerStockAdmin.getStockRow(pool, { schema: 'matching_oman', jokerObjectId: 900002 });
  assert.equal(row.include_in_matching, false);
});

test('updateStockFields: updates several fields, leaves unmentioned columns (including `available`, which is sync-owned) untouched', async () => {
  const pool = getPool();
  await insertJokerStock(pool, 'matching_moscow', 900003, { district: 'Пресненский', price: 1000000 });
  const result = await jokerStockAdmin.updateStockFields(pool, {
    schema: 'matching_moscow',
    jokerObjectId: 900003,
    fields: { district: 'Хамовники', price: '1250000' },
  });
  assert.equal(result.ok, true);
  const row = await jokerStockAdmin.getStockRow(pool, { schema: 'matching_moscow', jokerObjectId: 900003 });
  assert.equal(row.district, 'Хамовники');
  assert.equal(Number(row.price), 1250000);
  assert.equal(row.available, true, 'available is sync-owned and must never be touched by this editor');
});

test('updateStockFields: coerces a currency-formatted numeric input the same way the sync pipeline does', async () => {
  const pool = getPool();
  await insertJokerStock(pool, 'matching_moscow', 900004);
  const result = await jokerStockAdmin.updateStockFields(pool, {
    schema: 'matching_moscow',
    jokerObjectId: 900004,
    fields: { price: '1 250 000 ₽' },
  });
  assert.equal(result.ok, true);
  const row = await jokerStockAdmin.getStockRow(pool, { schema: 'matching_moscow', jokerObjectId: 900004 });
  assert.equal(Number(row.price), 1250000);
});

test('updateStockFields: an out-of-range readiness_quarter (real CHECK constraint, 1-4) is rejected as a friendly error, never a raw 500', async () => {
  const pool = getPool();
  await insertJokerStock(pool, 'matching_moscow', 900005);
  const result = await jokerStockAdmin.updateStockFields(pool, {
    schema: 'matching_moscow',
    jokerObjectId: 900005,
    fields: { readiness_quarter: '7' },
  });
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.length > 0);
});

test('updateStockFields: stock_id/joker_url/available/raw_payload/synced_at keys in submitted fields are silently ignored -- never editable through this path', async () => {
  const pool = getPool();
  await insertJokerStock(pool, 'matching_moscow', 900006);
  const result = await jokerStockAdmin.updateStockFields(pool, {
    schema: 'matching_moscow',
    jokerObjectId: 900006,
    fields: { joker_url: 'https://evil.example', available: 'false', district: 'Арбат' },
  });
  assert.equal(result.ok, true);
  const row = await jokerStockAdmin.getStockRow(pool, { schema: 'matching_moscow', jokerObjectId: 900006 });
  assert.equal(row.available, true);
  assert.notEqual(row.joker_url, 'https://evil.example');
  assert.equal(row.district, 'Арбат');
});

test('updateStockFields: an unknown joker_object_id is rejected', async () => {
  const pool = getPool();
  const result = await jokerStockAdmin.updateStockFields(pool, {
    schema: 'matching_moscow',
    jokerObjectId: 999998,
    fields: { district: 'Арбат' },
  });
  assert.equal(result.ok, false);
});

test('updateStockFields: no recognized fields submitted is rejected rather than issuing a no-op UPDATE', async () => {
  const pool = getPool();
  await insertJokerStock(pool, 'matching_moscow', 900007);
  const result = await jokerStockAdmin.updateStockFields(pool, { schema: 'matching_moscow', jokerObjectId: 900007, fields: {} });
  assert.equal(result.ok, false);
});
