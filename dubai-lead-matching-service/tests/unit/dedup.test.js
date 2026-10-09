'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeDedupKey } = require('../../src/gates/dedup');

test('same author + same text hashes identically', () => {
  const a = computeDedupKey({ original_text: 'Need 2BR in Business Bay', author_name: 'John' });
  const b = computeDedupKey({ original_text: 'Need 2BR in Business Bay', author_name: 'John' });
  assert.equal(a, b);
});

test('a different author with the same text hashes differently', () => {
  const a = computeDedupKey({ original_text: 'Need 2BR in Business Bay', author_name: 'John' });
  const b = computeDedupKey({ original_text: 'Need 2BR in Business Bay', author_name: 'Jane' });
  assert.notEqual(a, b);
});

test('a materially different message hashes differently', () => {
  const a = computeDedupKey({ original_text: 'Need 2BR in Business Bay', author_name: 'John' });
  const b = computeDedupKey({ original_text: 'Need 3BR in Dubai Marina', author_name: 'John' });
  assert.notEqual(a, b);
});

test('P1.5 RELEASE BLOCKER: sender_id is preferred over display name -- two different people sharing a display name never collide', () => {
  const a = computeDedupKey({ provider: 'telegram', original_text: 'Need 2BR in Business Bay', author_name: 'Ahmed', sender_id: '1001' });
  const b = computeDedupKey({ provider: 'telegram', original_text: 'Need 2BR in Business Bay', author_name: 'Ahmed', sender_id: '2002' });
  assert.notEqual(a, b, 'two distinct sender_ids sharing a display name must not be treated as the same requester');
});

test('P1.5: the SAME sender_id hashes identically even if their display name changed between posts', () => {
  const a = computeDedupKey({ provider: 'telegram', original_text: 'Need 2BR in Business Bay', author_name: 'Ahmed K.', sender_id: '1001' });
  const b = computeDedupKey({ provider: 'telegram', original_text: 'Need 2BR in Business Bay', author_name: 'Ahmed 🏠', sender_id: '1001' });
  assert.equal(a, b, 'a real display-name change must not defeat dedup once a stable sender_id is available');
});

test('P1.5: falls back to author_name only when no stable identity is available at all', () => {
  const a = computeDedupKey({ provider: 'telegram', original_text: 'Need 2BR in Business Bay', author_name: 'John', sender_id: null, sender_id_alt: null, author_contact: null });
  const b = computeDedupKey({ provider: 'telegram', original_text: 'Need 2BR in Business Bay', author_name: 'John', sender_id: null, sender_id_alt: null, author_contact: null });
  assert.equal(a, b);
});

test('CONFIRMED LIVE INCIDENT (2026-09-25): account_id is NOT part of the identity -- the same sender_id on two different monitoring accounts is the same requester', () => {
  // Before this fix, this wrongly did not collide: a Telegram sender_id
  // is globally unique on Telegram regardless of which of OUR accounts
  // observed them post, so including account_id fractured one real
  // buyer's identity depending on which of our accounts happened to see
  // them -- exactly backwards from this gate's job of catching the same
  // buyer's request cross-posted to several groups. See event-dedup.js's
  // computeEventKey for the paired event-level symptom from the same
  // incident (matching_dubai.processed_events ids 17585/17588).
  const a = computeDedupKey({ provider: 'telegram', account_id: 'tg_main', original_text: 'Need 2BR in Business Bay', sender_id: '1001' });
  const b = computeDedupKey({ provider: 'telegram', account_id: 'tg_sales_1', original_text: 'Need 2BR in Business Bay', sender_id: '1001' });
  assert.equal(a, b);
});

test('provider still distinguishes identity -- the same raw sender_id value on a different provider is a different person (different ID namespace)', () => {
  const a = computeDedupKey({ provider: 'telegram', original_text: 'Need 2BR in Business Bay', sender_id: '1001' });
  const b = computeDedupKey({ provider: 'whatsapp', original_text: 'Need 2BR in Business Bay', sender_id: '1001' });
  assert.notEqual(a, b);
});
