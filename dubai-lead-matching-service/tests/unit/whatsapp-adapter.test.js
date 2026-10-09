'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toUnifiedRawMessage, resolveAuthorContact, extractPhoneDigits } = require('../../src/adapters/whatsapp-adapter');

const fixedNow = () => new Date('2026-09-17T12:30:03Z');

test('builds source_message_id as provider:chat_id:message_id', () => {
  const unified = toUnifiedRawMessage(
    { chat_id: '120363...', message_id: 'ABC', text: 'hi', sender_id: '123@s.whatsapp.net' },
    { now: fixedNow }
  );
  assert.equal(unified.source_message_id, 'whatsapp:120363...:ABC');
  assert.equal(unified.provider, 'whatsapp');
});

test('sender_id ending in @lid prefers the resolved sender_id_alt for author_contact', () => {
  const contact = resolveAuthorContact('223755615867103@lid', '971586007033@s.whatsapp.net');
  assert.equal(contact, 'https://wa.me/971586007033');
});

test('a plain phone-number sender_id (no @lid) is used directly', () => {
  const contact = resolveAuthorContact('971501234567@s.whatsapp.net', null);
  assert.equal(contact, 'https://wa.me/971501234567');
});

test('an unresolved LID with no alt phone number yields no contact -- never a placeholder', () => {
  const contact = resolveAuthorContact('223755615867103@lid', null);
  assert.equal(contact, null);
});

test('extractPhoneDigits rejects short/non-phone-like values', () => {
  assert.equal(extractPhoneDigits('12345'), null); // too short to be a real phone number
  assert.equal(extractPhoneDigits(null), null);
  assert.equal(extractPhoneDigits('971501234567@s.whatsapp.net'), '971501234567');
});

test('sender_id_alt passes through onto UnifiedRawMessage unchanged', () => {
  const unified = toUnifiedRawMessage(
    { chat_id: '1', message_id: '1', text: 'hi', sender_id: '1@lid', sender_id_alt: '9715@s.whatsapp.net' },
    { now: fixedNow }
  );
  assert.equal(unified.sender_id, '1@lid');
  assert.equal(unified.sender_id_alt, '9715@s.whatsapp.net');
});

test('WhatsApp has no username concept -- author_username is always null', () => {
  const unified = toUnifiedRawMessage({ chat_id: '1', message_id: '1', text: 'hi' }, { now: fixedNow });
  assert.equal(unified.author_username, null);
});

test('original_text is preserved verbatim', () => {
  const text = 'Need 2BR   Business Bay\nmax 2.5M';
  const unified = toUnifiedRawMessage({ chat_id: '1', message_id: '1', text }, { now: fixedNow });
  assert.equal(unified.original_text, text);
});
