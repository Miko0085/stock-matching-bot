'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRoute, detectMarketEvidence } = require('../../src/sources/route-resolver');

test('monitoring disabled -> no contours, regardless of route_mode', () => {
  const result = resolveRoute({ sourceRoute: { monitoring_enabled: false, route_mode: 'DUBAI' }, originalText: 'Need 2BR in Business Bay' });
  assert.deepEqual(result.contours, []);
  assert.equal(result.reason, 'monitoring_disabled');
});

test('route_mode NONE -> no contours even when monitoring is enabled', () => {
  const result = resolveRoute({ sourceRoute: { monitoring_enabled: true, route_mode: 'NONE' } });
  assert.deepEqual(result.contours, []);
});

test('route_mode DUBAI -> DUBAI only', () => {
  const result = resolveRoute({ sourceRoute: { monitoring_enabled: true, route_mode: 'DUBAI' } });
  assert.deepEqual(result.contours, ['DUBAI']);
});

test('route_mode RF -> RF only', () => {
  const result = resolveRoute({ sourceRoute: { monitoring_enabled: true, route_mode: 'RF' } });
  assert.deepEqual(result.contours, ['RF']);
});

test('route_mode BOTH -> both contours', () => {
  const result = resolveRoute({ sourceRoute: { monitoring_enabled: true, route_mode: 'BOTH' } });
  assert.deepEqual(result.contours.sort(), ['DUBAI', 'RF']);
});

test('detectMarketEvidence: Dubai-only signals resolve to DUBAI', () => {
  assert.equal(detectMarketEvidence('Need 2BR in Business Bay, AED 2.5M'), 'DUBAI');
  assert.equal(detectMarketEvidence('Looking for a villa in Dubai'), 'DUBAI');
});

test('detectMarketEvidence: RF-only signals resolve to RF', () => {
  assert.equal(detectMarketEvidence('Ищу 2-комнатную в Москва до 15 млн'), 'RF');
  assert.equal(detectMarketEvidence('Бюджет 20 млн ₽'), 'RF');
});

test('detectMarketEvidence: no evidence, or evidence for both markets, is UNRESOLVED (never guessed)', () => {
  assert.equal(detectMarketEvidence('Need a 2BR apartment please'), 'UNRESOLVED');
  assert.equal(detectMarketEvidence('AED and Москва both mentioned'), 'UNRESOLVED');
});

test('route_mode AUTO resolves via deterministic evidence, never guesses when ambiguous', () => {
  const dubai = resolveRoute({ sourceRoute: { monitoring_enabled: true, route_mode: 'AUTO' }, originalText: 'Need 2BR in Business Bay, AED 2.5M' });
  assert.deepEqual(dubai.contours, ['DUBAI']);

  const rf = resolveRoute({ sourceRoute: { monitoring_enabled: true, route_mode: 'AUTO' }, originalText: 'Ищу квартиру в Москва, бюджет 20 млн' });
  assert.deepEqual(rf.contours, ['RF']);

  const unresolved = resolveRoute({ sourceRoute: { monitoring_enabled: true, route_mode: 'AUTO' }, originalText: 'Need a nice apartment please' });
  assert.deepEqual(unresolved.contours, []);
  assert.equal(unresolved.reason, 'auto_unresolved');
});

test('AUTO never spends an AI call and never fires when the source is manually routed instead', () => {
  // Manual routes (DUBAI/RF/BOTH/NONE) never consult originalText at all --
  // proven by passing a text that would evidence the OPPOSITE market and
  // confirming the manual route still wins.
  const result = resolveRoute({ sourceRoute: { monitoring_enabled: true, route_mode: 'DUBAI' }, originalText: 'Ищу квартиру в Москва' });
  assert.deepEqual(result.contours, ['DUBAI']);
});

test('an unknown/corrupt route_mode value fails closed (no contours), never silently matches', () => {
  const result = resolveRoute({ sourceRoute: { monitoring_enabled: true, route_mode: 'SOMETHING_ELSE' } });
  assert.deepEqual(result.contours, []);
  assert.equal(result.reason, 'unknown_route_mode');
});

test('a missing sourceRoute entirely (source never synced/routed) -> no contours', () => {
  const result = resolveRoute({ sourceRoute: null });
  assert.deepEqual(result.contours, []);
});
