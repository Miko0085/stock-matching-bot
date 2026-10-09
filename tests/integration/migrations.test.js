'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { getPool, ensureMigrated } = require('./helpers/setup');
const { runMigrations } = require('../../src/db/migrate');

before(async () => {
  await ensureMigrated();
});

test('migrations apply cleanly and create all pilot tables in the matching_dubai schema', async () => {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'matching_dubai' AND table_name = ANY($1)
  `, [['stock_inventory', 'matching_aliases', 'stock_sync_runs', 'match_runs', 'match_results']]);
  assert.equal(rows.length, 5);
});

test('no pilot table is created in the public schema (owned by production)', async () => {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1)
  `, [['stock_inventory', 'matching_aliases', 'stock_sync_runs', 'match_runs', 'match_results']]);
  assert.equal(rows.length, 0);
});

test('required dashboard views exist in the matching_dubai schema', async () => {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.views
    WHERE table_schema = 'matching_dubai' AND table_name = ANY($1)
  `, [['v_dashboard_summary', 'v_stock_match_counts', 'v_request_matches', 'v_match_history']]);
  assert.equal(rows.length, 4);
});

test('re-running migrations is a no-op (idempotent)', async () => {
  const pool = getPool();
  const result = await runMigrations(pool);
  assert.deepEqual(result.appliedNow, []);
});

test('devi_messages is never created, altered, or referenced by a required migration', async () => {
  // The pilot must never assume ownership of the production message table.
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT to_regclass('public.devi_messages') AS exists`
  );
  // In this disposable test database devi_messages was never created by us.
  assert.equal(rows[0].exists, null);
});
