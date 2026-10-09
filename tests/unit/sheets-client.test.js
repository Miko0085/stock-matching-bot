'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadServiceAccountCredentials, readSheetRows } = require('../../src/google-sheets/sheets-client');

test('loadServiceAccountCredentials: inline JSON (starts with "{") is parsed directly', () => {
  const creds = loadServiceAccountCredentials('{"client_email": "x@y.iam.gserviceaccount.com", "private_key": "k"}');
  assert.equal(creds.client_email, 'x@y.iam.gserviceaccount.com');
});

test('loadServiceAccountCredentials: a non-JSON string is treated as a file path and read', () => {
  const tmpFile = path.join(os.tmpdir(), `sa-test-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ client_email: 'file@y.iam.gserviceaccount.com' }));
  try {
    const creds = loadServiceAccountCredentials(tmpFile);
    assert.equal(creds.client_email, 'file@y.iam.gserviceaccount.com');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('loadServiceAccountCredentials: throws a clear error when nothing is configured', () => {
  assert.throws(() => loadServiceAccountCredentials(undefined), /GOOGLE_SERVICE_ACCOUNT_JSON is not set/);
  assert.throws(() => loadServiceAccountCredentials(''), /GOOGLE_SERVICE_ACCOUNT_JSON is not set/);
});

function fakeSheetsApi(values) {
  return { spreadsheets: { values: { get: async () => ({ data: { values } }) } } };
}

test('readSheetRows: maps header row onto every data row, key-by-key', async () => {
  const sheets = fakeSheetsApi([
    ['stock_id', 'status', 'area'],
    ['A-1', 'live', 'Al Reem Island'],
    ['A-2', 'pocket', 'Saadiyat Island'],
  ]);
  const rows = await readSheetRows(sheets, { spreadsheetId: 'x', tabName: 'Stock Inventory' });
  assert.deepEqual(rows, [
    { stock_id: 'A-1', status: 'live', area: 'Al Reem Island' },
    { stock_id: 'A-2', status: 'pocket', area: 'Saadiyat Island' },
  ]);
});

test('readSheetRows: a short row (trailing blank cells trimmed by Sheets) still gets every header key, as empty string', () => {
  const sheets = fakeSheetsApi([
    ['stock_id', 'status', 'notes'],
    ['A-1', 'live'],
  ]);
  return readSheetRows(sheets, { spreadsheetId: 'x', tabName: 'Stock Inventory' }).then((rows) => {
    assert.deepEqual(rows, [{ stock_id: 'A-1', status: 'live', notes: '' }]);
  });
});

test('readSheetRows: an empty sheet (no header row at all) returns an empty array, never throws', async () => {
  const sheets = fakeSheetsApi(undefined);
  const rows = await readSheetRows(sheets, { spreadsheetId: 'x', tabName: 'Stock Inventory' });
  assert.deepEqual(rows, []);
});
