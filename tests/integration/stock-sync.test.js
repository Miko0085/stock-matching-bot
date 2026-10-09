'use strict';

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getPool, ensureMigrated, truncateAll } = require('./helpers/setup');
const { upsertStockRows, fetchActiveStock } = require('../../src/db/stockRepository');
const { upsertAliasRows, fetchEnabledAliases } = require('../../src/db/aliasRepository');
const { startRun, completeRun, getLatestSuccessfulSync } = require('../../src/db/stockSyncRepository');
const { validateStockRow, validateAliasRow } = require('../../src/core/sync-normalize');

before(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
});

function stockRow(overrides) {
  return validateStockRow({
    stock_id: 'STK-1',
    status: 'live',
    transaction_type: 'SALE',
    area: 'Business Bay',
    building: 'Peninsula Four',
    bedrooms: 2,
    property_type: 'Apartment',
    selling_price: 2500000,
    ...overrides,
  }).value;
}

test('stock upsert inserts a new row', async () => {
  const pool = getPool();
  await upsertStockRows(pool, [stockRow()]);
  const { rows } = await pool.query('SELECT * FROM matching_dubai.stock_inventory WHERE stock_id = $1', ['STK-1']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ACTIVE');
});

test('re-syncing the same stock_id upserts instead of duplicating', async () => {
  const pool = getPool();
  await upsertStockRows(pool, [stockRow({ selling_price: 2500000 })]);
  await upsertStockRows(pool, [stockRow({ selling_price: 2600000 })]);
  const { rows } = await pool.query('SELECT * FROM matching_dubai.stock_inventory WHERE stock_id = $1', ['STK-1']);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].selling_price), 2600000);
});

test('stock_source defaults to GOOGLE_SHEETS when a row does not set it, and a different value (e.g. POCKET_LISTING) is persisted and survives a re-sync', async () => {
  const pool = getPool();
  await upsertStockRows(pool, [stockRow()]);
  const { rows: defaulted } = await pool.query('SELECT stock_source FROM matching_dubai.stock_inventory WHERE stock_id = $1', ['STK-1']);
  assert.equal(defaulted[0].stock_source, 'GOOGLE_SHEETS');

  await upsertStockRows(pool, [{ ...stockRow({ stock_id: 'STK-POCKET' }), stock_source: 'POCKET_LISTING' }]);
  const { rows: tagged } = await pool.query('SELECT stock_source FROM matching_dubai.stock_inventory WHERE stock_id = $1', ['STK-POCKET']);
  assert.equal(tagged[0].stock_source, 'POCKET_LISTING');
});

test('only ACTIVE SALE stock enters the default candidate set', async () => {
  const pool = getPool();
  await upsertStockRows(pool, [
    stockRow({ stock_id: 'ACTIVE-SALE', status: 'live', transaction_type: 'SALE' }),
    stockRow({ stock_id: 'ACTIVE-RENT', status: 'live', transaction_type: 'RENT' }),
    stockRow({ stock_id: 'TAKEN-DOWN', status: 'takendown', transaction_type: 'SALE' }),
  ]);
  const active = await fetchActiveStock(pool, { transactionTypes: ['SALE'] });
  assert.equal(active.length, 1);
  assert.equal(active[0].stock_id, 'ACTIVE-SALE');
});

test('malformed stock row with no stock_id is rejected before reaching the database', () => {
  const { value, errors } = validateStockRow({ status: 'live' });
  assert.equal(value, null);
  assert.ok(errors.includes('missing_stock_id'));
});

test('alias upsert works and enforces UNIQUE(type, alias_normalized)', async () => {
  const pool = getPool();
  const rowA = validateAliasRow({ type: 'area', alias: 'BB', canonical: 'Business Bay' }).value;
  const rowB = validateAliasRow({ type: 'area', alias: 'bb', canonical: 'Business Bay (updated)' }).value;
  await upsertAliasRows(pool, [rowA]);
  await upsertAliasRows(pool, [rowB]);
  const aliases = await fetchEnabledAliases(pool);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].canonical, 'Business Bay (updated)');
});

test('stock_sync_runs records start/completion status', async () => {
  const pool = getPool();
  const run = await startRun(pool);
  await completeRun(pool, run.id, {
    status: 'SUCCESS',
    stockRowsRead: 10,
    stockRowsActive: 8,
    aliasRowsRead: 5,
  });
  const { rows } = await pool.query('SELECT * FROM matching_dubai.stock_sync_runs WHERE id = $1', [run.id]);
  assert.equal(rows[0].status, 'SUCCESS');
  assert.equal(rows[0].stock_rows_active, 8);

  const latest = await getLatestSuccessfulSync(pool);
  assert.ok(latest);
});

test('a failed sync run is recorded with its error and does not block subsequent runs', async () => {
  const pool = getPool();
  const run = await startRun(pool);
  await completeRun(pool, run.id, {
    status: 'FAILED',
    stockRowsRead: 0,
    stockRowsActive: 0,
    aliasRowsRead: 0,
    error: 'Google Sheets API timeout',
  });
  const { rows } = await pool.query('SELECT * FROM matching_dubai.stock_sync_runs WHERE id = $1', [run.id]);
  assert.equal(rows[0].status, 'FAILED');
  assert.equal(rows[0].error, 'Google Sheets API timeout');
});
