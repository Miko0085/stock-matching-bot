'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateV2IntakeGate, findHits, ruleMatches, REASONS } = require('../../src/gates/v2-intake-gate');

function rule(overrides) {
  return { id: 1, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'need', enabled: true, priority: 100, ...overrides };
}

function settings({ whitelist = 1, propertySignal = 1, policy } = {}) {
  return {
    whitelist_threshold: { value: whitelist, enabled: true },
    property_signal_threshold: { value: propertySignal, enabled: true },
    ...(policy ? { buyer_signal_policy: { value: policy, enabled: true } } : {}),
  };
}

test('BLACKLIST hit -> REJECT / BLACKLIST, regardless of any other rule that also matches', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'Selling a 2BR in Marina, DM me for details' },
    runtimeSettings: settings(),
    intakeRules: {
      BLACKLIST: [rule({ rule_group: 'BLACKLIST', pattern: 'selling' })],
      WHITELIST: [rule({ pattern: 'need' })],
      PROPERTY_SIGNAL: [],
      SEND_TO_AI: [],
    },
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, REASONS.BLACKLIST);
  assert.equal(result.blacklist_hits.length, 1);
});

test('explicit SEND_TO_AI rule hit -> SEND_TO_AI / SEND_TO_AI_RULE, even with zero whitelist/property signal', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'unclear message that matches nothing else' },
    runtimeSettings: settings(),
    intakeRules: {
      BLACKLIST: [],
      WHITELIST: [],
      PROPERTY_SIGNAL: [],
      SEND_TO_AI: [rule({ rule_group: 'SEND_TO_AI', pattern: 'matches nothing else' })],
    },
  });
  assert.equal(result.decision, 'SEND_TO_AI');
  assert.equal(result.reason, REASONS.SEND_TO_AI_RULE);
  assert.equal(result.send_to_ai_hits.length, 1);
});

test('SEND_TO_AI rule takes precedence over an ordinary whitelist+property-signal match', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'I need a 2BR apartment' },
    runtimeSettings: settings(),
    intakeRules: {
      BLACKLIST: [],
      WHITELIST: [rule({ pattern: 'need' })],
      PROPERTY_SIGNAL: [rule({ rule_group: 'PROPERTY_SIGNAL', pattern: '2br' })],
      SEND_TO_AI: [rule({ rule_group: 'SEND_TO_AI', pattern: 'apartment' })],
    },
  });
  assert.equal(result.decision, 'SEND_TO_AI');
  assert.equal(result.reason, REASONS.SEND_TO_AI_RULE);
});

test('BLACKLIST takes precedence over an ordinary positive (whitelist/property-signal) match', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'I need a 2BR apartment, broker solicitation' },
    runtimeSettings: settings(),
    intakeRules: {
      BLACKLIST: [rule({ rule_group: 'BLACKLIST', pattern: 'broker solicitation' })],
      WHITELIST: [rule({ pattern: 'need' })],
      PROPERTY_SIGNAL: [rule({ rule_group: 'PROPERTY_SIGNAL', pattern: '2br' })],
      SEND_TO_AI: [],
    },
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, REASONS.BLACKLIST);
});

test('whitelist threshold met AND property-signal threshold met -> SEND_TO_AI / WHITELIST_AND_PROPERTY_SIGNAL', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'I need a 2BR apartment' },
    runtimeSettings: settings(),
    intakeRules: {
      BLACKLIST: [],
      WHITELIST: [rule({ pattern: 'need' })],
      PROPERTY_SIGNAL: [rule({ rule_group: 'PROPERTY_SIGNAL', pattern: '2br' })],
      SEND_TO_AI: [],
    },
  });
  assert.equal(result.decision, 'SEND_TO_AI');
  assert.equal(result.reason, REASONS.WHITELIST_AND_PROPERTY_SIGNAL);
  assert.equal(result.whitelist_hits.length, 1);
  assert.equal(result.property_signal_hits.length, 1);
});

test('whitelist hit only (no property signal) -> REJECT / INSUFFICIENT_BUYER_SIGNAL', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'I need something nice' },
    runtimeSettings: settings(),
    intakeRules: {
      BLACKLIST: [],
      WHITELIST: [rule({ pattern: 'need' })],
      PROPERTY_SIGNAL: [rule({ rule_group: 'PROPERTY_SIGNAL', pattern: '2br' })],
      SEND_TO_AI: [],
    },
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, REASONS.INSUFFICIENT_BUYER_SIGNAL);
  assert.equal(result.whitelist_hits.length, 1);
  assert.equal(result.property_signal_hits.length, 0);
});

test('property-signal hit only (no whitelist) -> REJECT / INSUFFICIENT_BUYER_SIGNAL', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'a 2BR unit' },
    runtimeSettings: settings(),
    intakeRules: {
      BLACKLIST: [],
      WHITELIST: [rule({ pattern: 'need' })],
      PROPERTY_SIGNAL: [rule({ rule_group: 'PROPERTY_SIGNAL', pattern: '2br' })],
      SEND_TO_AI: [],
    },
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, REASONS.INSUFFICIENT_BUYER_SIGNAL);
  assert.equal(result.whitelist_hits.length, 0);
  assert.equal(result.property_signal_hits.length, 1);
});

test('neither whitelist nor property signal -> REJECT / INSUFFICIENT_BUYER_SIGNAL', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'hello there' },
    runtimeSettings: settings(),
    intakeRules: { BLACKLIST: [], WHITELIST: [rule({ pattern: 'need' })], PROPERTY_SIGNAL: [rule({ rule_group: 'PROPERTY_SIGNAL', pattern: '2br' })], SEND_TO_AI: [] },
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, REASONS.INSUFFICIENT_BUYER_SIGNAL);
});

test('multiple whitelist hits are all reported, not just the first', () => {
  const hits = findHits(
    [rule({ pattern: 'need' }), rule({ id: 2, pattern: 'looking for' }), rule({ id: 3, pattern: 'no match here' })],
    'I need something, looking for a place'
  );
  assert.equal(hits.length, 2);
});

test('multiple property-signal hits are all reported', () => {
  const hits = findHits(
    [rule({ id: 1, rule_group: 'PROPERTY_SIGNAL', pattern: '2br' }), rule({ id: 2, rule_group: 'PROPERTY_SIGNAL', pattern: 'apartment' })],
    'a 2br apartment'
  );
  assert.equal(hits.length, 2);
});

test('PHRASE matching is case-insensitive', () => {
  assert.equal(ruleMatches(rule({ match_type: 'PHRASE', pattern: 'Need' }), 'i need a place', 'I NEED a place'), true);
  assert.equal(ruleMatches(rule({ match_type: 'PHRASE', pattern: 'NEED' }), 'i need a place', 'i need a place'), true);
});

test('REGEX matching works against the ORIGINAL (unlowered) text via the "i" flag', () => {
  assert.equal(ruleMatches(rule({ match_type: 'REGEX', pattern: '\\bneed(?:s|ed)?\\b' }), 'i needed a place', 'I needed a place'), true);
  assert.equal(ruleMatches(rule({ match_type: 'REGEX', pattern: '\\bneed(?:s|ed)?\\b' }), 'no match', 'no match'), false);
});

test('a malformed regex fails safe: never matches, never throws', () => {
  assert.doesNotThrow(() => {
    const result = ruleMatches(rule({ match_type: 'REGEX', pattern: '(unterminated[' }), 'anything', 'anything');
    assert.equal(result, false);
  });
});

test('a disabled rule is ignored entirely, even if its pattern would otherwise match', () => {
  const hits = findHits([rule({ pattern: 'need', enabled: false })], 'i need a place');
  assert.equal(hits.length, 0);
});

test('priority does not change correctness -- multiple same-group rules at different priorities all still count as hits', () => {
  const hits = findHits(
    [rule({ id: 1, pattern: 'need', priority: 1 }), rule({ id: 2, pattern: 'looking for', priority: 999 })],
    'i need it, looking for it'
  );
  assert.equal(hits.length, 2);
});

test('sourceContext.disabled -> REJECT / SOURCE_DISABLED before any rule matching happens', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'I need a 2BR apartment' },
    sourceContext: { disabled: true },
    runtimeSettings: settings(),
    intakeRules: {
      BLACKLIST: [],
      WHITELIST: [rule({ pattern: 'need' })],
      PROPERTY_SIGNAL: [rule({ rule_group: 'PROPERTY_SIGNAL', pattern: '2br' })],
      SEND_TO_AI: [],
    },
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, REASONS.SOURCE_DISABLED);
  assert.equal(result.whitelist_hits.length, 0);
});

test('thresholds above 1 require multiple distinct hits', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'I need a 2BR apartment' },
    runtimeSettings: settings({ whitelist: 2, propertySignal: 1 }),
    intakeRules: {
      BLACKLIST: [],
      WHITELIST: [rule({ pattern: 'need' })],
      PROPERTY_SIGNAL: [rule({ rule_group: 'PROPERTY_SIGNAL', pattern: '2br' })],
      SEND_TO_AI: [],
    },
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, REASONS.INSUFFICIENT_BUYER_SIGNAL);
});

test('missing runtimeSettings thresholds default to 1/1', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'I need a 2BR apartment' },
    runtimeSettings: {},
    intakeRules: {
      BLACKLIST: [],
      WHITELIST: [rule({ pattern: 'need' })],
      PROPERTY_SIGNAL: [rule({ rule_group: 'PROPERTY_SIGNAL', pattern: '2br' })],
      SEND_TO_AI: [],
    },
  });
  assert.equal(result.decision, 'SEND_TO_AI');
  assert.deepEqual(result.thresholds, { whitelist: 1, property_signal: 1 });
});

// ---------------------------------------------------------------------
// Phase 4 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase 4, requirement
// 15.A): buyer_signal_policy combination logic.
// ---------------------------------------------------------------------

const rulesWith = (whitelist, propertySignal) => ({
  BLACKLIST: [],
  WHITELIST: whitelist ? [rule({ pattern: 'need' })] : [],
  PROPERTY_SIGNAL: propertySignal ? [rule({ rule_group: 'PROPERTY_SIGNAL', pattern: '2br' })] : [],
  SEND_TO_AI: [],
});

test('REQUIRE_BOTH: whitelist only -> REJECT', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'i need something' },
    runtimeSettings: settings({ policy: 'REQUIRE_BOTH' }),
    intakeRules: rulesWith(true, false),
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, REASONS.INSUFFICIENT_BUYER_SIGNAL);
});

test('REQUIRE_BOTH: property signal only -> REJECT', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'a 2br place' },
    runtimeSettings: settings({ policy: 'REQUIRE_BOTH' }),
    intakeRules: rulesWith(false, true),
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, REASONS.INSUFFICIENT_BUYER_SIGNAL);
});

test('REQUIRE_BOTH: both -> SEND_TO_AI / WHITELIST_AND_PROPERTY_SIGNAL', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'i need a 2br place' },
    runtimeSettings: settings({ policy: 'REQUIRE_BOTH' }),
    intakeRules: rulesWith(true, true),
  });
  assert.equal(result.decision, 'SEND_TO_AI');
  assert.equal(result.reason, REASONS.WHITELIST_AND_PROPERTY_SIGNAL);
});

test('REQUIRE_ANY: whitelist only -> SEND_TO_AI / WHITELIST_OR_PROPERTY_SIGNAL', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'i need something' },
    runtimeSettings: settings({ policy: 'REQUIRE_ANY' }),
    intakeRules: rulesWith(true, false),
  });
  assert.equal(result.decision, 'SEND_TO_AI');
  assert.equal(result.reason, REASONS.WHITELIST_OR_PROPERTY_SIGNAL);
});

test('REQUIRE_ANY: property signal only -> SEND_TO_AI / WHITELIST_OR_PROPERTY_SIGNAL', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'a 2br place' },
    runtimeSettings: settings({ policy: 'REQUIRE_ANY' }),
    intakeRules: rulesWith(false, true),
  });
  assert.equal(result.decision, 'SEND_TO_AI');
  assert.equal(result.reason, REASONS.WHITELIST_OR_PROPERTY_SIGNAL);
});

test('REQUIRE_ANY: both -> SEND_TO_AI', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'i need a 2br place' },
    runtimeSettings: settings({ policy: 'REQUIRE_ANY' }),
    intakeRules: rulesWith(true, true),
  });
  assert.equal(result.decision, 'SEND_TO_AI');
  assert.equal(result.reason, REASONS.WHITELIST_OR_PROPERTY_SIGNAL);
});

test('REQUIRE_ANY: neither -> REJECT', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'hello there' },
    runtimeSettings: settings({ policy: 'REQUIRE_ANY' }),
    intakeRules: rulesWith(true, true), // rules configured, but text matches neither
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, REASONS.INSUFFICIENT_BUYER_SIGNAL);
});

test('missing buyer_signal_policy defaults to REQUIRE_BOTH (backward compatible with pre-Phase-4 config)', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'i need something' },
    runtimeSettings: settings({}), // no policy key at all
    intakeRules: rulesWith(true, false),
  });
  assert.equal(result.decision, 'REJECT', 'no policy set -> falls back to the original AND behavior, not the permissive OR');
});

test('an unrecognized buyer_signal_policy throws (fail-safe: the CALLER must fall back to legacy, never silently guess AND or OR)', () => {
  assert.throws(() => {
    evaluateV2IntakeGate({
      message: { text: 'i need a 2br place' },
      runtimeSettings: settings({ policy: 'SOMETHING_ELSE' }),
      intakeRules: rulesWith(true, true),
    });
  }, /unrecognized buyer_signal_policy/);
});

test('BLACKLIST still takes precedence under REQUIRE_ANY (precedence is policy-independent)', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'i need a 2br place, broker solicitation' },
    runtimeSettings: settings({ policy: 'REQUIRE_ANY' }),
    intakeRules: {
      BLACKLIST: [rule({ rule_group: 'BLACKLIST', pattern: 'broker solicitation' })],
      WHITELIST: [rule({ pattern: 'need' })],
      PROPERTY_SIGNAL: [rule({ rule_group: 'PROPERTY_SIGNAL', pattern: '2br' })],
      SEND_TO_AI: [],
    },
  });
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason, REASONS.BLACKLIST);
});

test('explicit SEND_TO_AI rule still takes precedence under REQUIRE_ANY', () => {
  const result = evaluateV2IntakeGate({
    message: { text: 'unrelated text matching an explicit exception rule' },
    runtimeSettings: settings({ policy: 'REQUIRE_ANY' }),
    intakeRules: {
      BLACKLIST: [],
      WHITELIST: [],
      PROPERTY_SIGNAL: [],
      SEND_TO_AI: [rule({ rule_group: 'SEND_TO_AI', pattern: 'explicit exception' })],
    },
  });
  assert.equal(result.decision, 'SEND_TO_AI');
  assert.equal(result.reason, REASONS.SEND_TO_AI_RULE);
});
