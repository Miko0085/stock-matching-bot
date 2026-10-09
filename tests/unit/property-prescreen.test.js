'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { looksLikePropertyRequest } = require('../../src/core/property-prescreen');

test('a genuine residential buyer request passes', () => {
  assert.equal(
    looksLikePropertyRequest('Looking to buy a 1 bedroom apartment in Nobu Residence, budget up to 2.5 million AED, furnished.'),
    true
  );
});

test('a Russian-language residential request passes', () => {
  assert.equal(looksLikePropertyRequest('Ищу квартиру студию в Dubai Marina, бюджет до 1 млн'), true);
});

test('REGRESSION: a real commercial business-for-sale ad is rejected (production incident 2026-09-14)', () => {
  const text = `Looking for a ready restaurant business in Dubai? 👀

Продаётся полностью готовый ресторан в Dubai Marina.

📍 Отличная локация в Marina
🏢 Двухэтажное помещение
✨ Совсем недавно сделан полный ремонт с большими вложениями
💰 Очень адекватная арендная плата для этой локации
🍽 Ресторан оборудован и готов к работе

Стоимость и подробности — в личные сообщения.`;
  assert.equal(looksLikePropertyRequest(text), false);
});

test('REGRESSION: job/casting/service posts that trigger the upstream buyer-intent regex are rejected', () => {
  const junkMessages = [
    'Привет, ищу к себе в kомaнду целеуcтремленных парней готовых зарaбatывaть. Выплaты каждый день от 2$ до 240$',
    'Менеджер по входящим заявкам на Авито. Клиент пишет по объявлению.',
    'Мы ищем русскоговорящего админа в офис / ассистента отдела продаж, на полный рабочий день, 4-5к аед',
    'Очень ищу на эту неделю в качестве модели мужчину для съемки энергетической сессии',
    'Ищу моделей на маникюр. Я начинающий мастер маникюра и сейчас набираю моделей для практики',
    'Ищем человека в Дубае, который сможет помочь с отправкой посылок в Россию через Emirates Post.',
  ];
  for (const text of junkMessages) {
    assert.equal(looksLikePropertyRequest(text), false, `expected to reject: ${text.slice(0, 40)}...`);
  }
});

test('empty or missing text is rejected', () => {
  assert.equal(looksLikePropertyRequest(''), false);
  assert.equal(looksLikePropertyRequest(null), false);
  assert.equal(looksLikePropertyRequest(undefined), false);
});

test('an English property keyword alone is enough (case-insensitive)', () => {
  assert.equal(looksLikePropertyRequest('need a STUDIO asap'), true);
  assert.equal(looksLikePropertyRequest('3 BR villa wanted'), true);
});
