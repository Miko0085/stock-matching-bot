'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeEventKey } = require('../../src/gates/event-dedup');

test('computeEventKey: same provider/account/chat/message -> identical key', () => {
  const a = { provider: 'telegram', account_id: 'tg_main', chat_id: '-100123', external_message_id: '55' };
  const b = { provider: 'telegram', account_id: 'tg_main', chat_id: '-100123', external_message_id: '55' };
  assert.equal(computeEventKey(a), computeEventKey(b));
});

test('computeEventKey: a different chat_id is a different event, even with the same message_id', () => {
  const a = { provider: 'telegram', account_id: 'tg_main', chat_id: '-100123', external_message_id: '55' };
  const b = { provider: 'telegram', account_id: 'tg_main', chat_id: '-100999', external_message_id: '55' };
  assert.notEqual(computeEventKey(a), computeEventKey(b));
});

test('CONFIRMED LIVE INCIDENT (2026-09-25): a different account_id is the SAME event when chat_id/message_id agree -- two of our own accounts monitoring the same group must not reprocess the same physical message', () => {
  // Before this fix, this collided: nikaestate_ae joined groups tg_main
  // already monitored, and one buyer message became two independent
  // events (two OpenAI calls, two duplicate Telegram notifications --
  // matching_dubai.processed_events ids 17585/17588). account_id is which of
  // OUR accounts observed the message, not a property of the message
  // itself, so it must never affect this key.
  const a = { provider: 'telegram', account_id: 'tg_main', chat_id: '-100123', external_message_id: '55' };
  const b = { provider: 'telegram', account_id: 'tg_sales_1', chat_id: '-100123', external_message_id: '55' };
  assert.equal(computeEventKey(a), computeEventKey(b));
});

test('computeEventKey: an omitted account_id computes the same key as one with account_id present -- the field carries no weight at all', () => {
  const a = { provider: 'telegram', chat_id: '-100123', external_message_id: '55' };
  const b = { provider: 'telegram', account_id: 'tg_main', chat_id: '-100123', external_message_id: '55' };
  assert.equal(computeEventKey(a), computeEventKey(b));
});

test('computeEventKey: missing account_id (backward-compatible worker payload) never throws', () => {
  const a = { provider: 'whatsapp', account_id: null, chat_id: '123@g.us', external_message_id: 'ABC' };
  assert.doesNotThrow(() => computeEventKey(a));
});
