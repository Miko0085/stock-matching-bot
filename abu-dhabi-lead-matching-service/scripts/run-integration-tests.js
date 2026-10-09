#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { runMigrations } = require('../../src/db/migrate');
const { startDisposablePostgres, stopDisposablePostgres } = require('../../scripts/lib/docker-postgres');

async function main() {
  const preConfigured = Boolean(process.env.TEST_DATABASE_URL);
  let container = null;
  let connectionString = process.env.TEST_DATABASE_URL;

  if (!preConfigured) {
    console.log('[abu dhabi test:integration] Starting disposable PostgreSQL container...');
    container = await startDisposablePostgres();
    connectionString = container.connectionString;
  } else {
    console.log('[abu dhabi test:integration] Using TEST_DATABASE_URL from environment.');
  }

  let exitCode = 1;
  try {
    const pool = new Pool({ connectionString });
    console.log('[abu dhabi test:integration] Applying migrations...');
    const { appliedNow } = await runMigrations(pool);
    console.log(`[abu dhabi test:integration] Applied ${appliedNow.length} migration(s).`);
    await pool.end();

    const result = spawnSync(
      process.execPath,
      ['--test', '--test-concurrency=1', 'tests/integration/**/*.test.js'],
      { stdio: 'inherit', cwd: __dirname + '/..', env: { ...process.env, TEST_DATABASE_URL: connectionString } }
    );
    exitCode = result.status === null ? 1 : result.status;
  } finally {
    if (container) {
      console.log('[abu dhabi test:integration] Tearing down disposable PostgreSQL container...');
      stopDisposablePostgres(container.containerName);
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[abu dhabi test:integration] Failed:', err);
  process.exit(1);
});
