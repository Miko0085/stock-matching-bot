'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'sql', 'migrations');

// Resolves which schema currently holds schema_migrations: matching_dubai
// if it exists (post-2026-10-05 rename), else matching_uae (post-2026-09-28
// rename), else legacy matching. Must be re-checked after EVERY migration's
// DDL runs, not just once up front -- migrations 0027/0035 rename this very
// schema mid-run, and Postgres DDL is visible to subsequent queries in the
// same transaction, so re-querying pg_namespace right after executing
// 0027's/0035's SQL (still inside its BEGIN/COMMIT) sees the new name
// already, not the just-renamed-away old one.
async function resolveBookkeepingSchema(client) {
  const { rows } = await client.query(
    `SELECT nspname FROM pg_namespace WHERE nspname IN ('matching_dubai', 'matching_uae', 'matching')`
  );
  const names = rows.map((r) => r.nspname);
  if (names.includes('matching_dubai')) return 'matching_dubai';
  if (names.includes('matching_uae')) return 'matching_uae';
  return 'matching';
}

// Idempotent migration runner: each .sql file is itself written to be safe
// to re-run, and this runner additionally tracks applied filenames in
// schema_migrations so normal operation only applies what's new.
async function runMigrations(pool, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  // Same fix/reasoning as dubai-lead-matching-service/src/repositories/
  // config-repository.js's 2026-10-06 incident comment: a client checked
  // out via pool.connect() is its own EventEmitter -- pool.js's own
  // `pool.on('error', ...)` only covers an idle client still sitting in
  // the pool. Lower exposure here (migrations run once at startup/on
  // demand, not per-request), but the same unhandled-throw-kills-the-
  // process risk exists for the duration this client is held.
  function onClientError(err) {
    console.error('[migrate] checked-out client connection error (migration run will fail safely via catch below):', err.message);
  }
  client.on('error', onClientError);
  const appliedNow = [];
  try {
    // Bookkeeping schema resolution (2026-09-28, migration 0027's schema
    // rename matching->matching_uae; 2026-10-05, migration 0035's further
    // rename matching_uae->matching_dubai): `schema_migrations` lives INSIDE
    // that schema, so `ALTER SCHEMA ... RENAME` already carries its full
    // history along automatically -- no separate migration of this table is
    // ever needed. The one thing that must NOT happen: after a real rename,
    // blindly re-creating a brand-new EMPTY `matching` schema here (the old
    // hardcoded behavior) would silently fork bookkeeping from the renamed
    // schema and cause every historical migration to look "not yet
    // applied," re-running destructively. So: prefer `matching_dubai` if it
    // exists, else `matching_uae`, else legacy `matching` (pre-rename
    // installs, or a database mid-migration before 0027/0035 has run); only
    // create a fresh `matching` schema when NONE exist yet (a genuinely
    // new database, where 0001+ still populate `matching` under its
    // original name exactly as those files were written, and 0027/0035
    // rename it later -- same end state either way).
    //
    // NOTE: `CREATE SCHEMA IF NOT EXISTS` in PostgreSQL checks database-level
    // CREATE privilege *before* checking whether the schema already exists,
    // so it fails with "permission denied for database" for a role that
    // only has CREATE on the (already-provisioned) schema itself — exactly
    // this pilot's real deployment role. Checking pg_namespace first (a
    // plain, always-readable catalog) avoids ever attempting CREATE SCHEMA
    // when it isn't needed.
    const bookkeepingSchemaAtStart = await resolveBookkeepingSchema(client);
    const { rows: nsRows } = await client.query(
      `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
      [bookkeepingSchemaAtStart]
    );
    if (nsRows.length === 0) {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '${bookkeepingSchemaAtStart}') THEN
            EXECUTE 'CREATE SCHEMA ${bookkeepingSchemaAtStart}';
          END IF;
        END $$;
      `);
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${bookkeepingSchemaAtStart}.schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query(`SELECT filename FROM ${bookkeepingSchemaAtStart}.schema_migrations`);
    const applied = new Set(rows.map((r) => r.filename));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        // Re-resolve after running this file's DDL, not before: migrations
        // 0027/0035 rename the bookkeeping schema itself mid-transaction,
        // and the rename is visible to this same transaction immediately.
        const bookkeepingSchemaNow = await resolveBookkeepingSchema(client);
        await client.query(`INSERT INTO ${bookkeepingSchemaNow}.schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [file]);
        await client.query('COMMIT');
        appliedNow.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }

    return { appliedNow, totalFiles: files.length };
  } finally {
    client.removeListener('error', onClientError);
    client.release();
  }
}

module.exports = { runMigrations, DEFAULT_MIGRATIONS_DIR };
