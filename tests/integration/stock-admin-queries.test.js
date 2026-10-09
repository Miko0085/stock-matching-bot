'use strict';

// Write-side /stock queries (2026-10-07): the inline status dropdown and
// the pencil-icon full-field edit form both go through
// dashboard/stock-admin-queries.js, which issues real UPDATEs -- covered
// here against a disposable Postgres, same discipline as every other
// mutation in this project. Covers both hasMatchCounts schemas
// (matching_dubai, matching_abu_dhabi) since both are writable.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getPool, ensureMigrated, truncateAll } = require('./helpers/setup');
const stockAdmin = require('../../dashboard/stock-admin-queries');

before(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
  await getPool().query(`DELETE FROM matching_abu_dhabi.stock_inventory WHERE stock_id LIKE 'AD-STK-%'`);
});

async function insertStock(pool, schema, overrides = {}) {
  const s = {
    stock_id: 'STK-1', status: 'ACTIVE', transaction_type: 'SALE', area: 'Business Bay',
    building: 'Peninsula Four', bedrooms: 2, property_type: 'Apartment', selling_price: 2500000,
    ...overrides,
  };
  await pool.query(
    `INSERT INTO ${schema}.stock_inventory (stock_id, status, transaction_type, area, building, bedrooms, property_type, selling_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [s.stock_id, s.status, s.transaction_type, s.area, s.building, s.bedrooms, s.property_type, s.selling_price]
  );
}

test('assertValidSchema (via public functions): a non-allow-listed schema is rejected, never interpolated into a query string', async () => {
  const pool = getPool();
  await assert.rejects(() => stockAdmin.updateStockStatus(pool, { schema: 'matching_moscow', stockId: 'STK-1', status: 'ACTIVE' }));
  await assert.rejects(() => stockAdmin.getStockRow(pool, { schema: 'not_a_real_schema; DROP TABLE matching_dubai.stock_inventory; --', stockId: 'STK-1' }));
});

test('updateStockStatus: updates the row and bumps synced_at', async () => {
  const pool = getPool();
  await insertStock(pool, 'matching_dubai', { stock_id: 'STK-1', status: 'NEEDS_REVIEW' });
  const before = await stockAdmin.getStockRow(pool, { schema: 'matching_dubai', stockId: 'STK-1' });

  const result = await stockAdmin.updateStockStatus(pool, { schema: 'matching_dubai', stockId: 'STK-1', status: 'ACTIVE' });
  assert.equal(result.ok, true);

  const after = await stockAdmin.getStockRow(pool, { schema: 'matching_dubai', stockId: 'STK-1' });
  assert.equal(after.status, 'ACTIVE');
  assert.ok(new Date(after.synced_at) >= new Date(before.synced_at));
});

test('updateStockStatus: an empty status is rejected, the row is left untouched', async () => {
  const pool = getPool();
  await insertStock(pool, 'matching_dubai', { stock_id: 'STK-1', status: 'ACTIVE' });
  const result = await stockAdmin.updateStockStatus(pool, { schema: 'matching_dubai', stockId: 'STK-1', status: '  ' });
  assert.equal(result.ok, false);
  const row = await stockAdmin.getStockRow(pool, { schema: 'matching_dubai', stockId: 'STK-1' });
  assert.equal(row.status, 'ACTIVE');
});

test('updateStockStatus: an unknown stock_id is rejected, never silently a no-op success', async () => {
  const pool = getPool();
  const result = await stockAdmin.updateStockStatus(pool, { schema: 'matching_dubai', stockId: 'DOES-NOT-EXIST', status: 'ACTIVE' });
  assert.equal(result.ok, false);
  assert.match(result.error, /не найден/);
});

test('updateStockStatus: works against matching_abu_dhabi too', async () => {
  const pool = getPool();
  await insertStock(pool, 'matching_abu_dhabi', { stock_id: 'AD-STK-1', status: 'NEEDS_REVIEW' });
  const result = await stockAdmin.updateStockStatus(pool, { schema: 'matching_abu_dhabi', stockId: 'AD-STK-1', status: 'ACTIVE' });
  assert.equal(result.ok, true);
  const row = await stockAdmin.getStockRow(pool, { schema: 'matching_abu_dhabi', stockId: 'AD-STK-1' });
  assert.equal(row.status, 'ACTIVE');
});

test('updateStockFields: updates several fields at once, leaves unmentioned columns untouched', async () => {
  const pool = getPool();
  await insertStock(pool, 'matching_dubai', { stock_id: 'STK-1', area: 'Business Bay', building: 'Peninsula Four', selling_price: 2500000 });
  const result = await stockAdmin.updateStockFields(pool, {
    schema: 'matching_dubai',
    stockId: 'STK-1',
    fields: { area: 'JVC', selling_price: '2750000' },
  });
  assert.equal(result.ok, true);
  const row = await stockAdmin.getStockRow(pool, { schema: 'matching_dubai', stockId: 'STK-1' });
  assert.equal(row.area, 'JVC');
  assert.equal(Number(row.selling_price), 2750000);
  assert.equal(row.building, 'Peninsula Four', 'building was never submitted and must stay as-is');
});

test('updateStockFields: coerces a currency-formatted numeric input the same way the sync pipeline does', async () => {
  const pool = getPool();
  await insertStock(pool, 'matching_dubai', { stock_id: 'STK-1' });
  const result = await stockAdmin.updateStockFields(pool, {
    schema: 'matching_dubai',
    stockId: 'STK-1',
    fields: { selling_price: '2,750,000 AED' },
  });
  assert.equal(result.ok, true);
  const row = await stockAdmin.getStockRow(pool, { schema: 'matching_dubai', stockId: 'STK-1' });
  assert.equal(Number(row.selling_price), 2750000);
});

test('updateStockFields: an empty numeric field is coerced to NULL (clearing it), not left as the literal empty string', async () => {
  const pool = getPool();
  await insertStock(pool, 'matching_dubai', { stock_id: 'STK-1', selling_price: 2500000 });
  const result = await stockAdmin.updateStockFields(pool, {
    schema: 'matching_dubai',
    stockId: 'STK-1',
    fields: { selling_price: '' },
  });
  assert.equal(result.ok, true);
  const row = await stockAdmin.getStockRow(pool, { schema: 'matching_dubai', stockId: 'STK-1' });
  assert.equal(row.selling_price, null);
});

test('updateStockFields: an empty status is rejected -- NOT NULL column, never silently written as NULL or empty string', async () => {
  const pool = getPool();
  await insertStock(pool, 'matching_dubai', { stock_id: 'STK-1', status: 'ACTIVE' });
  const result = await stockAdmin.updateStockFields(pool, {
    schema: 'matching_dubai',
    stockId: 'STK-1',
    fields: { status: '' },
  });
  assert.equal(result.ok, false);
  const row = await stockAdmin.getStockRow(pool, { schema: 'matching_dubai', stockId: 'STK-1' });
  assert.equal(row.status, 'ACTIVE', 'status must be unchanged after a rejected update');
});

test('updateStockFields: an empty transaction_type is rejected -- NOT NULL column', async () => {
  const pool = getPool();
  await insertStock(pool, 'matching_dubai', { stock_id: 'STK-1', transaction_type: 'SALE' });
  const result = await stockAdmin.updateStockFields(pool, {
    schema: 'matching_dubai',
    stockId: 'STK-1',
    fields: { transaction_type: '' },
  });
  assert.equal(result.ok, false);
  const row = await stockAdmin.getStockRow(pool, { schema: 'matching_dubai', stockId: 'STK-1' });
  assert.equal(row.transaction_type, 'SALE');
});

test('updateStockFields: a stock_id, synced_at, or stock_source key in the submitted fields is silently ignored -- never editable through this path', async () => {
  const pool = getPool();
  await insertStock(pool, 'matching_dubai', { stock_id: 'STK-1' });
  const before = await stockAdmin.getStockRow(pool, { schema: 'matching_dubai', stockId: 'STK-1' });
  const result = await stockAdmin.updateStockFields(pool, {
    schema: 'matching_dubai',
    stockId: 'STK-1',
    fields: { stock_id: 'HACKED-ID', stock_source: 'SOMETHING_ELSE', area: 'JVC' },
  });
  assert.equal(result.ok, true);
  const after = await stockAdmin.getStockRow(pool, { schema: 'matching_dubai', stockId: 'STK-1' });
  assert.equal(after.stock_id, 'STK-1');
  assert.equal(after.stock_source, before.stock_source);
  assert.equal(after.area, 'JVC');
});

test('updateStockFields: an unknown stock_id is rejected', async () => {
  const pool = getPool();
  const result = await stockAdmin.updateStockFields(pool, {
    schema: 'matching_dubai',
    stockId: 'DOES-NOT-EXIST',
    fields: { area: 'JVC' },
  });
  assert.equal(result.ok, false);
});

test('updateStockFields: no recognized fields submitted is rejected rather than issuing a no-op UPDATE', async () => {
  const pool = getPool();
  await insertStock(pool, 'matching_dubai', { stock_id: 'STK-1' });
  const result = await stockAdmin.updateStockFields(pool, {
    schema: 'matching_dubai',
    stockId: 'STK-1',
    fields: {},
  });
  assert.equal(result.ok, false);
});

test('updateStockFields: works against matching_abu_dhabi too', async () => {
  const pool = getPool();
  await insertStock(pool, 'matching_abu_dhabi', { stock_id: 'AD-STK-1', area: 'Al Reem Island' });
  const result = await stockAdmin.updateStockFields(pool, {
    schema: 'matching_abu_dhabi',
    stockId: 'AD-STK-1',
    fields: { area: 'Saadiyat Island' },
  });
  assert.equal(result.ok, true);
  const row = await stockAdmin.getStockRow(pool, { schema: 'matching_abu_dhabi', stockId: 'AD-STK-1' });
  assert.equal(row.area, 'Saadiyat Island');
});
