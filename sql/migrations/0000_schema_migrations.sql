-- All pilot objects live in a dedicated `matching` schema — never `public`,
-- which is owned by the production monitoring system (devi_messages lives
-- there and this pilot only ever needs SELECT on it).
--
-- NOTE: `CREATE SCHEMA IF NOT EXISTS` checks database-level CREATE privilege
-- BEFORE checking whether the schema already exists, so it fails with
-- "permission denied for database ..." for a role that only holds CREATE on
-- the (already-provisioned) `matching` schema itself — exactly this pilot's
-- real deployment role. Checking pg_namespace first avoids ever attempting
-- CREATE SCHEMA when it isn't actually needed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'matching') THEN
    EXECUTE 'CREATE SCHEMA matching';
  END IF;
END $$;

-- Tracks which pilot migrations have been applied. Idempotent: safe to run
-- against a database that already has this table.
CREATE TABLE IF NOT EXISTS matching.schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
