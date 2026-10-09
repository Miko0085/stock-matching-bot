-- Renames matching_uae -> matching_dubai, mirroring migration 0027's exact
-- rename mechanics (matching -> matching_uae). Part of the same 2026-10-05
-- Dubai rename as migration 0034 (route_mode='UAE' -> 'DUBAI'): a second,
-- distinct UAE-country market (Abu Dhabi) is coming, so "UAE" can no
-- longer mean one undifferentiated bucket -- it has to name the city
-- actually served today.
--
-- Guarded so this is a safe no-op if the rename already happened or if a
-- fresh database somehow starts past this point.
--
-- IMPORTANT: this migration must only ever be applied to production in the
-- same coordinated step as restarting dubai-lead-matching-service and the
-- dashboard with code that already references matching_dubai -- see
-- docs/DECISIONS.md's ADR-034 for why (an earlier ad-hoc, code-uncoordinated
-- version of the matching->matching_uae rename broke live production for
-- several minutes). The exact same risk applies here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'matching_uae')
     AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'matching_dubai') THEN
    EXECUTE 'ALTER SCHEMA matching_uae RENAME TO matching_dubai';
  END IF;
END $$;
