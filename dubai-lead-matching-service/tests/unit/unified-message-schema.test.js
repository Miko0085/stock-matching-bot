'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { providerEnvelopeSchema, telegramRawSchema, whatsappRawSchema } = require('../../src/adapters/unified-message-schema');

test('providerEnvelopeSchema accepts telegram/whatsapp, rejects anything else', () => {
  assert.equal(providerEnvelopeSchema.safeParse({ provider: 'telegram' }).success, true);
  assert.equal(providerEnvelopeSchema.safeParse({ provider: 'whatsapp' }).success, true);
  assert.equal(providerEnvelopeSchema.safeParse({ provider: 'facebook' }).success, false);
  assert.equal(providerEnvelopeSchema.safeParse({}).success, false);
});

test('telegramRawSchema requires chat_id/message_id/text', () => {
  assert.equal(telegramRawSchema.safeParse({ provider: 'telegram', chat_id: '1', message_id: '2', text: 'hi' }).success, true);
  assert.equal(telegramRawSchema.safeParse({ provider: 'telegram', chat_id: '1', text: 'hi' }).success, false);
  assert.equal(telegramRawSchema.safeParse({ provider: 'telegram', chat_id: '1', message_id: '2' }).success, false);
});

test('telegramRawSchema coerces numeric chat_id/message_id to strings', () => {
  const parsed = telegramRawSchema.parse({ provider: 'telegram', chat_id: -100123, message_id: 5, text: 'hi' });
  assert.equal(parsed.chat_id, '-100123');
  assert.equal(parsed.message_id, '5');
});

test('whatsappRawSchema accepts an optional sender_id_alt', () => {
  const parsed = whatsappRawSchema.parse({
    provider: 'whatsapp',
    chat_id: '1',
    message_id: '2',
    text: 'hi',
    sender_id: '1@lid',
    sender_id_alt: '9715@s.whatsapp.net',
  });
  assert.equal(parsed.sender_id_alt, '9715@s.whatsapp.net');
});

test('unknown extra fields are passed through, not rejected', () => {
  const parsed = telegramRawSchema.safeParse({
    provider: 'telegram',
    chat_id: '1',
    message_id: '2',
    text: 'hi',
    some_future_field: 'value',
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.some_future_field, 'value');
});
