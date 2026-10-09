'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readXlsxRows } = require('../../src/core/xlsx-reader');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'xlsx', 'sample-pocket-stock.xlsx');

// The fixture (tests/fixtures/xlsx/sample-pocket-stock.xlsx, generated via
// Python's stdlib zipfile) deliberately reproduces the real-world quirks
// that broke this reader during development against an actual Google-
// Sheets-exported .xlsx: namespace-prefixed OOXML tags (<x:row>/<x:c>),
// a shared-string cell, an inline-string cell, a self-closing BLANK cell
// in the middle of a row (the actual bug: without a non-greedy cell regex,
// a blank cell silently swallowed the next real cell and shifted every
// later column left by one), a shared-string Cyrillic value, and an XML
// entity (&amp;) in an inline string.
test('readXlsxRows: a blank (self-closing) cell never shifts later columns in the same row', async () => {
  const rows = await readXlsxRows(FIXTURE);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { stock_id: 'TEST-1', city: 'Dubai', bedrooms: '', broker: 'Дима Довгей Nika' });
});

test('readXlsxRows: a row with no trailing cells fills missing header columns with empty string, never a missing key', async () => {
  const rows = await readXlsxRows(FIXTURE);
  assert.deepEqual(rows[1], { stock_id: 'TEST-2 & Co', city: 'Abu Dhabi', bedrooms: '3', broker: '' });
});

test('readXlsxRows: shared-string table correctly resolves Cyrillic text', async () => {
  const rows = await readXlsxRows(FIXTURE);
  assert.equal(rows[0].broker, 'Дима Довгей Nika');
});

test('readXlsxRows: XML entities in inline-string cells are decoded', async () => {
  const rows = await readXlsxRows(FIXTURE);
  assert.equal(rows[1].stock_id, 'TEST-2 & Co');
});

test('readXlsxRows: a header-keyed row object has a key for every header column, matching readSheetRows\' contract', async () => {
  const rows = await readXlsxRows(FIXTURE);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['bedrooms', 'broker', 'city', 'stock_id']);
  }
});
