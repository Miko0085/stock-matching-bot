'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildNotificationMessages, formatMatchEntry, formatRooms } = require('../../src/notifications/render');

test('formatMatchEntry: shows complex over district when both present, price in RUB with ₽ symbol', () => {
  const line = formatMatchEntry({ complex: 'Событие', district: 'ЮЗАО', rooms: 3, price: 25000000, score: 92 }, 1);
  assert.match(line, /1\. Событие/);
  assert.match(line, /25.000.000 ₽/, 'ru-RU toLocaleString uses non-breaking spaces as thousands separators');
  assert.match(line, /Совпадение: 92/);
});

test('formatMatchEntry: falls back to district when complex is unknown', () => {
  const line = formatMatchEntry({ complex: null, district: 'Хамовники', rooms: 2, price: 20000000, score: 80 }, 2);
  assert.match(line, /2\. Хамовники/);
});

test('formatRooms: STUDIO/FREE_PLAN sentinels render distinctly from a numeric room count', () => {
  assert.equal(formatRooms(null, 'STUDIO'), 'Студия');
  assert.equal(formatRooms(null, 'FREE_PLAN'), 'Свободная планировка');
  assert.equal(formatRooms(3, null), '3-комн.');
  assert.equal(formatRooms(null, null), null);
});

test('buildNotificationMessages: every match appears, never Top-N, original_text preserved 1:1', () => {
  const matches = Array.from({ length: 3 }, (_, i) => ({ complex: `ЖК${i}`, district: null, rooms: 2, price: 20000000, score: 90 - i }));
  const messages = buildNotificationMessages({
    requestId: 'telegram:-100:1',
    originalText: 'Ищу для клиента 2-комнатную в ЮЗАО',
    provider: 'telegram',
    groupName: 'Москва чат',
    sourceUrl: null,
    matches,
  });
  const combined = messages.join('\n');
  assert.match(combined, /Ищу для клиента 2-комнатную в ЮЗАО/);
  for (let i = 0; i < 3; i++) assert.match(combined, new RegExp(`ЖК${i}`));
});
