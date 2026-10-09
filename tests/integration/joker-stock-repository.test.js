'use strict';

// Integration tests for src/joker/joker-stock-repository.js against a real
// disposable Postgres (migrations 0025/0026). Covers upsert/deactivation/
// sync-run bookkeeping for the 4 Joker-fed market schemas, and the hard
// isolation guarantee: this sync path must NEVER touch matching.*  (UAE).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getPool, ensureMigrated } = require('./helpers/setup');
const repo = require('../../src/joker/joker-stock-repository');
const { mapJokerObjectToStockRow } = require('../../src/joker/joker-stock-mapper');
const { MARKET_SCHEMAS } = require('../../src/joker/joker-market-router');

let pool;

before(async () => {
  pool = getPool();
  await ensureMigrated();
});

after(async () => {
  for (const schema of Object.values(MARKET_SCHEMAS)) {
    await pool.query(`DELETE FROM ${schema}.stock_inventory`);
    await pool.query(`DELETE FROM ${schema}.stock_sync_runs`);
  }
});

beforeEach(async () => {
  for (const schema of Object.values(MARKET_SCHEMAS)) {
    await pool.query(`DELETE FROM ${schema}.stock_inventory`);
    await pool.query(`DELETE FROM ${schema}.stock_sync_runs`);
  }
});

function fakeObject(id, overrides = {}) {
  return {
    id,
    url: `https://moscow.nikaestate.ru/catalog/sale/vtorichka/object/${id}`,
    type: 'Квартиры - вторичное жильё',
    deal_type: 'sale',
    region: 'Москва',
    city: 'Москва',
    district: 'Тверской',
    microdistrict: null,
    price: '100000000',
    development: null,
    complex: null,
    agent: { id: 1, name: 'Test Agent', phone: '+70000000000', email: 't@example.com' },
    params: { rooms: { value: '3' }, area: { value: '100 м²' } },
    ...overrides,
  };
}

test('upsertStockRow: first call inserts, second call with the same joker_object_id updates in place', async () => {
  const row1 = mapJokerObjectToStockRow(fakeObject(90001));
  const first = await repo.upsertStockRow(pool, 'matching_moscow', row1);
  assert.equal(first.inserted, true);

  const row2 = mapJokerObjectToStockRow(fakeObject(90001, { price: '999999999' }));
  const second = await repo.upsertStockRow(pool, 'matching_moscow', row2);
  assert.equal(second.inserted, false);
  assert.equal(second.id, first.id);

  const { rows } = await pool.query('SELECT price FROM matching_moscow.stock_inventory WHERE joker_object_id = $1', [90001]);
  assert.equal(Number(rows[0].price), 999999999);
});

test('upsertStockRow: normalized fields (district, complex, rooms, area) land correctly in the real table', async () => {
  const obj = fakeObject(90002, { district: 'Одинцовский р-н', complex: 'ЖК «Событие»' });
  const row = mapJokerObjectToStockRow(obj);
  await repo.upsertStockRow(pool, 'matching_moscow', row);

  const { rows } = await pool.query('SELECT district, complex, rooms, area_sqm FROM matching_moscow.stock_inventory WHERE joker_object_id = $1', [90002]);
  assert.equal(rows[0].district, 'Одинцовский');
  assert.equal(rows[0].complex, 'Событие');
  assert.equal(rows[0].rooms, 3);
  assert.equal(Number(rows[0].area_sqm), 100);
});

test('markMissingUnavailable: a previously-upserted row not in the new seen-ids list is marked unavailable, never deleted', async () => {
  await repo.upsertStockRow(pool, 'matching_moscow', mapJokerObjectToStockRow(fakeObject(90003)));
  const marked = await repo.markMissingUnavailable(pool, 'matching_moscow', [999999]); // 90003 not in this list
  assert.equal(marked, 1);
  const { rows } = await pool.query('SELECT available FROM matching_moscow.stock_inventory WHERE joker_object_id = $1', [90003]);
  assert.equal(rows.length, 1, 'the row still exists -- never deleted');
  assert.equal(rows[0].available, false);
});

test('markMissingUnavailable: a row whose id IS in the seen list stays available', async () => {
  await repo.upsertStockRow(pool, 'matching_moscow', mapJokerObjectToStockRow(fakeObject(90004)));
  await repo.markMissingUnavailable(pool, 'matching_moscow', [90004]);
  const { rows } = await pool.query('SELECT available FROM matching_moscow.stock_inventory WHERE joker_object_id = $1', [90004]);
  assert.equal(rows[0].available, true);
});

test('sync run bookkeeping: start/complete/fail all persist correctly, per market schema', async () => {
  const runId = await repo.startSyncRun(pool, 'matching_turkey');
  await repo.completeSyncRun(pool, 'matching_turkey', runId, { objectsSeen: 5, objectsUpserted: 5, objectsMarkedUnavailable: 0 });
  const { rows } = await pool.query('SELECT * FROM matching_turkey.stock_sync_runs WHERE id = $1', [runId]);
  assert.equal(rows[0].status, 'SUCCESS');
  assert.equal(rows[0].objects_seen, 5);

  const failRunId = await repo.startSyncRun(pool, 'matching_oman');
  await repo.failSyncRun(pool, 'matching_oman', failRunId, new Error('boom'));
  const { rows: failRows } = await pool.query('SELECT * FROM matching_oman.stock_sync_runs WHERE id = $1', [failRunId]);
  assert.equal(failRows[0].status, 'FAILED');
  assert.match(failRows[0].error, /boom/);
});

test('assertValidSchema: refuses any schema not in the Joker market allow-list -- never interpolates arbitrary input into SQL', async () => {
  await assert.rejects(
    () => repo.upsertStockRow(pool, 'matching; DROP TABLE matching_dubai.stock_inventory; --', mapJokerObjectToStockRow(fakeObject(90005))),
    /not in the Joker market allow-list/
  );
  await assert.rejects(() => repo.upsertStockRow(pool, 'matching_dubai', mapJokerObjectToStockRow(fakeObject(90006))), /not in the Joker market allow-list/);
});

test('ISOLATION: writing to every Joker-fed market schema never touches matching_dubai.stock_inventory (UAE)', async () => {
  const { rows: before1 } = await pool.query('SELECT count(*)::int AS c FROM matching_dubai.stock_inventory');

  for (const schema of Object.values(MARKET_SCHEMAS)) {
    await repo.upsertStockRow(pool, schema, mapJokerObjectToStockRow(fakeObject(90100 + Object.values(MARKET_SCHEMAS).indexOf(schema))));
  }

  const { rows: after1 } = await pool.query('SELECT count(*)::int AS c FROM matching_dubai.stock_inventory');
  assert.equal(after1[0].c, before1[0].c, 'matching_dubai.stock_inventory (UAE) row count must be unchanged');
});
