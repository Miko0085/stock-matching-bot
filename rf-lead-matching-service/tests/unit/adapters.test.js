'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adapt } = require('../../src/adapters');

test('adapt: telegram raw payload becomes a UnifiedRawMessage with source_message_id/original_text/sender info', () => {
  const unified = adapt({ chat_id: '-100999', message_id: '1', text: 'Ищу 2-комнатную', sender_name: 'Иван', sender_username: 'ivan' }, 'telegram');
  assert.equal(unified.source_message_id, 'telegram:-100999:1');
  assert.equal(unified.original_text, 'Ищу 2-комнатную');
  assert.equal(unified.author_name, 'Иван');
  assert.equal(unified.author_contact, 'https://t.me/ivan');
});

test('adapt: whatsapp raw payload becomes a UnifiedRawMessage too', () => {
  const unified = adapt({ chat_id: '123@g.us', message_id: '1', text: 'test', sender_id: '79991234567@s.whatsapp.net' }, 'whatsapp');
  assert.equal(unified.provider, 'whatsapp');
  assert.equal(unified.source_message_id, 'whatsapp:123@g.us:1');
});

test('adapt: an unsupported provider throws rather than silently producing a malformed shape', () => {
  assert.throws(() => adapt({}, 'sms'));
});
