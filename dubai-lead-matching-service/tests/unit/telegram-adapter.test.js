'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toUnifiedRawMessage, deriveTelegramSourceUrl } = require('../../src/adapters/telegram-adapter');

const fixedNow = () => new Date('2026-09-17T12:30:03Z');

test('builds source_message_id as provider:chat_id:message_id', () => {
  const unified = toUnifiedRawMessage(
    { chat_id: '-100123456789', message_id: '308394', text: 'hi', sender_id: '1' },
    { now: fixedNow }
  );
  assert.equal(unified.source_message_id, 'telegram:-100123456789:308394');
  assert.equal(unified.provider, 'telegram');
  assert.equal(unified.schema_version, '1.0');
});

test('builds author_contact from sender_username, strips a leading @', () => {
  const unified = toUnifiedRawMessage(
    { chat_id: '1', message_id: '1', text: 'hi', sender_username: '@john' },
    { now: fixedNow }
  );
  assert.equal(unified.author_username, 'john');
  assert.equal(unified.author_contact, 'https://t.me/john');
});

test('no sender_username -> author_contact is null, never a placeholder', () => {
  const unified = toUnifiedRawMessage({ chat_id: '1', message_id: '1', text: 'hi' }, { now: fixedNow });
  assert.equal(unified.author_contact, null);
  assert.equal(unified.author_username, null);
});

test('original_text is preserved verbatim -- no trim, no rewrite', () => {
  const text = '  Need 2BR   in Business Bay\nBudget up to 2.5M  ';
  const unified = toUnifiedRawMessage({ chat_id: '1', message_id: '1', text }, { now: fixedNow });
  assert.equal(unified.original_text, text);
});

test('sender_id_alt is always null -- Telegram has no LID concept', () => {
  const unified = toUnifiedRawMessage({ chat_id: '1', message_id: '1', text: 'hi' }, { now: fixedNow });
  assert.equal(unified.sender_id_alt, null);
});

test('group_name/source_url/posted_at pass through, default to null', () => {
  const unified = toUnifiedRawMessage(
    { chat_id: '1', message_id: '1', text: 'hi', chat_name: 'Dubai Brokers', source_url: 'https://t.me/x/1', posted_at: '2026-09-17T12:00:00Z' },
    { now: fixedNow }
  );
  assert.equal(unified.group_name, 'Dubai Brokers');
  assert.equal(unified.source_url, 'https://t.me/x/1');
  assert.equal(unified.posted_at, '2026-09-17T12:00:00Z');

  const bare = toUnifiedRawMessage({ chat_id: '1', message_id: '1', text: 'hi' }, { now: fixedNow });
  assert.equal(bare.group_name, null);
  assert.equal(bare.source_url, null);
  assert.equal(bare.posted_at, null);
});

test('source_url is derived from chat_username when telegram-worker did not send one', () => {
  const unified = toUnifiedRawMessage(
    { chat_id: '-1001144748083', message_id: '1161694', text: 'hi', chat_username: 'dubai_rent_public' },
    { now: fixedNow }
  );
  assert.equal(unified.source_url, 'https://t.me/dubai_rent_public/1161694');
});

test('source_url falls back to a t.me/c/ internal link for a private supergroup (no username, -100 chat_id)', () => {
  const unified = toUnifiedRawMessage(
    { chat_id: '-1001144748083', message_id: '1161694', text: 'hi', chat_username: '' },
    { now: fixedNow }
  );
  assert.equal(unified.source_url, 'https://t.me/c/1144748083/1161694');
});

test('source_url is null for a plain (non-super) private group -- no permalink format exists', () => {
  const unified = toUnifiedRawMessage({ chat_id: '-123456', message_id: '1', text: 'hi', chat_username: '' }, { now: fixedNow });
  assert.equal(unified.source_url, null);
});

test('an explicit raw.source_url always wins over derivation', () => {
  const unified = toUnifiedRawMessage(
    { chat_id: '-1001144748083', message_id: '1161694', text: 'hi', chat_username: 'x', source_url: 'https://t.me/override/1' },
    { now: fixedNow }
  );
  assert.equal(unified.source_url, 'https://t.me/override/1');
});

test('deriveTelegramSourceUrl: prefers a public username link over the internal c/ form', () => {
  assert.equal(
    deriveTelegramSourceUrl({ chatId: '-1001144748083', chatUsername: 'pub', messageId: '5' }),
    'https://t.me/pub/5'
  );
});

test('received_at reflects the injected clock', () => {
  const unified = toUnifiedRawMessage({ chat_id: '1', message_id: '1', text: 'hi' }, { now: fixedNow });
  assert.equal(unified.received_at, '2026-09-17T12:30:03.000Z');
});
