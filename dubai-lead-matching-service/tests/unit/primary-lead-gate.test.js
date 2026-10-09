'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePrimaryLeadGate } = require('../../src/gates/primary-lead-gate');

test('empty text is rejected without reaching AI', () => {
  const result = evaluatePrimaryLeadGate('');
  assert.equal(result.passed, false);
  assert.equal(result.decision, 'rejected');
  assert.equal(result.reason, 'empty_text');
});

test('obviously non-property junk (roommate wanted) is rejected', () => {
  const result = evaluatePrimaryLeadGate('Looking for a roommate to share my apartment in JVC');
  assert.equal(result.passed, false);
  assert.equal(result.reason, 'non_property_request');
});

test('obviously non-property junk (nail salon, Russian) is rejected', () => {
  const result = evaluatePrimaryLeadGate('Ищу мастера по ногтям срочно');
  assert.equal(result.passed, false);
  assert.equal(result.reason, 'non_property_request');
});

test('TZ 91: a bare area name reaches AI review -- the gate does not require a property keyword', () => {
  // Real regression requirement: "Business Bay" alone must reach the
  // matcher's INSUFFICIENT_CRITERIA gate, not be rejected earlier here for
  // lacking a property-domain keyword (TZ 15/18/91).
  const result = evaluatePrimaryLeadGate('Business Bay');
  assert.equal(result.passed, true);
  assert.equal(result.decision, 'review_with_ai');
});

test('TZ 16/28: the gate never itself accepts/rejects based on buyer-sounding keywords -- it passes everything on to AI except obvious junk', () => {
  // The regex-only fix belongs at the AI layer (demand_owner); this gate
  // must not attempt the direction judgment itself.
  const emaarAd =
    'Have a client looking to buy? Send us your client\'s requirements. 500+ units for Sale & Rent. Agents welcome, commission is yours.';
  const result = evaluatePrimaryLeadGate(emaarAd);
  assert.equal(result.passed, true);
  assert.equal(result.decision, 'review_with_ai');
});

test('a genuine buyer request passes through to AI review', () => {
  const result = evaluatePrimaryLeadGate('My client is looking for a 2BR in Business Bay, budget up to AED 2.5M.');
  assert.equal(result.passed, true);
  assert.equal(result.decision, 'review_with_ai');
  assert.ok(result.positive_signals.includes('property_domain_keyword'));
});
