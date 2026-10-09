'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeStockStatus,
  coerceNumeric,
  coerceDate,
  validateStockRow,
  dedupeStockRows,
  validateAliasRow,
  dedupeAliasRows,
} = require('../../src/core/sync-normalize');

test('live and pocket map to ACTIVE', () => {
  assert.equal(normalizeStockStatus('live'), 'ACTIVE');
  assert.equal(normalizeStockStatus('Pocket'), 'ACTIVE');
});

test('takendown statuses are excluded from ACTIVE runtime matching', () => {
  assert.equal(normalizeStockStatus('takendown'), 'TAKENDOWN');
  assert.equal(normalizeStockStatus('takendown_validation_failed'), 'TAKENDOWN_VALIDATION_FAILED');
  assert.notEqual(normalizeStockStatus('takendown'), 'ACTIVE');
});

test('a stock row with no stock_id is rejected', () => {
  const { value, errors } = validateStockRow({ status: 'live', area: 'Business Bay' });
  assert.equal(value, null);
  assert.ok(errors.includes('missing_stock_id'));
});

test('a valid stock row normalizes status and numeric fields', () => {
  const { value, errors } = validateStockRow({
    stock_id: 'STK-1',
    status: 'live',
    transaction_type: 'sale',
    selling_price: '2,500,000',
    bedrooms: 'Studio',
  });
  assert.deepEqual(errors, []);
  assert.equal(value.status, 'ACTIVE');
  assert.equal(value.transaction_type, 'SALE');
  assert.equal(value.selling_price, 2500000);
  assert.equal(value.bedrooms, 0);
  assert.equal(value.bedrooms_label, 'Studio');
});

test('duplicate stock_id within one sync batch is handled deterministically (last wins)', () => {
  const { rows, duplicates } = dedupeStockRows([
    { stock_id: 'STK-1', area: 'Old' },
    { stock_id: 'STK-1', area: 'New' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].area, 'New');
  assert.deepEqual(duplicates, ['STK-1']);
});

test('an alias row missing a required field is rejected', () => {
  const { value, errors } = validateAliasRow({ type: 'area', alias: 'BB' });
  assert.equal(value, null);
  assert.ok(errors.includes('missing_required_field'));
});

test('a valid alias row is normalized', () => {
  const { value, errors } = validateAliasRow({
    type: 'area',
    alias: 'BB',
    canonical: 'Business Bay',
  });
  assert.deepEqual(errors, []);
  assert.equal(value.alias_normalized, 'bb');
  assert.equal(value.canonical_normalized, 'businessbay');
  assert.equal(value.enabled, true);
});

// Real incident, 2026-10-06: syncing actual Abu Dhabi stock from Google
// Sheets, every priced row's selling_price/annual_rent silently became
// null -- the API's FORMATTED_VALUE render returns currency cells as
// display strings like "8 100 000 AED", and the old comma/whitespace-only
// strip left "8100000AED", which Number() rejects outright.
test('coerceNumeric: strips a currency suffix and thousands-separator spaces (Google Sheets FORMATTED_VALUE)', () => {
  assert.equal(coerceNumeric('8 100 000 AED'), 8100000);
  assert.equal(coerceNumeric('199 000 AED'), 199000);
  assert.equal(coerceNumeric('2,500,000'), 2500000);
});

test('coerceNumeric: a value that is not a number at all (not just currency-suffixed) still safely becomes null', () => {
  assert.equal(coerceNumeric('N/A'), null);
  assert.equal(coerceNumeric('TBD'), null);
});

test('a stock row with a currency-formatted price is parsed correctly end to end', () => {
  const { value } = validateStockRow({ stock_id: 'STK-2', status: 'ACTIVE', selling_price: '8 100 000 AED', size_sqft: '1,243' });
  assert.equal(value.selling_price, 8100000);
  assert.equal(value.size_sqft, 1243);
});

// Real incident, 2026-10-06: an export tool left the literal word "export"
// in the source_updated_at column for every row (the real date had shifted
// into an unrelated extra column) -- inserting that string into a
// TIMESTAMPTZ column would throw and abort the whole batch.
test('coerceDate: a literal non-date string becomes null, never reaches the DB as unparseable text', () => {
  assert.equal(coerceDate('export'), null);
  assert.equal(coerceDate('TBD'), null);
});

test('coerceDate: a real date string passes through unchanged', () => {
  assert.equal(coerceDate('2026-09-22'), '2026-09-22');
});

test('coerceDate: empty/missing is null, not a crash', () => {
  assert.equal(coerceDate(''), null);
  assert.equal(coerceDate(null), null);
  assert.equal(coerceDate(undefined), null);
});

test('a stock row with a malformed source_updated_at is accepted with that field nulled, not rejected outright', () => {
  const { value, errors } = validateStockRow({ stock_id: 'STK-3', status: 'ACTIVE', source_updated_at: 'export' });
  assert.deepEqual(errors, []);
  assert.equal(value.source_updated_at, null);
});

test('duplicate normalized alias within one batch is handled deterministically (last wins)', () => {
  const rowA = validateAliasRow({ type: 'area', alias: 'BB', canonical: 'Business Bay' }).value;
  const rowB = validateAliasRow({ type: 'area', alias: 'B.B', canonical: 'Business Bay 2' }).value;
  const { rows, duplicates } = dedupeAliasRows([rowA, rowB]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].canonical, 'Business Bay 2');
  assert.equal(duplicates.length, 1);
});
