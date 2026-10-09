-- Removes the 5 UAE-copied "5-dimension matching" settings from
-- matching_moscow.runtime_settings (2026-09-29):
-- transaction_matching_enabled, bedrooms_matching_enabled,
-- property_type_matching_enabled, budget_matching_enabled,
-- budget_tolerance_pct.
--
-- Migration 0029 seeded these by literally copying UAE's default values
-- (docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md section 5.5: "reuse UAE's
-- current default values as the starting point"). Once the Settings UI
-- put them on the same page as the real, finalized Joker criteria table
-- (11 fields, section 5.1.1), the user pointed out this was confusing
-- duplication, and worse -- actively wrong: "Сопоставление по спальням"
-- implies bedrooms is the one relevant field, but Moscow's real,
-- finalized model treats комнаты (rooms) and спальни (bedrooms) as two
-- DISTINCT fields (see AI_PARSER_DECISION's own reasoning in
-- dashboard/moscow-settings-reference.js). The user's decision: replace
-- section 9 ("Сопоставление") entirely with the real Joker criteria table
-- and delete the UAE-inherited placeholder settings, rather than keep
-- both a wrong generic model and the correct specific one side by side.
--
-- Idempotent: a DELETE conditioned on data state is naturally a no-op on
-- re-run once the rows are already gone -- no guard needed, same as any
-- plain DELETE-based cleanup migration.
DO $$
DECLARE
  v_id BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM matching_moscow.runtime_settings
    WHERE key IN ('transaction_matching_enabled', 'bedrooms_matching_enabled', 'property_type_matching_enabled', 'budget_matching_enabled', 'budget_tolerance_pct')
  ) THEN
    DELETE FROM matching_moscow.runtime_settings
    WHERE key IN ('transaction_matching_enabled', 'bedrooms_matching_enabled', 'property_type_matching_enabled', 'budget_matching_enabled', 'budget_tolerance_pct');

    -- Re-stamp the whole active config to a new version, same pattern as
    -- migration 0023's own re-stamp-on-write behavior -- every
    -- runtime_settings/intake_rules row shares one config_version_id at
    -- any given time, so removing 5 settings correctly means "the whole
    -- active state moved to version N+1," not leaving some rows pointed
    -- at a version whose snapshot no longer matches reality.
    INSERT INTO matching_moscow.config_versions (version_number, snapshot, note, created_by)
    SELECT
      coalesce(max(version_number), 0) + 1,
      '{"phase": 1, "description": "Removed the 5 UAE-copied matching toggles (transaction/bedrooms/property_type/budget_matching_enabled, budget_tolerance_pct) -- they conflicted with Moscow real field model (комнаты vs спальни) and duplicated the Joker criteria reference table. Section 9 now shows only the Joker criteria table."}'::jsonb,
      'migration 0030: remove UAE-style matching toggles for Moscow',
      'migration:0030_moscow_matching_section_cleanup'
    FROM matching_moscow.config_versions
    RETURNING id INTO v_id;

    UPDATE matching_moscow.runtime_settings SET config_version_id = v_id;
    UPDATE matching_moscow.intake_rules SET config_version_id = v_id;

    UPDATE matching_moscow.config_versions
    SET snapshot = jsonb_build_object(
      'schema_version', 1,
      'config_version', (SELECT version_number FROM matching_moscow.config_versions WHERE id = v_id),
      'runtime_settings', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'key', key, 'value_type', value_type, 'value_text', value_text, 'enabled', enabled
        ) ORDER BY key), '[]'::jsonb)
        FROM matching_moscow.runtime_settings WHERE config_version_id = v_id
      ),
      'intake_rules', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'rule_group', rule_group, 'match_type', match_type, 'pattern', pattern,
          'enabled', enabled, 'priority', priority, 'description', description
        ) ORDER BY rule_group, priority, id), '[]'::jsonb)
        FROM matching_moscow.intake_rules WHERE config_version_id = v_id
      )
    )
    WHERE id = v_id;

    -- The singleton draft (if it already existed) still has the OLD
    -- settings array with the now-removed keys -- delete it so
    -- getOrInitDraft() rebuilds it fresh from the real (now-cleaned)
    -- table on next access, exactly as discardDraft() would produce.
    DELETE FROM matching_moscow.config_draft WHERE id = 1;
  END IF;
END $$;
