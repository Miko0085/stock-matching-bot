'use strict';

// Nika Matching V2, Phase 2 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase
// 2, requirement 6). Pure, dependency-free validation for the configuration
// control plane (Settings UI + config-repository.js's write functions) --
// no DB access here, so every rule is directly unit-testable.
//
// This module never executes a pattern as code -- REGEX validation only
// ever calls `new RegExp(...)` to check SYNTAX, the same safe use every
// hard filter in this codebase already makes of user-editable regex
// strings (they are matched against text, never eval'd).

// Keys must match Phase 1's seeded settings exactly (sql/migrations/
// 0020_matching_v2_config.sql) -- this is a closed set on purpose: "known
// setting keys only" (spec requirement 6). Adding a new setting key is a
// deliberate schema/seed change, not something the UI can invent.
const KNOWN_SETTING_KEYS = {
  event_dedup_enabled: 'boolean',
  content_dedup_enabled: 'boolean',
  content_dedup_ttl_hours: 'numeric',
  ai_cache_enabled: 'boolean',
  ai_cache_ttl_days: 'numeric',
  whitelist_threshold: 'integer',
  property_signal_threshold: 'integer',
  transaction_matching_enabled: 'boolean',
  bedrooms_matching_enabled: 'boolean',
  property_type_matching_enabled: 'boolean',
  budget_matching_enabled: 'boolean',
  budget_tolerance_pct: 'numeric',
  ai_intake_gate_enabled: 'boolean',
  // Phase 4 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase 4, requirement
  // 1). `ai_intake_gate_enabled` above is a PRE-EXISTING Phase 1 setting
  // and must never be silently reinterpreted as the cutover flag (spec:
  // "Do not reinterpret existing ai_intake_gate_enabled") -- these two are
  // new, separate keys, seeded additively by migration 0023.
  v2_intake_cutover_enabled: 'boolean',
  buyer_signal_policy: 'text',
  // Moscow's 15 individually-toggleable Joker matching criteria (migration
  // 0031, dashboard/joker-criteria-reference.js). This registry is a
  // name+type dictionary, not schema-bound -- matching_dubai.runtime_settings
  // simply has no rows for these keys at all, so updateDraftSetting()'s own
  // "key must already exist in this schema's draft" check (config-repository.js)
  // independently blocks editing them against UAE, even though the type is
  // recognized here.
  joker_property_type_enabled: 'boolean',
  joker_city_enabled: 'boolean',
  joker_district_enabled: 'boolean',
  joker_complex_enabled: 'boolean',
  joker_rooms_enabled: 'boolean',
  joker_bedrooms_enabled: 'boolean',
  joker_area_enabled: 'boolean',
  joker_floor_enabled: 'boolean',
  joker_floors_total_enabled: 'boolean',
  joker_price_enabled: 'boolean',
  joker_readiness_enabled: 'boolean',
  joker_layout_enabled: 'boolean',
  joker_euro_layout_enabled: 'boolean',
  joker_deal_type_enabled: 'boolean',
  joker_amenities_enabled: 'boolean',
  // Migration 0032: replaces the UAE-copied budget_tolerance_pct that
  // migration 0030 removed from Moscow -- Moscow's own price-tolerance
  // setting for the real candidate query/hard filter.
  joker_price_tolerance_pct: 'numeric',
  // Migration 0039 (2026-10-06): shared across all three live schemas
  // (matching_dubai/matching_moscow/matching_abu_dhabi), not Dubai-only --
  // see src/db/route-reject-cleanup.js. 0 disables automatic cleanup.
  route_reject_retention_days: 'integer',
};

const RULE_GROUPS = ['BLACKLIST', 'WHITELIST', 'PROPERTY_SIGNAL', 'SEND_TO_AI'];
const MATCH_TYPES = ['PHRASE', 'REGEX'];
const BUYER_SIGNAL_POLICIES = ['REQUIRE_BOTH', 'REQUIRE_ANY'];

// LOCATION IS MANDATORY AND MUST NEVER BECOME DISABLEABLE (contract
// section 12.1). The DB already has a structural CHECK (migration 0020/
// Phase 1.1: `key !~ '^location_'`) -- this is the SAME rule enforced again
// here, in application code, per spec requirement 6's explicit "do not
// rely only on DB CHECK." Two independent layers agreeing is the point:
// neither can be silently weakened without the other still catching it.
function isLocationKey(key) {
  return /^location_/.test(String(key || ''));
}

function validateSettingKey(key) {
  if (isLocationKey(key)) {
    return { ok: false, error: `"${key}" is a location-related key -- location is mandatory and can never be a configurable setting.` };
  }
  if (!Object.prototype.hasOwnProperty.call(KNOWN_SETTING_KEYS, key)) {
    return { ok: false, error: `Unknown setting key "${key}". Only the Phase 1 seeded keys may be edited.` };
  }
  return { ok: true };
}

function validateSettingValue(key, valueType, valueText, enabled) {
  const keyCheck = validateSettingKey(key);
  if (!keyCheck.ok) return keyCheck;

  const expectedType = KNOWN_SETTING_KEYS[key];
  if (valueType !== expectedType) {
    return { ok: false, error: `"${key}" must be type "${expectedType}", got "${valueType}".` };
  }
  if (typeof enabled !== 'boolean') {
    return { ok: false, error: '"enabled" must be a boolean.' };
  }

  if (valueType === 'boolean') {
    if (valueText !== 'true' && valueText !== 'false') {
      return { ok: false, error: `"${key}" must be "true" or "false".` };
    }
    return { ok: true };
  }

  // Phase 4: buyer_signal_policy is the one closed-enum TEXT setting --
  // "unknown policy: validation should prevent it" (spec section 4),
  // enforced here in addition to the DB's own CHECK constraint (migration
  // 0023), same two-independent-layers philosophy as isLocationKey().
  if (key === 'buyer_signal_policy') {
    if (!BUYER_SIGNAL_POLICIES.includes(valueText)) {
      return { ok: false, error: `"buyer_signal_policy" must be one of ${BUYER_SIGNAL_POLICIES.join(', ')}.` };
    }
    return { ok: true };
  }

  // integer / numeric
  const n = Number(valueText);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `"${key}" must be a valid number.` };
  }
  if (valueType === 'integer' && !Number.isInteger(n)) {
    return { ok: false, error: `"${key}" must be a whole number.` };
  }
  if (key.endsWith('_threshold') && n < 0) {
    return { ok: false, error: `"${key}" must be zero or greater.` };
  }
  if ((key.endsWith('_ttl_hours') || key.endsWith('_ttl_days')) && n <= 0) {
    return { ok: false, error: `"${key}" (a TTL) must be greater than zero.` };
  }
  if (key === 'budget_tolerance_pct' && (n < 0 || n > 100)) {
    return { ok: false, error: '"budget_tolerance_pct" must be between 0 and 100.' };
  }
  return { ok: true };
}

// Syntax-only check -- never executes the pattern against real data here,
// exactly mirrors how hard-filters.js/candidate-query.js only ever use a
// pattern to match text, never to run arbitrary code.
function validateRegexSyntax(pattern) {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, 'iu');
    return { ok: true };
  } catch (err) {
    // V8's own RegExp SyntaxError message already starts with "Invalid
    // regular expression: ..." -- do not add a second prefix on top of it.
    return { ok: false, error: err.message };
  }
}

function validateRule({ rule_group, match_type, pattern, priority }) {
  if (!RULE_GROUPS.includes(rule_group)) {
    return { ok: false, error: `Invalid rule_group "${rule_group}" -- must be one of ${RULE_GROUPS.join(', ')}.` };
  }
  if (!MATCH_TYPES.includes(match_type)) {
    return { ok: false, error: `Invalid match_type "${match_type}" -- must be one of ${MATCH_TYPES.join(', ')}.` };
  }
  if (!pattern || !String(pattern).trim()) {
    return { ok: false, error: 'Pattern must not be empty.' };
  }
  if (priority !== undefined && priority !== null && !Number.isInteger(Number(priority))) {
    return { ok: false, error: 'Priority must be a whole number.' };
  }
  if (match_type === 'REGEX') {
    const regexCheck = validateRegexSyntax(pattern);
    if (!regexCheck.ok) return regexCheck;
  }
  return { ok: true };
}

module.exports = {
  KNOWN_SETTING_KEYS,
  RULE_GROUPS,
  MATCH_TYPES,
  BUYER_SIGNAL_POLICIES,
  isLocationKey,
  validateSettingKey,
  validateSettingValue,
  validateRegexSyntax,
  validateRule,
};
