-- Renames the two original schemas to match the market-labeled naming
-- convention introduced alongside matching_oman/matching_saudi/matching_turkey
-- (migrations 0025/0026): matching -> matching_uae, matching_rf -> matching_russia.
--
-- Guarded so this is a safe no-op if the rename already happened (e.g. a
-- fresh database created after this migration already gets matching_uae/
-- matching_russia at migrations 0001/0018 time... no, it doesn't -- 0001/0018
-- still create schemas literally named `matching`/`matching_rf`, and THIS
-- migration renames them afterward, same end state either way, applied
-- fresh or applied to an already-running database).
--
-- IMPORTANT: this migration must only ever be applied to production in the
-- same coordinated step as restarting lead-matching-service and the
-- dashboard with code that already references the new names -- see
-- docs/DECISIONS.md's ADR for 2026-09-28 for why (an earlier ad-hoc,
-- code-uncoordinated version of this exact rename broke live production
-- for several minutes).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'matching')
     AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'matching_uae') THEN
    EXECUTE 'ALTER SCHEMA matching RENAME TO matching_uae';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'matching_rf')
     AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'matching_russia') THEN
    EXECUTE 'ALTER SCHEMA matching_rf RENAME TO matching_russia';
  END IF;
END $$;
