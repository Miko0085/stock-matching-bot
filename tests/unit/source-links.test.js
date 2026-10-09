'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveSourcePostLinks } = require('../../src/core/source-links');

test('a telegram-provider request maps to telegram_post only', () => {
  const result = deriveSourcePostLinks('telegram', 'https://t.me/group/123');
  assert.equal(result.telegramPost, 'https://t.me/group/123');
  assert.equal(result.whatsappPost, null);
});

test('a whatsapp-provider request maps to whatsapp_post only', () => {
  const result = deriveSourcePostLinks('whatsapp', 'https://wa.me/abc');
  assert.equal(result.telegramPost, null);
  assert.equal(result.whatsappPost, 'https://wa.me/abc');
});

test('no source URL yields both null regardless of provider', () => {
  const result = deriveSourcePostLinks('telegram', null);
  assert.equal(result.telegramPost, null);
  assert.equal(result.whatsappPost, null);
});

test('an unrecognized provider yields both null', () => {
  const result = deriveSourcePostLinks('facebook', 'https://facebook.com/post/1');
  assert.equal(result.telegramPost, null);
  assert.equal(result.whatsappPost, null);
});
