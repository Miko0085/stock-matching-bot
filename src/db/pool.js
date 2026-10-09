'use strict';

const { Pool } = require('pg');

// pg emits 'error' on the Pool whenever an IDLE client's underlying
// connection drops (a normal, expected event over any network path that
// isn't a raw local socket -- an SSH tunnel hiccup, a NAT/firewall idle
// timeout, a brief DB-side restart). pg's own docs require handling this:
// without a listener, Node treats it as an unhandled EventEmitter 'error'
// and throws, killing the whole process. Confirmed live (2026-09-29):
// exactly this ("Connection terminated unexpectedly") crashed
// lead-matching-service in production. pg already discards the broken
// client and opens a fresh one on the next query -- there is nothing to
// recover here beyond not crashing, so a log line is enough.
function attachErrorHandler(pool) {
  pool.on('error', (err) => {
    console.error('[pg.Pool] idle client connection error (pool continues, no action needed):', err.message);
  });
  return pool;
}

function createPool(env = process.env) {
  const connectionString = env.DATABASE_URL || env.TEST_DATABASE_URL;
  if (connectionString) {
    return attachErrorHandler(new Pool({ connectionString }));
  }
  return attachErrorHandler(new Pool({
    host: env.POSTGRES_HOST,
    port: Number(env.POSTGRES_PORT) || 5432,
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
  }));
}

module.exports = { createPool };
