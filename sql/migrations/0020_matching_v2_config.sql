-- Nika Matching V2 simplification, Phase 1 (AGENTS_NIKA_MATCHING_V2.md
-- section 26, Phase 1): additive PostgreSQL foundation for editable
-- settings/intake-rules/config-versions. Nothing in the current runtime
-- reads these tables yet -- lead-matching-service/src/gates/triage.js and
-- src/config/index.js remain the active, unchanged decision path. This is
-- storage only, wired up in a later phase (2+).
--
-- No existing table/column is modified or dropped. Idempotent (safe to
-- re-run), same style as 0002_matching_aliases.sql / 0015_event_dedup_and_
-- interpretation_cache.sql.

-- ---------------------------------------------------------------------
-- 1. matching.config_versions -- append-only snapshot history (contract
--    section 21: "Every Apply creates a durable snapshot"). Kept simple
--    per the contract's own "Keep it simple. Do not build Phase 2 UI yet.":
--    one JSONB snapshot of the full settings+rules state per version,
--    rather than per-row versioning -- sufficient for future preview/
--    apply/rollback without a complex schema now.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matching.config_versions (
  id BIGSERIAL PRIMARY KEY,
  version_number INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'config_versions_version_number_key'
  ) THEN
    ALTER TABLE matching.config_versions
      ADD CONSTRAINT config_versions_version_number_key UNIQUE (version_number);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. matching.runtime_settings -- current active value per key (typed via
--    value_type + a single text representation, parsed by the reading
--    repository -- avoids a wide sparse-column table for a handful of
--    boolean/numeric settings).
--
--    LOCATION IS MANDATORY AND MUST NEVER BECOME DISABLEABLE (contract
--    section 12.1): enforced structurally, not just by convention. Phase
--    1.1 hardening: a finite key-name allowlist/blocklist (the original
--    `key NOT IN (...)`) only protects the exact names it enumerates --
--    'location_filter_enabled' or 'location_match_enabled' would have
--    slipped straight past it. The CHECK below instead rejects ANY key
--    starting with the `location_` prefix, structurally, regardless of
--    what comes after it -- no future UI/API/typo can add a location
--    toggle under any name in this family.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matching.runtime_settings (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('boolean', 'integer', 'numeric', 'text')),
  value_text TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  config_version_id BIGINT REFERENCES matching.config_versions(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  CONSTRAINT runtime_settings_location_not_configurable
    CHECK (key !~ '^location_')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'runtime_settings_key_key'
  ) THEN
    ALTER TABLE matching.runtime_settings
      ADD CONSTRAINT runtime_settings_key_key UNIQUE (key);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. matching.intake_rules -- BLACKLIST / WHITELIST / PROPERTY_SIGNAL /
--    SEND_TO_AI, PHRASE / REGEX only (contract section 7: "Do not create
--    a complex DSL unless explicitly approved").
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matching.intake_rules (
  id BIGSERIAL PRIMARY KEY,
  rule_group TEXT NOT NULL CHECK (rule_group IN ('BLACKLIST', 'WHITELIST', 'PROPERTY_SIGNAL', 'SEND_TO_AI')),
  match_type TEXT NOT NULL CHECK (match_type IN ('PHRASE', 'REGEX')),
  pattern TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 100,
  description TEXT,
  config_version_id BIGINT REFERENCES matching.config_versions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_intake_rules_group_enabled
  ON matching.intake_rules (rule_group, enabled);

-- ---------------------------------------------------------------------
-- 4. Seed data -- a conservative initial set derived from the CURRENT
--    hardcoded triage patterns (lead-matching-service/src/gates/triage.js)
--    and the current env-based config defaults
--    (lead-matching-service/src/config/index.js), not an invented
--    taxonomy. Full per-row provenance is documented in
--    docs/MATCHING_V2_PHASE1_CONFIG.md. Guarded by a NOT EXISTS check on
--    version_number so re-running this migration never duplicates the
--    seed (idempotent, matches this file's own re-run safety elsewhere).
--
--    Phase 1.1 hardening: `snapshot` is backfilled (see the UPDATE at the
--    end of this block) with the COMPLETE historical record -- every
--    seeded setting and rule, not just a one-line description -- so
--    version 1 can be reconstructed later purely from this column, even
--    if the live `runtime_settings`/`intake_rules` rows are later edited
--    by an operator (Phase 2+). The snapshot is built FROM the rows this
--    same block inserts (via a query, not a hand-duplicated literal), so
--    it can never drift from what was actually seeded.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM matching.config_versions WHERE version_number = 1) THEN
    INSERT INTO matching.config_versions (version_number, snapshot, note, created_by)
    VALUES (
      1,
      '{"phase": 1, "description": "Initial seed derived from current hardcoded triage.js patterns and config/index.js defaults -- not yet read by any runtime code."}'::jsonb,
      'Phase 1 initial seed (matching-correctness/V2 refactor)',
      'migration:0020_matching_v2_config'
    )
    RETURNING id INTO v_id;

    -- Settings -- defaults mirror lead-matching-service/src/config/index.js
    -- and the current always-on behavior of the features they represent.
    INSERT INTO matching.runtime_settings (key, value_type, value_text, config_version_id, updated_by) VALUES
      ('event_dedup_enabled', 'boolean', 'true', v_id, 'migration:0020'),
      ('content_dedup_enabled', 'boolean', 'true', v_id, 'migration:0020'),
      ('content_dedup_ttl_hours', 'numeric', '48', v_id, 'migration:0020'),
      ('ai_cache_enabled', 'boolean', 'true', v_id, 'migration:0020'),
      ('ai_cache_ttl_days', 'numeric', '14', v_id, 'migration:0020'),
      ('whitelist_threshold', 'integer', '1', v_id, 'migration:0020'),
      ('property_signal_threshold', 'integer', '1', v_id, 'migration:0020'),
      ('transaction_matching_enabled', 'boolean', 'true', v_id, 'migration:0020'),
      ('bedrooms_matching_enabled', 'boolean', 'true', v_id, 'migration:0020'),
      ('property_type_matching_enabled', 'boolean', 'true', v_id, 'migration:0020'),
      ('budget_matching_enabled', 'boolean', 'true', v_id, 'migration:0020'),
      ('budget_tolerance_pct', 'numeric', '10', v_id, 'migration:0020'),
      ('ai_intake_gate_enabled', 'boolean', 'true', v_id, 'migration:0020')
    ON CONFLICT (key) DO NOTHING;

    -- BLACKLIST -- derived from triage.js's BROKER_SOLICITATION_PATTERNS,
    -- FOR_SALE_HEADING_RE, and RUSSIAN_OFFER_SIGNAL_RE.
    INSERT INTO matching.intake_rules (rule_group, match_type, pattern, description, config_version_id) VALUES
      ('BLACKLIST', 'REGEX', '\bdo\s+you\s+have\s+(?:a\s+)?(?:buyer|client)s?\b', 'triage.js BROKER_SOLICITATION_PATTERNS[0]', v_id),
      ('BLACKLIST', 'REGEX', '\bhave\s+a\s+client\s+looking\s+to\s+buy\b', 'triage.js BROKER_SOLICITATION_PATTERNS[1]', v_id),
      ('BLACKLIST', 'REGEX', '\bsend\s+(?:us|me)\s+your\s+client''?s?\s+requirements?\b', 'triage.js BROKER_SOLICITATION_PATTERNS[2]', v_id),
      ('BLACKLIST', 'REGEX', '\bagents?\s+(?:are\s+)?(?:always\s+)?welcome\b', 'triage.js BROKER_SOLICITATION_PATTERNS[4]', v_id),
      ('BLACKLIST', 'REGEX', '\bbuyer[\s-]side\s+commission\s+is\s+(?:100%\s+)?yours\b', 'triage.js BROKER_SOLICITATION_PATTERNS[5]', v_id),
      ('BLACKLIST', 'REGEX', '\bdo\s+you\s+have\s+a\s+client\s+looking\s+for\b', 'triage.js BROKER_SOLICITATION_PATTERNS[6]', v_id),
      ('BLACKLIST', 'REGEX', '^\s*(?:🏠\s*)?for\s+(?:sale|rent)\b', 'triage.js FOR_SALE_HEADING_RE', v_id),
      ('BLACKLIST', 'PHRASE', 'сдам', 'triage.js RUSSIAN_OFFER_SIGNAL_RE (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'сдаю', 'triage.js RUSSIAN_OFFER_SIGNAL_RE (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'сдаётся', 'triage.js RUSSIAN_OFFER_SIGNAL_RE (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'сдается', 'triage.js RUSSIAN_OFFER_SIGNAL_RE (seller-offer verb, е-spelling)', v_id),
      ('BLACKLIST', 'PHRASE', 'продам', 'triage.js RUSSIAN_OFFER_SIGNAL_RE (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'продаю', 'triage.js RUSSIAN_OFFER_SIGNAL_RE (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'продаётся', 'triage.js RUSSIAN_OFFER_SIGNAL_RE (seller-offer verb)', v_id),
      ('BLACKLIST', 'PHRASE', 'продается', 'triage.js RUSSIAN_OFFER_SIGNAL_RE (seller-offer verb, е-spelling)', v_id),
      ('BLACKLIST', 'PHRASE', 'от собственника', 'triage.js RUSSIAN_OFFER_SIGNAL_RE ("from the owner")', v_id);

    -- WHITELIST -- derived from local-parser.js STRONG_BUYER_INTENT_PATTERNS
    -- and triage.js FIRST_PERSON_BUYER_RE's buyer-side (never seller-side)
    -- entries, plus the contract's own section 7 examples (ищу/нужен/
    -- клиент ищет), which already exist in code as FIRST_PERSON_BUYER_RE.
    INSERT INTO matching.intake_rules (rule_group, match_type, pattern, description, config_version_id) VALUES
      ('WHITELIST', 'REGEX', '\bneed(?:s|ed)?\b', 'local-parser.js STRONG_BUYER_INTENT_PATTERNS', v_id),
      ('WHITELIST', 'REGEX', '\blooking\s+for\b', 'local-parser.js STRONG_BUYER_INTENT_PATTERNS', v_id),
      ('WHITELIST', 'REGEX', '\blooking\s+to\s+buy\b', 'local-parser.js STRONG_BUYER_INTENT_PATTERNS', v_id),
      ('WHITELIST', 'REGEX', '\blooking\s+to\s+rent\b', 'local-parser.js STRONG_BUYER_INTENT_PATTERNS', v_id),
      ('WHITELIST', 'REGEX', '\bmy\s+client\s+needs?\b', 'local-parser.js STRONG_BUYER_INTENT_PATTERNS', v_id),
      ('WHITELIST', 'REGEX', '\bmy\s+client\s+is\s+looking\s+for\b', 'local-parser.js STRONG_BUYER_INTENT_PATTERNS', v_id),
      ('WHITELIST', 'REGEX', '\bclient\s+requirement\b', 'local-parser.js STRONG_BUYER_INTENT_PATTERNS', v_id),
      ('WHITELIST', 'REGEX', '\bwtb\b', 'local-parser.js STRONG_BUYER_INTENT_PATTERNS', v_id),
      ('WHITELIST', 'REGEX', '\brequired\b', 'local-parser.js STRONG_BUYER_INTENT_PATTERNS', v_id),
      ('WHITELIST', 'REGEX', '\bseeking\b', 'local-parser.js STRONG_BUYER_INTENT_PATTERNS', v_id),
      ('WHITELIST', 'PHRASE', 'ищу', 'triage.js FIRST_PERSON_BUYER_RE (buyer-side)', v_id),
      ('WHITELIST', 'PHRASE', 'нужен', 'triage.js FIRST_PERSON_BUYER_RE (buyer-side)', v_id),
      ('WHITELIST', 'PHRASE', 'нужна', 'triage.js FIRST_PERSON_BUYER_RE (buyer-side)', v_id),
      ('WHITELIST', 'PHRASE', 'сниму', 'triage.js FIRST_PERSON_BUYER_RE (buyer-side, "I would like to rent")', v_id),
      ('WHITELIST', 'PHRASE', 'клиенту нужен', 'triage.js FIRST_PERSON_BUYER_RE clienту\s+нужн prefix (masculine form)', v_id),
      ('WHITELIST', 'PHRASE', 'клиенту нужна', 'triage.js FIRST_PERSON_BUYER_RE clienту\s+нужн prefix (feminine form)', v_id);

    -- PROPERTY_SIGNAL -- representative extract (not the complete pattern)
    -- from triage.js's BEDROOM_SIGNAL_RE / PRICE_SIGNAL_RE / LISTING_WORD_RE,
    -- currently used for multi-listing-ad detection -- reused here as
    -- generic "this message is about a real-estate requirement" evidence.
    -- Full 1:1 fidelity is not required in Phase 1 since no runtime code
    -- reads this table yet; revisit before Phase 3 shadow wiring.
    INSERT INTO matching.intake_rules (rule_group, match_type, pattern, description, config_version_id) VALUES
      ('PROPERTY_SIGNAL', 'REGEX', '\b\d+\s*br\b', 'triage.js BEDROOM_SIGNAL_RE (extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', '\b\d+\s*bd\b', 'triage.js BEDROOM_SIGNAL_RE (extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', 'bedrooms?\s*:', 'triage.js BEDROOM_SIGNAL_RE (extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', '\bsqft\b', 'triage.js LISTING_WORD_RE (extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', 'sq\.?\s*ft', 'triage.js LISTING_WORD_RE (extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', '\bhandover\b', 'triage.js LISTING_WORD_RE (extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', '\bfloor\b', 'triage.js LISTING_WORD_RE (extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', 'view\s*:', 'triage.js LISTING_WORD_RE (extract)', v_id),
      ('PROPERTY_SIGNAL', 'REGEX', '\baed\b', 'triage.js PRICE_SIGNAL_RE (extract, bare AED token)', v_id);

    -- SEND_TO_AI -- intentionally EMPTY. No current hardcoded equivalent of
    -- "explicit operator exception, always review with AI" exists in the
    -- code today (triage.js's AI_REVIEW branch is a fallback default, not
    -- an explicit rule) -- seeding a fabricated example would violate the
    -- "derived from current hardcoded rules, do not invent" instruction.
    -- Left for product/operator input once the Settings UI exists (Phase 2).

    -- Backfill the full historical snapshot now that every setting/rule
    -- row above actually exists with this version's id -- aggregated FROM
    -- the real rows, so it is definitionally accurate and can never
    -- silently drift from the INSERTs above.
    UPDATE matching.config_versions
    SET snapshot = jsonb_build_object(
      'schema_version', 1,
      'config_version', 1,
      'runtime_settings', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'key', key,
          'value_type', value_type,
          'value_text', value_text,
          'enabled', enabled
        ) ORDER BY key), '[]'::jsonb)
        FROM matching.runtime_settings WHERE config_version_id = v_id
      ),
      'intake_rules', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'rule_group', rule_group,
          'match_type', match_type,
          'pattern', pattern,
          'enabled', enabled,
          'priority', priority,
          'description', description
        ) ORDER BY rule_group, priority, id), '[]'::jsonb)
        FROM matching.intake_rules WHERE config_version_id = v_id
      )
    )
    WHERE id = v_id;
  END IF;
END $$;
