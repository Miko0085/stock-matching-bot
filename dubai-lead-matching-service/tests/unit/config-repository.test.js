'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coerceSettingValue, diffConfigVersions } = require('../../src/repositories/config-repository');

test('coerceSettingValue: boolean "true"/"false" strings coerce to real booleans', () => {
  assert.equal(coerceSettingValue('boolean', 'true'), true);
  assert.equal(coerceSettingValue('boolean', 'false'), false);
});

test('coerceSettingValue: integer parses whole numbers, ignores decimals', () => {
  assert.equal(coerceSettingValue('integer', '10'), 10);
  assert.equal(coerceSettingValue('integer', 'not-a-number'), null);
});

test('coerceSettingValue: numeric parses decimals', () => {
  assert.equal(coerceSettingValue('numeric', '10.5'), 10.5);
  assert.equal(coerceSettingValue('numeric', 'not-a-number'), null);
});

test('coerceSettingValue: text passes through unchanged', () => {
  assert.equal(coerceSettingValue('text', 'hello'), 'hello');
});

test('coerceSettingValue: null/undefined value_text is always null, regardless of type', () => {
  assert.equal(coerceSettingValue('boolean', null), null);
  assert.equal(coerceSettingValue('integer', undefined), null);
});

test('coerceSettingValue: an unrecognized value_type falls back to raw text (defensive, never throws)', () => {
  assert.equal(coerceSettingValue('unknown_type', 'raw'), 'raw');
});

// Phase 2 (spec section 4): "settings changed, rules added, rules removed,
// rules enabled/disabled" -- diffConfigVersions() is a pure function so
// this is fully testable without a database.
function snap(settings, rules) {
  return { runtime_settings: settings, intake_rules: rules };
}

test('diffConfigVersions: detects a changed setting value', () => {
  const oldSnap = snap([{ key: 'budget_tolerance_pct', value_type: 'numeric', value_text: '10', enabled: true }], []);
  const newSnap = snap([{ key: 'budget_tolerance_pct', value_type: 'numeric', value_text: '15', enabled: true }], []);
  const diff = diffConfigVersions(oldSnap, newSnap);
  assert.equal(diff.settingsChanged.length, 1);
  assert.equal(diff.settingsChanged[0].key, 'budget_tolerance_pct');
});

test('diffConfigVersions: an unchanged setting produces no diff entry', () => {
  const s = { key: 'budget_tolerance_pct', value_type: 'numeric', value_text: '10', enabled: true };
  const diff = diffConfigVersions(snap([s], []), snap([{ ...s }], []));
  assert.deepEqual(diff.settingsChanged, []);
});

test('diffConfigVersions: rules are matched by content (rule_group+match_type+pattern), not by id', () => {
  const rule = { rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'looking for', enabled: true, priority: 100, description: null };
  const diff = diffConfigVersions(snap([], [rule]), snap([], [{ ...rule }]));
  assert.deepEqual(diff.rulesAdded, []);
  assert.deepEqual(diff.rulesRemoved, []);
  assert.deepEqual(diff.rulesToggled, []);
});

test('diffConfigVersions: detects an added rule', () => {
  const rule = { rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true, priority: 100, description: null };
  const diff = diffConfigVersions(snap([], []), snap([], [rule]));
  assert.equal(diff.rulesAdded.length, 1);
  assert.equal(diff.rulesAdded[0].pattern, 'сдам');
});

test('diffConfigVersions: detects a removed rule', () => {
  const rule = { rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам', enabled: true, priority: 100, description: null };
  const diff = diffConfigVersions(snap([], [rule]), snap([], []));
  assert.equal(diff.rulesRemoved.length, 1);
});

test('diffConfigVersions: detects a rule being enabled/disabled without treating it as added+removed', () => {
  const before = { rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу', enabled: true, priority: 100, description: null };
  const after = { ...before, enabled: false };
  const diff = diffConfigVersions(snap([], [before]), snap([], [after]));
  assert.equal(diff.rulesToggled.length, 1);
  assert.deepEqual(diff.rulesAdded, []);
  assert.deepEqual(diff.rulesRemoved, []);
});
