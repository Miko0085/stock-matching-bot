#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { runMigrations } = require('../src/db/migrate');
const { startDisposablePostgres, stopDisposablePostgres } = require('./lib/docker-postgres');

// Integration tests always run against a disposable PostgreSQL instance —
// never a shared/dev/production database. If TEST_DATABASE_URL is already
// set (e.g. in CI with its own postgres service) we use it as-is and skip
// managing a container ourselves.
async function main() {
  const preConfigured = Boolean(process.env.TEST_DATABASE_URL);
  let container = null;
  let connectionString = process.env.TEST_DATABASE_URL;

  if (!preConfigured) {
    console.log('[test:integration] Starting disposable PostgreSQL container...');
    container = await startDisposablePostgres();
    connectionString = container.connectionString;
    console.log(`[test:integration] Disposable database ready at ${connectionString}`);
  } else {
    console.log(`[test:integration] Using TEST_DATABASE_URL from environment.`);
  }

  let exitCode = 1;
  try {
    const pool = new Pool({ connectionString });
    console.log('[test:integration] Applying migrations...');
    const { appliedNow } = await runMigrations(pool);
    console.log(`[test:integration] Applied ${appliedNow.length} migration(s): ${appliedNow.join(', ') || '(none, already up to date)'}`);
    await pool.end();

    // Integration test files all share the one disposable database, so they
    // must not run concurrently against it (node:test runs separate files in
    // parallel workers by default, which would race truncateAll() in one
    // file against inserts/reads in another).
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-concurrency=1', 'tests/integration/**/*.test.js'],
      {
        stdio: 'inherit',
        env: { ...process.env, TEST_DATABASE_URL: connectionString },
      }
    );
    exitCode = result.status === null ? 1 : result.status;
  } finally {
    if (container) {
      console.log('[test:integration] Tearing down disposable PostgreSQL container...');
      stopDisposablePostgres(container.containerName);
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[test:integration] Failed:', err);
  process.exit(1);
});
