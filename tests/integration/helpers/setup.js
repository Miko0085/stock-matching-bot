'use strict';

const { Pool } = require('pg');
const { runMigrations } = require('../../../src/db/migrate');

let pool;
let migrated = false;

function getPool() {
  if (!pool) {
    const connectionString = process.env.TEST_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'TEST_DATABASE_URL is not set. Integration tests require a disposable PostgreSQL ' +
        'instance — run them via `npm run test:integration`, which manages one automatically.'
      );
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

async function ensureMigrated() {
  if (migrated) return;
  await runMigrations(getPool());
  migrated = true;
}

async function truncateAll() {
  const client = await getPool().connect();
  try {
    // Pilot-owned tables only, all in the `matching` schema. devi_messages
    // (in `public`, owned by production) is never touched.
    await client.query(
      'TRUNCATE matching_dubai.match_results, matching_dubai.match_runs, matching_dubai.stock_sync_runs, matching_dubai.matching_aliases, matching_dubai.stock_inventory RESTART IDENTITY CASCADE'
    );
  } finally {
    client.release();
  }
}

module.exports = { getPool, ensureMigrated, truncateAll };
