-- Adds tenant-seeking rental WHITELIST phrases to matching_moscow.intake_rules
-- (2026-10-05, RF rental-enablement plan).
--
-- Migration 0029 seeded the WHITELIST by copying UAE's buy-side intent
-- phrases ("хочу купить", "ищу квартиру", ...) and the BLACKLIST correctly
-- blocks the landlord-offer verb ("сдам"/"сдаю"/"сдаётся"/"сдается"), but
-- never added the tenant-seeking mirror verb ("сниму"/"снять") to the
-- WHITELIST. Live data audit found real, unambiguous rental buyer requests
-- (e.g. "Сниму квартиру... Бюджет: до 65.000 р.") wrongly gate-rejected as
-- INSUFFICIENT_BUYER_SIGNAL and never reaching the AI parser/matcher, even
-- though the parser schema, hard filters (dealTypeFilter), and candidate
-- SQL query were already fully RENT-capable -- only the gate's vocabulary
-- was incomplete.
--
-- This was already applied to the live dev database via the real
-- Draft->Apply admin mechanism (addDraftRule/applyDraft, same one the
-- Settings UI uses) on 2026-10-05, producing config_version 6 there. This
-- migration makes that fix durable across every OTHER environment (CI,
-- disposable integration-test databases, a future fresh deploy) that only
-- ever runs from migrations, not from that one-off live mutation -- and is
-- itself idempotent/guarded so it is a safe no-op on the dev database where
-- the rows already exist.
DO $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM matching_moscow.intake_rules WHERE rule_group = 'WHITELIST' AND pattern = 'сниму'
  ) THEN
    INSERT INTO matching_moscow.intake_rules (rule_group, match_type, pattern, priority, description) VALUES
      ('WHITELIST', 'PHRASE', 'сниму', 100, 'Tenant-seeking rental verb -- mirrors BLACKLIST сдам/сдаю on the landlord side (RF rental-enablement plan, 2026-10-05)'),
      ('WHITELIST', 'PHRASE', 'ищу снять', 100, 'Explicit tenant-seeking phrase (RF rental-enablement plan, 2026-10-05)'),
      ('WHITELIST', 'PHRASE', 'хочу снять', 100, 'Explicit tenant-seeking phrase (RF rental-enablement plan, 2026-10-05)'),
      ('WHITELIST', 'PHRASE', 'снять квартиру', 100, 'Explicit tenant-seeking phrase (RF rental-enablement plan, 2026-10-05)'),
      ('WHITELIST', 'PHRASE', 'ищу аренду', 100, 'Explicit tenant-seeking phrase (RF rental-enablement plan, 2026-10-05)'),
      ('WHITELIST', 'PHRASE', 'нужна аренда', 100, 'Explicit tenant-seeking phrase (RF rental-enablement plan, 2026-10-05)');

    -- Re-stamp the whole active config to a new version, same pattern as
    -- migrations 0023/0030 -- every runtime_settings/intake_rules row
    -- shares one config_version_id at any given time.
    INSERT INTO matching_moscow.config_versions (version_number, snapshot, note, created_by)
    SELECT
      coalesce(max(version_number), 0) + 1,
      '{"phase": 1, "description": "Added 6 tenant-seeking rental WHITELIST phrases (сниму/ищу снять/хочу снять/снять квартиру/ищу аренду/нужна аренда) -- closes the gap that wrongly gate-rejected real rental buyer requests."}'::jsonb,
      'migration 0033: add rental WHITELIST phrases',
      'migration:0033_matching_moscow_rental_whitelist'
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

    -- The singleton draft (if it already existed) still has the OLD rules
    -- array without these 6 -- delete it so getOrInitDraft() rebuilds it
    -- fresh from the real (now-updated) table on next access.
    DELETE FROM matching_moscow.config_draft WHERE id = 1;
  END IF;
END $$;
