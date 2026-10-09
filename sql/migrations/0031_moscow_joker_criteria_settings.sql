-- Turns the 15 Joker matching criteria (docs/PER_MARKET_SERVICE_
-- INDEPENDENCE_PLAN.md section 5.1.1, dashboard/joker-criteria-reference.js)
-- into real, individually toggleable matching_moscow.runtime_settings rows
-- (2026-09-29). Previously these were shown as a static on/off badge with
-- no way to actually change them -- the user pointed out that section 9
-- ("Сопоставление") on Moscow's page should be "opционально настраиваемым"
-- (optionally configurable) just like UAE's own matching section, not a
-- read-only table.
--
-- Idempotent: INSERT ... ON CONFLICT (key) DO NOTHING, same pattern as
-- migration 0020's own settings seed.
DO $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM matching_moscow.runtime_settings WHERE key = 'joker_property_type_enabled') THEN
    -- Re-stamp the whole active config to a new version, same pattern as
    -- migrations 0023/0030's own re-stamp-on-write behavior.
    INSERT INTO matching_moscow.config_versions (version_number, snapshot, note, created_by)
    SELECT
      coalesce(max(version_number), 0) + 1,
      '{"phase": 1, "description": "Added 15 individually-toggleable Joker matching criteria settings (joker_*_enabled) -- previously shown as a static read-only badge on the Matching section, now real Draft->Apply settings like every other control on this page."}'::jsonb,
      'migration 0031: Joker criteria become real toggleable settings',
      'migration:0031_moscow_joker_criteria_settings'
    FROM matching_moscow.config_versions
    RETURNING id INTO v_id;

    UPDATE matching_moscow.runtime_settings SET config_version_id = v_id;
    UPDATE matching_moscow.intake_rules SET config_version_id = v_id;

    INSERT INTO matching_moscow.runtime_settings (key, value_type, value_text, config_version_id, updated_by) VALUES
      ('joker_property_type_enabled', 'boolean', 'true', v_id, 'migration:0031'),
      ('joker_city_enabled', 'boolean', 'true', v_id, 'migration:0031'),
      ('joker_district_enabled', 'boolean', 'true', v_id, 'migration:0031'),
      ('joker_complex_enabled', 'boolean', 'true', v_id, 'migration:0031'),
      ('joker_rooms_enabled', 'boolean', 'true', v_id, 'migration:0031'),
      ('joker_bedrooms_enabled', 'boolean', 'true', v_id, 'migration:0031'),
      ('joker_area_enabled', 'boolean', 'true', v_id, 'migration:0031'),
      ('joker_floor_enabled', 'boolean', 'true', v_id, 'migration:0031'),
      ('joker_floors_total_enabled', 'boolean', 'true', v_id, 'migration:0031'),
      ('joker_price_enabled', 'boolean', 'true', v_id, 'migration:0031'),
      ('joker_readiness_enabled', 'boolean', 'true', v_id, 'migration:0031'),
      ('joker_layout_enabled', 'boolean', 'false', v_id, 'migration:0031'),
      ('joker_euro_layout_enabled', 'boolean', 'false', v_id, 'migration:0031'),
      ('joker_deal_type_enabled', 'boolean', 'false', v_id, 'migration:0031'),
      ('joker_amenities_enabled', 'boolean', 'false', v_id, 'migration:0031')
    ON CONFLICT (key) DO NOTHING;

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
    -- settings array without the 15 new keys -- delete it so
    -- getOrInitDraft() rebuilds it fresh from the real table.
    DELETE FROM matching_moscow.config_draft WHERE id = 1;
  END IF;
END $$;
