-- Moscow's OWN editable settings/intake-rules/config-versions (2026-09-28).
-- Mirrors matching_uae's shape exactly (migrations 0020/0021/0023) so the
-- SAME Settings UI code (dashboard/settings-view.js's section renderers)
-- can render Moscow's page with the same controls/parameters as UAE's --
-- the user explicitly asked for "the same as /settings, with the same
-- parameters", not a separate read-only reference page (which is what an
-- earlier pass in this session had built instead, then corrected).
--
-- Deliberately NOT mirrored here: matching_uae.shadow_gate_evaluations
-- (migrations 0022/0023's shadow-gate telemetry table) -- there is no live
-- Moscow matcher generating shadow evaluations yet (rf-lead-matching-service
-- still returns NOT_IMPLEMENTED for every request), so a shadow_gate_evaluations
-- table for Moscow would be empty machinery with nothing to observe. The
-- Settings UI's rule-hit-statistics block already handles a fully absent
-- `ruleStats` gracefully (renders with no stats, not an error).
--
-- AGENTS.md section 0's hard rule --  "No shared runtime_settings/
-- intake_rules table across markets, ever" -- is honored: this creates a
-- SEPARATE table under matching_moscow, not a shared/parameterized table.
-- Idempotent (safe to re-run), same style as 0020/0021/0023.

CREATE TABLE IF NOT EXISTS matching_moscow.config_versions (
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
    SELECT 1 FROM pg_constraint WHERE conname = 'moscow_config_versions_version_number_key'
  ) THEN
    ALTER TABLE matching_moscow.config_versions
      ADD CONSTRAINT moscow_config_versions_version_number_key UNIQUE (version_number);
  END IF;
END $$;

-- Same structural "location can never become disableable" guarantee as
-- matching_uae.runtime_settings (migration 0020) -- location is mandatory
-- for Moscow too (AGENTS.md section 0: a UAE matcher never queries RF
-- stock and vice versa, but location-as-a-hard-filter is a shared
-- matching-correctness principle, not a UAE-only one).
CREATE TABLE IF NOT EXISTS matching_moscow.runtime_settings (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('boolean', 'integer', 'numeric', 'text')),
  value_text TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  config_version_id BIGINT REFERENCES matching_moscow.config_versions(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  CONSTRAINT moscow_runtime_settings_location_not_configurable
    CHECK (key !~ '^location_'),
  CONSTRAINT moscow_runtime_settings_buyer_signal_policy_check
    CHECK (key <> 'buyer_signal_policy' OR value_text IN ('REQUIRE_BOTH', 'REQUIRE_ANY'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'moscow_runtime_settings_key_key'
  ) THEN
    ALTER TABLE matching_moscow.runtime_settings
      ADD CONSTRAINT moscow_runtime_settings_key_key UNIQUE (key);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS matching_moscow.intake_rules (
  id BIGSERIAL PRIMARY KEY,
  rule_group TEXT NOT NULL CHECK (rule_group IN ('BLACKLIST', 'WHITELIST', 'PROPERTY_SIGNAL', 'SEND_TO_AI')),
  match_type TEXT NOT NULL CHECK (match_type IN ('PHRASE', 'REGEX')),
  pattern TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 100,
  description TEXT,
  config_version_id BIGINT REFERENCES matching_moscow.config_versions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moscow_intake_rules_group_enabled
  ON matching_moscow.intake_rules (rule_group, enabled);

CREATE TABLE IF NOT EXISTS matching_moscow.config_draft (
  id INTEGER PRIMARY KEY DEFAULT 1,
  settings JSONB NOT NULL DEFAULT '[]'::jsonb,
  intake_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  based_on_version INTEGER,
  is_dirty BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT moscow_config_draft_singleton CHECK (id = 1)
);

-- ---------------------------------------------------------------------
-- Seed data -- from decisions already recorded in
-- docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md sections 5.3/5.4/5.5
-- (dashboard/moscow-settings-reference.js carries the same content as
-- prose). Guarded by version_number=1 not existing, same idempotent
-- pattern as migration 0020.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM matching_moscow.config_versions WHERE version_number = 1) THEN
    INSERT INTO matching_moscow.config_versions (version_number, snapshot, note, created_by)
    VALUES (
      1,
      '{"phase": 1, "description": "Initial Moscow settings seed from docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md sections 5.3-5.5 -- reuses UAE default values except property_signal_threshold=0 (PROPERTY_SIGNAL is empty at launch for Moscow)."}'::jsonb,
      'Phase 1 initial seed (Moscow settings, migration 0029)',
      'migration:0029_matching_moscow_settings'
    )
    RETURNING id INTO v_id;

    -- Settings: same 15 keys/defaults as matching_uae (migrations 0020+0023),
    -- with ONE confirmed exception -- see docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md
    -- section 5.5: property_signal_threshold=0, not UAE's 1, because
    -- PROPERTY_SIGNAL ships empty for Moscow (a threshold of 1 would reject
    -- every single Moscow message forever, since the count can never reach 1).
    INSERT INTO matching_moscow.runtime_settings (key, value_type, value_text, config_version_id, updated_by) VALUES
      ('event_dedup_enabled', 'boolean', 'true', v_id, 'migration:0029'),
      ('content_dedup_enabled', 'boolean', 'true', v_id, 'migration:0029'),
      ('content_dedup_ttl_hours', 'numeric', '48', v_id, 'migration:0029'),
      ('ai_cache_enabled', 'boolean', 'true', v_id, 'migration:0029'),
      ('ai_cache_ttl_days', 'numeric', '14', v_id, 'migration:0029'),
      ('whitelist_threshold', 'integer', '1', v_id, 'migration:0029'),
      ('property_signal_threshold', 'integer', '0', v_id, 'migration:0029'),
      ('transaction_matching_enabled', 'boolean', 'true', v_id, 'migration:0029'),
      ('bedrooms_matching_enabled', 'boolean', 'true', v_id, 'migration:0029'),
      ('property_type_matching_enabled', 'boolean', 'true', v_id, 'migration:0029'),
      ('budget_matching_enabled', 'boolean', 'true', v_id, 'migration:0029'),
      ('budget_tolerance_pct', 'numeric', '10', v_id, 'migration:0029'),
      ('ai_intake_gate_enabled', 'boolean', 'true', v_id, 'migration:0029'),
      ('v2_intake_cutover_enabled', 'boolean', 'false', v_id, 'migration:0029'),
      ('buyer_signal_policy', 'text', 'REQUIRE_BOTH', v_id, 'migration:0029')
    ON CONFLICT (key) DO NOTHING;

    -- BLACKLIST -- section 5.4: reused-as-is UAE Russian phrases (same
    -- meaning: seller/landlord announcing their own listing), plus a new
    -- Moscow-only agent-commission-spam draft.
    INSERT INTO matching_moscow.intake_rules (rule_group, match_type, pattern, description, config_version_id) VALUES
      ('BLACKLIST', 'PHRASE', 'сдам', 'Reused from UAE BLACKLIST (seller-offer verb) -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'сдаю', 'Reused from UAE BLACKLIST (seller-offer verb) -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'сдаётся', 'Reused from UAE BLACKLIST (seller-offer verb) -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'сдается', 'Reused from UAE BLACKLIST (seller-offer verb, е-spelling) -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'продам', 'Reused from UAE BLACKLIST (seller-offer verb) -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'продаю', 'Reused from UAE BLACKLIST (seller-offer verb) -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'продаётся', 'Reused from UAE BLACKLIST (seller-offer verb) -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'продается', 'Reused from UAE BLACKLIST (seller-offer verb, е-spelling) -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'от собственника', 'Reused from UAE BLACKLIST ("from the owner") -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'агентам рады', 'Moscow-only draft: agent-commission spam signal -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'работаем с агентами', 'Moscow-only draft: agent-commission spam signal -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'агентское вознаграждение', 'Moscow-only draft: agent-commission spam signal -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'комиссия покупателя ваша', 'Moscow-only draft: agent-commission spam signal -- plan section 5.4', v_id),
      ('BLACKLIST', 'PHRASE', 'агентские 50/50', 'Moscow-only draft: agent-commission spam signal -- plan section 5.4', v_id);

    -- WHITELIST -- section 5.4: user-provided draft phrase list, preserved
    -- verbatim (including the deferred seller-intent group at the end,
    -- which the user asked to keep as-is until revisited: "пока оставь,
    -- решим позже"). `description` records which sub-theme grouping this
    -- session's own PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md annotated it
    -- under (annotation only, not the user's own wording).
    INSERT INTO matching_moscow.intake_rules (rule_group, match_type, pattern, description, config_version_id) VALUES
      ('WHITELIST', 'PHRASE', 'ищу для клиента', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищем для клиента', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'клиент ищет', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'клиенту нужен', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'клиенту нужна', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'клиент рассматривает', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'есть клиент', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'есть прямой клиент', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'прямой клиент', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'под клиента', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'запрос от клиента', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'есть запрос', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'нужен объект', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'нужна квартира', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'нужна вилла', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'нужны варианты', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищу объект', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищу квартиру', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищу виллу', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищу апартаменты', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'кто может предложить', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'у кого есть', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'скиньте варианты', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'пришлите варианты', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'что есть в наличии', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'клиент готов смотреть', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'клиент готов купить', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'готов на просмотр', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'нужен просмотр', 'Draft: broker describing own client''s need -- plan section 5.4', v_id),

      ('WHITELIST', 'PHRASE', 'хочу купить', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'хотим купить', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'планирую купить', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищу квартиру', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищем квартиру', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищу виллу', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищу недвижимость', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищу апартаменты', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищем апартаменты', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'хочу приобрести', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'рассматриваю покупку', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'интересует покупка', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'готов купить', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'готовы купить', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'что можно купить', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'что есть в продаже', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'какие есть варианты', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'нужен брокер', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'нужен риелтор', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'посоветуйте брокера', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'посоветуйте риелтора', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'порекомендуйте брокера', 'Draft: direct buyer intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'к кому обратиться по недвижимости', 'Draft: direct buyer intent -- plan section 5.4', v_id),

      ('WHITELIST', 'PHRASE', 'хочу купить в новостройке', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищу новостройку', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'рассматриваю новостройку', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'интересует новостройка', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'какие есть новостройки', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'какие новые проекты', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'какой проект выбрать', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'посоветуйте проект', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'хочу купить от застройщика', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищу от застройщика', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'напрямую от застройщика', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'рассматриваю покупку от застройщика', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'хочу инвестировать в недвижимость', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'ищу объект для инвестиций', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'квартира для инвестиций', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'что купить для инвестиций', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'куда инвестировать в недвижимость', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'какие проекты для инвестиций', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'что можно купить с рассрочкой', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'интересует рассрочка', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'нужен график платежей', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'какие есть варианты с рассрочкой', 'Draft: new-build/developer/investment/installment intent -- plan section 5.4', v_id),

      ('WHITELIST', 'PHRASE', 'что лучше купить', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'где лучше купить', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'где лучше инвестировать', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'куда лучше инвестировать', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'какой район лучше для покупки', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'какой район лучше для инвестиций', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'что купить под сдачу', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'что купить для аренды', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'что купить до [сумма]', 'Draft: comparison/rental-investment/agency search -- plan section 5.4 (verbatim placeholder from the user''s own draft, not yet a working pattern)', v_id),
      ('WHITELIST', 'PHRASE', 'что есть до [сумма]', 'Draft: comparison/rental-investment/agency search -- plan section 5.4 (verbatim placeholder from the user''s own draft, not yet a working pattern)', v_id),
      ('WHITELIST', 'PHRASE', 'какие варианты до [сумма]', 'Draft: comparison/rental-investment/agency search -- plan section 5.4 (verbatim placeholder from the user''s own draft, not yet a working pattern)', v_id),
      ('WHITELIST', 'PHRASE', 'кто занимается недвижимостью', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'кто может помочь с покупкой', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'нужен специалист по недвижимости', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'посоветуйте агентство', 'Draft: comparison/rental-investment/agency search -- plan section 5.4', v_id),

      ('WHITELIST', 'PHRASE', 'как продать квартиру', 'DEFERRED 2026-09-28: seller intent, not buyer intent -- kept as-is per the user ("пока оставь, решим позже"), plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'как лучше продать обьект', 'DEFERRED 2026-09-28: seller intent, not buyer intent -- kept as-is per the user ("пока оставь, решим позже"), plan section 5.4', v_id),
      ('WHITELIST', 'PHRASE', 'как продать апартаменты', 'DEFERRED 2026-09-28: seller intent, not buyer intent -- kept as-is per the user ("пока оставь, решим позже"), plan section 5.4', v_id);

    -- PROPERTY_SIGNAL / SEND_TO_AI -- decided empty at launch (plan section
    -- 5.4), same already-established pattern as UAE's own SEND_TO_AI group.

    -- Backfill the full historical snapshot from the real rows just
    -- inserted -- same discipline as migration 0020, can never drift.
    UPDATE matching_moscow.config_versions
    SET snapshot = jsonb_build_object(
      'schema_version', 1,
      'config_version', 1,
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
  END IF;
END $$;
