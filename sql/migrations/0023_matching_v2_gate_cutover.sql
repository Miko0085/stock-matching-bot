-- Nika Matching V2 simplification, Phase 4 (AGENTS_NIKA_MATCHING_V2.md
-- section 26, Phase 4): additive settings for the controlled V2 intake
-- gate cutover. Does not touch matching.shadow_gate_evaluations' existing
-- columns' semantics, does not modify migrations 0020-0022's own
-- statements, and does not change any existing runtime_settings/
-- intake_rules row's meaning.
--
-- IMPORTANT: adding these two rows changes the ACTIVE config_versions
-- version_number (a new version is created, exactly as an operator using
-- Draft -> Apply would produce) -- this is additive to history, never a
-- rewrite of version 1. Both new settings are seeded OFF/conservative
-- (cutover disabled, REQUIRE_BOTH == today's already-shadow-tested
-- policy), so applying this migration changes zero live behavior by
-- itself: nothing reads v2_intake_cutover_enabled as "on" until an
-- operator explicitly Applies a draft that turns it on (Phase 4 spec
-- section 16: "code deployment and runtime activation are separate").

-- ---------------------------------------------------------------------
-- 1. matching.shadow_gate_evaluations: mode column (spec section 10).
--    Every row inserted before this migration was, by construction, a
--    shadow-only observation -- backfilling the DEFAULT onto them via a
--    single ADD COLUMN is correct and requires no separate UPDATE.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'matching' AND table_name = 'shadow_gate_evaluations' AND column_name = 'mode'
  ) THEN
    ALTER TABLE matching.shadow_gate_evaluations
      ADD COLUMN mode TEXT NOT NULL DEFAULT 'SHADOW';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shadow_gate_evaluations_mode_check'
  ) THEN
    ALTER TABLE matching.shadow_gate_evaluations
      ADD CONSTRAINT shadow_gate_evaluations_mode_check CHECK (mode IN ('SHADOW', 'AUTHORITATIVE', 'FALLBACK'));
  END IF;
END $$;

-- old_decision must become nullable: an AUTHORITATIVE-mode row never runs
-- the legacy local-parser/triage path at all (that is the entire point of
-- cutover being ON), so there is no "old decision" to normalize for it.
-- Widening NOT NULL -> nullable is a safe, backward-compatible relaxation
-- (every existing row already has a non-null value; this never loses
-- data, only permits a new case going forward).
ALTER TABLE matching.shadow_gate_evaluations ALTER COLUMN old_decision DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shadow_gate_mode ON matching.shadow_gate_evaluations (mode);

-- ---------------------------------------------------------------------
-- 2. New runtime_settings: v2_intake_cutover_enabled, buyer_signal_policy.
--    Guarded by a NOT EXISTS check on the key so this migration is safe
--    to re-run and safe to run against a database that (for whatever
--    reason) already has these keys seeded by another path.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM matching.runtime_settings WHERE key = 'v2_intake_cutover_enabled') THEN
    -- Re-stamp the ENTIRE active config to a new version, exactly like
    -- config-repository.js's writeConfigAndSnapshot() does on a real
    -- operator Apply -- every runtime_settings/intake_rules row shares
    -- one config_version_id at any given time (see that function's own
    -- comment), so adding two new settings correctly means "the whole
    -- active state moved to version N+1", not "these two rows silently
    -- point at a version that doesn't describe them".
    INSERT INTO matching.config_versions (version_number, snapshot, note, created_by)
    SELECT
      coalesce(max(version_number), 0) + 1,
      '{"phase": 4, "description": "Adds v2_intake_cutover_enabled (default false) and buyer_signal_policy (default REQUIRE_BOTH) -- placeholder, backfilled below from the real rows."}'::jsonb,
      'Phase 4 migration: add V2 intake gate cutover settings (migration 0023)',
      'migration:0023_matching_v2_gate_cutover'
    FROM matching.config_versions
    RETURNING id INTO v_id;

    -- Re-point every EXISTING runtime_settings/intake_rules row at the new
    -- version -- their content is unchanged, but they are now part of the
    -- new version's active snapshot (matches Apply's own re-stamp-on-write
    -- behavior; the alternative -- leaving them pointed at version 1 while
    -- the two new rows point at version 2 -- would make version 2's
    -- snapshot an incomplete lie about what was actually active).
    UPDATE matching.runtime_settings SET config_version_id = v_id;
    UPDATE matching.intake_rules SET config_version_id = v_id;

    INSERT INTO matching.runtime_settings (key, value_type, value_text, config_version_id, updated_by) VALUES
      ('v2_intake_cutover_enabled', 'boolean', 'false', v_id, 'migration:0023'),
      ('buyer_signal_policy', 'text', 'REQUIRE_BOTH', v_id, 'migration:0023')
    ON CONFLICT (key) DO NOTHING;

    -- Backfill the version's snapshot from the real rows now that they
    -- all exist and are correctly stamped -- same "aggregate from real
    -- rows, never a hand-duplicated literal" discipline as migration
    -- 0020/1.1 and writeConfigAndSnapshot().
    UPDATE matching.config_versions
    SET snapshot = jsonb_build_object(
      'schema_version', 1,
      'config_version', (SELECT version_number FROM matching.config_versions WHERE id = v_id),
      'runtime_settings', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'key', key, 'value_type', value_type, 'value_text', value_text, 'enabled', enabled
        ) ORDER BY key), '[]'::jsonb)
        FROM matching.runtime_settings WHERE config_version_id = v_id
      ),
      'intake_rules', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'rule_group', rule_group, 'match_type', match_type, 'pattern', pattern,
          'enabled', enabled, 'priority', priority, 'description', description
        ) ORDER BY rule_group, priority, id), '[]'::jsonb)
        FROM matching.intake_rules WHERE config_version_id = v_id
      )
    )
    WHERE id = v_id;
  END IF;
END $$;

-- Structural, defense-in-depth constraint (same philosophy as the
-- location_* CHECK from migration 0020/Phase 1.1): the DB itself refuses
-- an invalid buyer_signal_policy value, not just application code --
-- "unknown policy: validation should prevent it" (Phase 4 spec section 4),
-- enforced at two independent layers.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'runtime_settings_buyer_signal_policy_check'
  ) THEN
    ALTER TABLE matching.runtime_settings
      ADD CONSTRAINT runtime_settings_buyer_signal_policy_check
      CHECK (key <> 'buyer_signal_policy' OR value_text IN ('REQUIRE_BOTH', 'REQUIRE_ANY'));
  END IF;
END $$;
