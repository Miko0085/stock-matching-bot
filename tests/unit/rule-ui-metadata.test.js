'use strict';

// Settings UI simplification (2026-09-27) -- rule-ui-metadata.js is a pure
// presentation-layer mapping (pattern/group -> friendly label). These tests
// only cover label lookup and fallback behavior; they never assert on or
// touch backend enum values, thresholds, or gate logic.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ruleUi = require('../../dashboard/rule-ui-metadata');

test('getRuleGroupUi: known backend enums (BLACKLIST/WHITELIST/PROPERTY_SIGNAL/SEND_TO_AI) all resolve to a friendly title', () => {
  for (const group of ['BLACKLIST', 'WHITELIST', 'PROPERTY_SIGNAL', 'SEND_TO_AI']) {
    const ui = ruleUi.getRuleGroupUi(group);
    assert.ok(ui.title && ui.title.length > 0, `expected a friendly title for ${group}`);
    assert.ok(ui.explanation && ui.explanation.length > 0, `expected an explanation for ${group}`);
  }
});

test('getRuleGroupUi: an unknown group never throws, falls back to the raw group name', () => {
  const ui = ruleUi.getRuleGroupUi('SOME_FUTURE_GROUP');
  assert.equal(ui.title, 'SOME_FUTURE_GROUP');
  assert.equal(ui.explanation, '');
});

test('getBuyerSignalPolicyUi: REQUIRE_ANY and REQUIRE_BOTH both resolve to a friendly label distinct from the backend enum', () => {
  const any = ruleUi.getBuyerSignalPolicyUi('REQUIRE_ANY');
  const both = ruleUi.getBuyerSignalPolicyUi('REQUIRE_BOTH');
  assert.notEqual(any.label, 'REQUIRE_ANY');
  assert.notEqual(both.label, 'REQUIRE_BOTH');
  assert.notEqual(any.label, both.label);
});

test('getRuleFriendlyName: a real seeded pattern (exact string from production matching_dubai.intake_rules) resolves to a human name', () => {
  const rule = { pattern: '\\blooking\\s+for\\b', description: null };
  assert.equal(ruleUi.getRuleFriendlyName(rule), 'Ищу (looking for)');
});

test('getRuleFriendlyName: an unmapped pattern falls back to the rule\'s own description', () => {
  const rule = { pattern: '\\bsome-new-pattern\\b', description: 'triage.js NEW_PATTERN' };
  assert.equal(ruleUi.getRuleFriendlyName(rule), 'triage.js NEW_PATTERN');
});

test('getRuleFriendlyName: an unmapped pattern with no description falls back to the raw pattern itself -- never blank, never throws', () => {
  const rule = { pattern: '\\bsome-new-pattern\\b', description: null };
  assert.equal(ruleUi.getRuleFriendlyName(rule), '\\bsome-new-pattern\\b');
});

test('getRuleFriendlyDescription / getRuleExample: a mapped pattern returns both; an unmapped one returns the DB description / null respectively', () => {
  const mapped = { pattern: '\\baed\\b', description: null };
  assert.match(ruleUi.getRuleFriendlyDescription(mapped), /дирхам/i);
  assert.match(ruleUi.getRuleExample(mapped), /AED/);

  const unmapped = { pattern: '\\bunmapped\\b', description: 'raw db description' };
  assert.equal(ruleUi.getRuleFriendlyDescription(unmapped), 'raw db description');
  assert.equal(ruleUi.getRuleExample(unmapped), null);
});

// This is the actual mapping module -- verify it never accidentally
// redefines a backend enum value anywhere (the whole point of this file is
// to stay presentation-only).
test('RULE_GROUP_UI / BUYER_SIGNAL_POLICY_UI never re-export a backend enum as a key with a DIFFERENT backend-facing value', () => {
  assert.deepEqual(Object.keys(ruleUi.RULE_GROUP_UI).sort(), ['BLACKLIST', 'PROPERTY_SIGNAL', 'SEND_TO_AI', 'WHITELIST']);
  assert.deepEqual(Object.keys(ruleUi.BUYER_SIGNAL_POLICY_UI).sort(), ['REQUIRE_ANY', 'REQUIRE_BOTH']);
});
