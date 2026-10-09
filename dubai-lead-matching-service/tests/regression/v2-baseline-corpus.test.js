'use strict';

// Nika Matching V2 refactor — Phase 0 characterization tests
// (AGENTS_NIKA_MATCHING_V2.md, section 26, Phase 0).
//
// These tests do NOT assert desired/target behavior -- they lock in the
// ACTUAL, currently-observed behavior of the deterministic triage gate for
// a real regression corpus (tests/fixtures/*.json), so that later phases
// (1-18 of the V2 simplification) can prove they didn't silently change
// buyer-classification behavior along the way. If a later phase changes
// this file's expectations, that change must be a deliberate, reviewed
// part of that phase's plan -- never an accidental side effect.
//
// Each fixture here documents which real, previously-audited scenario it
// represents (see docs/MATCHING_V2_REFACTOR_BASELINE.md for the full
// provenance) -- text is a faithful reconstruction of the verified
// scenario's criteria (locations/bedrooms/budget/transaction), not a
// byte-for-byte copy of a real customer's message (which would mean
// committing real buyer PII into the repo).
//
// No OpenAI call is made anywhere in this file -- evaluateTriage() is a
// pure, deterministic function; AI_REVIEW here means "would be sent to AI"
// in production, not that AI actually ran.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { evaluateTriage } = require('../../src/gates/triage');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));
}

const CASES = [
  {
    fixture: 'telegram-multi-area-cash-buyer.json',
    provenance: 'Reconstructs the live forensic audit "Case 01" (3-4BR, Tilal Al Furjan / Jabal Ali Village / Nad Al Sheba Gardens, budget <=6M, cash) -- the case that first surfaced the multi-area OR-resolution gap.',
    expectedDecision: 'AI_REVIEW',
    expectedReason: 'insufficient_local_signal',
  },
  {
    fixture: 'telegram-multi-area-dso-warsan.json',
    provenance: 'Reconstructs the live forensic audit "Case 02" (DSO / Warsan / Al Furjan / Bur Dubai, budget <=100M).',
    expectedDecision: 'AI_REVIEW',
    expectedReason: 'insufficient_local_signal',
  },
  {
    fixture: 'telegram-rent-request.json',
    provenance: 'RENT request using the real stock vocabulary (RENT_YEARLY/annual_rent) -- the P0 release-blocker fixed in commit 40acb80.',
    expectedDecision: 'AI_REVIEW',
    expectedReason: 'insufficient_local_signal',
  },
  {
    fixture: 'telegram-comma-thousands-sqft.json',
    provenance: 'Comma-grouped sqft figure ("1,100 sqft") -- the detectNumericRange truncation bug fixed in commit 40acb80.',
    expectedDecision: 'AI_REVIEW',
    expectedReason: 'insufficient_local_signal',
  },
  {
    fixture: 'telegram-russian-seller-offer.json',
    provenance: 'Russian seller-side offer ("Сдам"/"от собственника") -- the seller-vs-buyer direction bug (and the underlying Cyrillic \\b regex bug) fixed in commit 40acb80.',
    expectedDecision: 'REJECT',
    expectedReason: 'single_listing_inventory_ad',
  },
];

for (const { fixture, provenance, expectedDecision, expectedReason } of CASES) {
  test(`V2 baseline corpus: ${fixture} -- ${provenance}`, () => {
    const payload = loadFixture(fixture);
    const result = evaluateTriage(payload.text, { aliasIndex: {} });
    assert.equal(result.decision, expectedDecision);
    assert.equal(result.reason, expectedReason);
  });
}
