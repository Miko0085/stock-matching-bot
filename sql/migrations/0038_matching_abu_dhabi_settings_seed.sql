-- Abu Dhabi's own default runtime_settings/intake_rules seed (2026-10-05),
-- filling the gap left by migration 0036: that migration created the
-- EMPTY tables, but the Draft->Apply Settings UI and the V2 intake gate
-- both need at least a seeded version 1 row to function at all (tested via
-- this service's own pipeline.test.js and the dashboard's
-- `/settings?market=abu_dhabi` page) -- exactly the role migration 0029
-- played for matching_moscow and 0020/0023 played for matching_dubai.
--
-- Values/phrases are copied verbatim from matching_dubai's own seed
-- (migrations 0020/0023), not reinvented: Abu Dhabi buyers write in the
-- same English (plus occasional Russian) as Dubai buyers, and this is a
-- brand-new contour with no operational history of its own yet to draw
-- a different starting point from. An operator can tune all of this later
-- via the Settings UI without a further migration.
--
-- AGENTS.md section 0's hard rule -- "No shared runtime_settings/
-- intake_rules table across markets, ever" -- is honored: this only ever
-- writes into matching_abu_dhabi's own tables (created by 0036), never a
-- shared one. Idempotent (safe to re-run), same style as 0020/0023/0029.

DO $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM matching_abu_dhabi.config_versions WHERE version_number = 1) THEN
    INSERT INTO matching_abu_dhabi.config_versions (version_number, snapshot, note, created_by)
    VALUES (
      1,
      '{"phase": 1, "description": "Initial Abu Dhabi settings seed, copied verbatim from matching_dubai migrations 0020/0023 (same English/Russian buyer-message vocabulary, brand-new contour with no operational history of its own yet)."}'::jsonb,
      'Phase 1 initial seed (Abu Dhabi settings, migration 0038)',
      'migration:0038_matching_abu_dhabi_settings_seed'
    )
    RETURNING id INTO v_id;

    INSERT INTO matching_abu_dhabi.runtime_settings (key, value_type, value_text, config_version_id, updated_by) VALUES
      ('event_dedup_enabled', 'boolean', 'true', v_id, 'migration:0038'),
      ('content_dedup_enabled', 'boolean', 'true', v_id, 'migration:0038'),
      ('content_dedup_ttl_hours', 'numeric', '48', v_id, 'migration:0038'),
      ('ai_cache_enabled', 'boolean', 'true', v_id, 'migration:0038'),
      ('ai_cache_ttl_days', 'numeric', '14', v_id, 'migration:0038'),
      ('whitelist_threshold', 'integer', '1', v_id, 'migration:0038'),
      ('property_signal_threshold', 'integer', '1', v_id, 'migration:0038'),
      ('transaction_matching_enabled', 'boolean', 'true', v_id, 'migration:0038'),
      ('bedrooms_matching_enabled', 'boolean', 'true', v_id, 'migration:0038'),
      ('property_type_matching_enabled', 'boolean', 'true', v_id, 'migration:0038'),
      ('budget_matching_enabled', 'boolean', 'true', v_id, 'migration:0038'),
      ('budget_tolerance_pct', 'numeric', '10', v_id, 'migration:0038'),
      ('ai_intake_gate_enabled', 'boolean', 'true', v_id, 'migration:0038'),
      ('v2_intake_cutover_enabled', 'boolean', 'false', v_id, 'migration:0038'),
      ('buyer_signal_policy', 'text', 'REQUIRE_BOTH', v_id, 'migration:0038')
    ON CONFLICT (key) DO NOTHING;

    -- BLACKLIST -- verbatim from matching_dubai migration 0020.
    INSERT INTO matching_abu_dhabi.intake_rules (rule_group, match_type, pattern, description, config_version_id) VALUES
      ('BLACKLIST', 'REGEX', '\bdo\s+you\s+have\s+(?:a\s+)?(?:buyer|client)s?\b', 'Copied from matching_dubai migration 0020 (triage.js BROKER_SOLICITATION_PATTERNS[0])', v_id),
      ('BLACKLIST', 'REGEX', '\bhave\s+a\s+client\s+looking\s+to\s+buy\b', 'Copied from matching_dubai migration 0020 (triage.js BROKER_SOLICITATION_PATTERNS[1])', v_id),
      ('BLACKLIST', 'REGEX', '\bsend\s+(?:us|me)\s+your\s+client''?s?\s+requirements?\b', 'Copied from matching_dubai migration 0020 (triage.js BROKER_SOLICITATION_PATTERNS[2])', v_id),
      ('BLACKLIST', 'REGEX', '\bagents?\s+(?:are\s+)?(?:always\s+)?welcome\b', 'Copied from matching_dubai migration 0020 (triage.js BROKER_SOLICITATION_PATTERNS[4])', v_id),
      ('BLACKLIST', 'REGEX', '\bbuyer[\s-]side\s+commission\s+is\s+(?:100%\s+)?yours\b', 'Copied from matching_dubai migration 0020 (triage.js BROKER_SOLICITATION_PATTERNS[5])', v_id),
      ('BLACKLIST', 'REGEX', '\bdo\s+you\s+have\s+a\s+client\s+looking\s+for\b', 'Copied from matching_dubai migration 0020 (triage.js BROKER_SOLICITATION_PATTERNS[6])', v_id),
      ('BLACKLIST', 'REGEX', '^\s*(?:🏠\s*)?for\s+(?:sale|rent)\b', 'Copied from matching_dubai migration 0020 (triage.js FOR_SALE_HEADING_RE)', v_id),
      ('BLACKLIST', 'PHRASE', 'сдам', 'Copied from matching_dubai migration 0020 (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'сдаю', 'Copied from matching_dubai migration 0020 (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'сдаётся', 'Copied from matching_dubai migration 0020 (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'сдается', 'Copied from matching_dubai migration 0020 (seller-offer verb, е-spelling)', v_id),
      ('BLACKLIST', 'PHRASE', 'продам', 'Copied from matching_dubai migration 0020 (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'продаю', 'Copied from matching_dubai migration 0020 (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'продаётся', 'Copied from matching_dubai migration 0020 (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'продается', 'Copied from matching_dubai migration 0020 (seller-offer verb, е-spelling)', v_id),
      ('BLACKLIST', 'PHRASE', 'от собственника', 'Copied from matching_dubai migration 0020 ("from the owner")', v_id);

    -- WHITELIST -- verbatim from matching_dubai migration 0020.
    INSERT INTO matching_abu_dhabi.intake_rules (rule_group, match_type, pattern, description, config_version_id) VALUES
      ('WHITELIST', 'REGEX', '\bneed(?:s|ed)?\b', 'Copied from matching_dubai migration 0020 (local-parser.js STRONG_BUYER_INTENT_PATTERNS)', v_id),
      ('WHITELIST', 'REGEX', '\blooking\s+for\b', 'Copied from matching_dubai migration 0020 (local-parser.js STRONG_BUYER_INTENT_PATTERNS)', v_id),
      ('WHITELIST', 'REGEX', '\blooking\s+to\s+buy\b', 'Copied from matching_dubai migration 0020 (local-parser.js STRONG_BUYER_INTENT_PATTERNS)', v_id),
      ('WHITELIST', 'REGEX', '\blooking\s+to\s+rent\b', 'Copied from matching_dubai migration 0020 (local-parser.js STRONG_BUYER_INTENT_PATTERNS)', v_id),
      ('WHITELIST', 'REGEX', '\bmy\s+client\s+needs?\b', 'Copied from matching_dubai migration 0020 (local-parser.js STRONG_BUYER_INTENT_PATTERNS)', v_id),
      ('WHITELIST', 'REGEX', '\bmy\s+client\s+is\s+looking\s+for\b', 'Copied from matching_dubai migration 0020 (local-parser.js STRONG_BUYER_INTENT_PATTERNS)', v_id),
      ('WHITELIST', 'REGEX', '\bclient\s+requirement\b', 'Copied from matching_dubai migration 0020 (local-parser.js STRONG_BUYER_INTENT_PATTERNS)', v_id),
      ('WHITELIST', 'REGEX', '\bwtb\b', 'Copied from matching_dubai migration 0020 (local-parser.js STRONG_BUYER_INTENT_PATTERNS)', v_id),
      ('WHITELIST', 'REGEX', '\brequired\b', 'Copied from matching_dubai migration 0020 (local-parser.js STRONG_BUYER_INTENT_PATTERNS)', v_id),
      ('WHITELIST', 'REGEX', '\bseeking\b', 'Copied from matching_dubai migration 0020 (local-parser.js STRONG_BUYER_INTENT_PATTERNS)', v_id),
      ('WHITELIST', 'PHRASE', 'ищу', 'Copied from matching_dubai migration 0020 (buyer-side)', v_id),
      ('WHITELIST', 'PHRASE', 'нужен', 'Copied from matching_dubai migration 0020 (buyer-side)', v_id),
      ('WHITELIST', 'PHRASE', 'нужна', 'Copied from matching_dubai migration 0020 (buyer-side)', v_id),
      ('WHITELIST', 'PHRASE', 'сниму', 'Copied from matching_dubai migration 0020 (buyer-side, "I would like to rent")', v_id),
      ('WHITELIST', 'PHRASE', 'клиенту нужен', 'Copied from matching_dubai migration 0020 (masculine form)', v_id),
      ('WHITELIST', 'PHRASE', 'клиенту нужна', 'Copied from matching_dubai migration 0020 (feminine form)', v_id);

    -- PROPERTY_SIGNAL -- verbatim from matching_dubai migration 0020.
    INSERT INTO matching_abu_dhabi.intake_rules (rule_group, match_type, pattern, description, config_version_id) VALUES
      ('PROPERTY_SIGNAL', 'REGEX', '\b\d+\s*br\b', 'Copied from matching_dubai migration 0020 (BEDROOM_SIGNAL_RE extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', '\b\d+\s*bd\b', 'Copied from matching_dubai migration 0020 (BEDROOM_SIGNAL_RE extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', 'bedrooms?\s*:', 'Copied from matching_dubai migration 0020 (BEDROOM_SIGNAL_RE extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', '\bsqft\b', 'Copied from matching_dubai migration 0020 (LISTING_WORD_RE extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', 'sq\.?\s*ft', 'Copied from matching_dubai migration 0020 (LISTING_WORD_RE extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', '\bhandover\b', 'Copied from matching_dubai migration 0020 (LISTING_WORD_RE extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', '\bfloor\b', 'Copied from matching_dubai migration 0020 (LISTING_WORD_RE extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', 'view\s*:', 'Copied from matching_dubai migration 0020 (LISTING_WORD_RE extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', '\baed\b', 'Copied from matching_dubai migration 0020 (PRICE_SIGNAL_RE extract, bare AED token)', v_id);

    -- SEND_TO_AI -- intentionally empty, same as matching_dubai's own seed.

    -- Backfill the full historical snapshot from the real rows just
    -- inserted -- same discipline as migrations 0020/0029, can never drift.
    UPDATE matching_abu_dhabi.config_versions
    SET snapshot = jsonb_build_object(
      'schema_version', 1,
      'config_version', 1,
      'runtime_settings', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'key', key, 'value_type', value_type, 'value_text', value_text, 'enabled', enabled
        ) ORDER BY key), '[]'::jsonb)
        FROM matching_abu_dhabi.runtime_settings WHERE config_version_id = v_id
      ),
      'intake_rules', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'rule_group', rule_group, 'match_type', match_type, 'pattern', pattern,
          'enabled', enabled, 'priority', priority, 'description', description
        ) ORDER BY rule_group, priority, id), '[]'::jsonb)
        FROM matching_abu_dhabi.intake_rules WHERE config_version_id = v_id
      )
    )
    WHERE id = v_id;
  END IF;
END $$;
