'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeIdempotencyKey } = require('../../src/core/notification-idempotency');

test('the same inputs always produce the same idempotency key', () => {
  const args = { sourceMessageId: 'req-1', brokerId: 7, channel: 'TELEGRAM', notificationVersion: 1 };
  assert.equal(computeIdempotencyKey(args), computeIdempotencyKey({ ...args }));
});

test('a retried notification job resolves to the same key, not a new one', () => {
  // Simulates two separate calls from a retried job for the exact same
  // (request, broker, channel) — this is what makes the unique index on
  // notification_deliveries.idempotency_key prevent an uncontrolled
  // duplicate delivery record.
  const firstAttempt = computeIdempotencyKey({ sourceMessageId: 'req-42', brokerId: 3, channel: 'TELEGRAM' });
  const retryAttempt = computeIdempotencyKey({ sourceMessageId: 'req-42', brokerId: 3, channel: 'TELEGRAM' });
  assert.equal(firstAttempt, retryAttempt);
});

test('different brokers for the same request get different keys', () => {
  const keyA = computeIdempotencyKey({ sourceMessageId: 'req-1', brokerId: 'broker-a', channel: 'TELEGRAM' });
  const keyB = computeIdempotencyKey({ sourceMessageId: 'req-1', brokerId: 'broker-b', channel: 'TELEGRAM' });
  assert.notEqual(keyA, keyB);
});

test('different channels for the same request+broker get different keys', () => {
  const telegram = computeIdempotencyKey({ sourceMessageId: 'req-1', brokerId: 7, channel: 'TELEGRAM' });
  const whatsapp = computeIdempotencyKey({ sourceMessageId: 'req-1', brokerId: 7, channel: 'WHATSAPP' });
  assert.notEqual(telegram, whatsapp);
});

test('bumping notification_version yields a new key (an intentional re-send, not a duplicate)', () => {
  const v1 = computeIdempotencyKey({ sourceMessageId: 'req-1', brokerId: 7, channel: 'TELEGRAM', notificationVersion: 1 });
  const v2 = computeIdempotencyKey({ sourceMessageId: 'req-1', brokerId: 7, channel: 'TELEGRAM', notificationVersion: 2 });
  assert.notEqual(v1, v2);
});

test('missing required fields throw rather than silently producing a weak key', () => {
  assert.throws(() => computeIdempotencyKey({ brokerId: 1, channel: 'TELEGRAM' }));
  assert.throws(() => computeIdempotencyKey({ sourceMessageId: 'req-1', channel: 'TELEGRAM' }));
  assert.throws(() => computeIdempotencyKey({ sourceMessageId: 'req-1', brokerId: 1 }));
});

test('an UNASSIGNED group still gets a stable, valid key', () => {
  const key = computeIdempotencyKey({ sourceMessageId: 'req-1', brokerId: 'UNASSIGNED', channel: 'TELEGRAM' });
  assert.equal(typeof key, 'string');
  assert.ok(key.length > 0);
});
