'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateSettingKey,
  validateSettingValue,
  validateRegexSyntax,
  validateRule,
  isLocationKey,
} = require('../../src/config/config-validation');

test('isLocationKey / validateSettingKey: any key starting with location_ is rejected, not a finite list', () => {
  for (const key of ['location_enabled', 'location_matching_enabled', 'location_filter_enabled', 'location_match_enabled', 'location_anything_at_all']) {
    assert.equal(isLocationKey(key), true, key);
    assert.equal(validateSettingKey(key).ok, false, key);
  }
});

test('validateSettingKey: an unknown (non-location) key is rejected -- known keys only', () => {
  const result = validateSettingKey('totally_made_up_setting');
  assert.equal(result.ok, false);
});

test('validateSettingKey: every real Phase 1 seeded key is accepted', () => {
  const knownKeys = [
    'event_dedup_enabled', 'content_dedup_enabled', 'content_dedup_ttl_hours',
    'ai_cache_enabled', 'ai_cache_ttl_days', 'whitelist_threshold', 'property_signal_threshold',
    'transaction_matching_enabled', 'bedrooms_matching_enabled', 'property_type_matching_enabled',
    'budget_matching_enabled', 'budget_tolerance_pct', 'ai_intake_gate_enabled',
  ];
  for (const key of knownKeys) {
    assert.equal(validateSettingKey(key).ok, true, key);
  }
});

test('validateSettingValue: boolean type mismatch is rejected', () => {
  const result = validateSettingValue('event_dedup_enabled', 'numeric', '1', true);
  assert.equal(result.ok, false);
});

test('validateSettingValue: boolean value must be "true"/"false" text', () => {
  assert.equal(validateSettingValue('event_dedup_enabled', 'boolean', 'true', true).ok, true);
  assert.equal(validateSettingValue('event_dedup_enabled', 'boolean', 'yes', true).ok, false);
});

test('validateSettingValue: threshold must be non-negative', () => {
  assert.equal(validateSettingValue('whitelist_threshold', 'integer', '1', true).ok, true);
  assert.equal(validateSettingValue('whitelist_threshold', 'integer', '-1', true).ok, false);
});

test('validateSettingValue: TTL must be greater than zero', () => {
  assert.equal(validateSettingValue('ai_cache_ttl_days', 'numeric', '14', true).ok, true);
  assert.equal(validateSettingValue('ai_cache_ttl_days', 'numeric', '0', true).ok, false);
  assert.equal(validateSettingValue('content_dedup_ttl_hours', 'numeric', '-5', true).ok, false);
});

test('validateSettingValue: budget_tolerance_pct must be within [0, 100]', () => {
  assert.equal(validateSettingValue('budget_tolerance_pct', 'numeric', '10', true).ok, true);
  assert.equal(validateSettingValue('budget_tolerance_pct', 'numeric', '0', true).ok, true);
  assert.equal(validateSettingValue('budget_tolerance_pct', 'numeric', '100', true).ok, true);
  assert.equal(validateSettingValue('budget_tolerance_pct', 'numeric', '-1', true).ok, false);
  assert.equal(validateSettingValue('budget_tolerance_pct', 'numeric', '101', true).ok, false);
});

test('validateSettingValue: non-numeric text for a numeric key is rejected', () => {
  assert.equal(validateSettingValue('budget_tolerance_pct', 'numeric', 'not-a-number', true).ok, false);
});

test('validateSettingValue: "enabled" must be a real boolean, not a string', () => {
  const result = validateSettingValue('event_dedup_enabled', 'boolean', 'true', 'true');
  assert.equal(result.ok, false);
});

test('validateSettingValue: location key is rejected even before type checking', () => {
  const result = validateSettingValue('location_enabled', 'boolean', 'true', true);
  assert.equal(result.ok, false);
  assert.match(result.error, /location/i);
});

test('validateRegexSyntax: a valid pattern is accepted', () => {
  assert.equal(validateRegexSyntax('\\bneed\\b').ok, true);
});

test('validateRegexSyntax: an invalid pattern (unterminated group) is rejected, never executed', () => {
  const result = validateRegexSyntax('(unterminated');
  assert.equal(result.ok, false);
  assert.match(result.error, /regular expression/i);
});

test('validateRule: rejects an invalid rule_group', () => {
  const result = validateRule({ rule_group: 'NOT_REAL', match_type: 'PHRASE', pattern: 'x' });
  assert.equal(result.ok, false);
});

test('validateRule: rejects an invalid match_type', () => {
  const result = validateRule({ rule_group: 'BLACKLIST', match_type: 'FUZZY', pattern: 'x' });
  assert.equal(result.ok, false);
});

test('validateRule: rejects an empty pattern', () => {
  assert.equal(validateRule({ rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: '' }).ok, false);
  assert.equal(validateRule({ rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: '   ' }).ok, false);
});

test('validateRule: rejects an invalid regex pattern for match_type=REGEX, but the same text is fine as PHRASE', () => {
  assert.equal(validateRule({ rule_group: 'BLACKLIST', match_type: 'REGEX', pattern: '(bad' }).ok, false);
  assert.equal(validateRule({ rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: '(bad' }).ok, true);
});

test('validateRule: accepts a valid PHRASE and a valid REGEX rule', () => {
  assert.equal(validateRule({ rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'looking for' }).ok, true);
  assert.equal(validateRule({ rule_group: 'WHITELIST', match_type: 'REGEX', pattern: '\\blooking\\s+for\\b' }).ok, true);
});
