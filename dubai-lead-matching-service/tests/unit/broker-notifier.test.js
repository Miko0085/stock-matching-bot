'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { notifyMatchedBrokers, groupMatchesByBrokerPhone } = require('../../src/notifications/broker-notifier');
const { makeStock } = require('../../../tests/fixtures/stock');

function fakePool(responses) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const next = responses.shift();
      return next || { rows: [], rowCount: 0 };
    },
  };
}

function baseConfig(overrides = {}) {
  return { brokerNotificationsEnabled: true, whatsappWorkerUrl: 'http://wa', workerApiKey: 'k', telegramMaxMessageLength: 3800, ...overrides };
}

function makeEntry(stockId, overrides = {}) {
  return { stock: makeStock({ stock_id: stockId, broker_contact: '+971 50 687 3050', ...overrides }), score: { total: 90 } };
}

const structuredRequest = { area: 'Business Bay', budget_min: null, budget_max: 2500000 };

test('groupMatchesByBrokerPhone: entries with no normalizable contact are excluded entirely', () => {
  const matches = [makeEntry('A1', { broker_contact: null }), makeEntry('A2', { broker_contact: '' })];
  const groups = groupMatchesByBrokerPhone(matches);
  assert.equal(groups.size, 0);
});

test('notifyMatchedBrokers: disabled by config -- zero pool calls, true no-op', async () => {
  const pool = fakePool([]);
  await notifyMatchedBrokers({ pool, sourceMessageId: 'req-1', structuredRequest, matches: [makeEntry('A1')], config: baseConfig({ brokerNotificationsEnabled: false }) });
  assert.equal(pool.calls.length, 0);
});

test('notifyMatchedBrokers: no matches have a normalizable broker_contact -- zero pool calls', async () => {
  const pool = fakePool([]);
  await notifyMatchedBrokers({ pool, sourceMessageId: 'req-1', structuredRequest, matches: [makeEntry('A1', { broker_contact: null })], config: baseConfig() });
  assert.equal(pool.calls.length, 0);
});

test('notifyMatchedBrokers: no brokers row for this phone -- skip silently after the one lookup', async () => {
  const pool = fakePool([{ rows: [] }]);
  await notifyMatchedBrokers({ pool, sourceMessageId: 'req-1', structuredRequest, matches: [makeEntry('A1')], config: baseConfig() });
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /SELECT id FROM matching_dubai\.brokers WHERE normalized_phone/);
});

test('notifyMatchedBrokers: broker exists but has zero enabled routes -- skip silently after two lookups', async () => {
  const pool = fakePool([{ rows: [{ id: 7 }] }, { rows: [] }]);
  await notifyMatchedBrokers({ pool, sourceMessageId: 'req-1', structuredRequest, matches: [makeEntry('A1')], config: baseConfig() });
  assert.equal(pool.calls.length, 2);
});

test('notifyMatchedBrokers: WHATSAPP route, nothing previously sent -- sends one message and inserts one delivery row per stock_id', async () => {
  const pool = fakePool([
    { rows: [{ id: 7 }] }, // brokers lookup
    { rows: [{ id: 55, channel: 'WHATSAPP', enabled: true, destination: null, whatsapp_account_id: 'wa_anna' }] }, // routes
    { rows: [] }, // already-notified stock_ids (none)
    { rows: [] }, // insert A1
    { rows: [] }, // insert A2
  ]);
  const sendWhatsapp = async () => ({ ok: true });
  await notifyMatchedBrokers({
    pool, sourceMessageId: 'req-1', structuredRequest,
    matches: [makeEntry('A1'), makeEntry('A2')],
    config: baseConfig(),
    deps: { sendWhatsapp },
  });
  assert.equal(pool.calls.length, 5);
  const inserts = pool.calls.filter((c) => /INSERT INTO matching_dubai\.notification_deliveries/.test(c.sql));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].params[7], 'SENT');
  assert.equal(inserts[0].params[4], '971506873050'); // normalized phone used as destination
});

test('notifyMatchedBrokers: dedup -- a stock_id already notified for this (request, channel) is excluded, and if ALL are already notified, nothing is sent at all', async () => {
  const pool = fakePool([
    { rows: [{ id: 7 }] },
    { rows: [{ id: 55, channel: 'WHATSAPP', enabled: true, whatsapp_account_id: 'wa_anna' }] },
    { rows: [{ stock_id: 'A1' }] }, // A1 already notified
  ]);
  let sendCalls = 0;
  const sendWhatsapp = async () => { sendCalls += 1; return { ok: true }; };
  await notifyMatchedBrokers({
    pool, sourceMessageId: 'req-1', structuredRequest,
    matches: [makeEntry('A1')],
    config: baseConfig(),
    deps: { sendWhatsapp },
  });
  assert.equal(sendCalls, 0, 'the only matched stock_id was already notified -- true no-op, no send, no insert');
  assert.equal(pool.calls.length, 3);
});

test('notifyMatchedBrokers: TELEGRAM route with no verified linked account -- skip silently, no send', async () => {
  const pool = fakePool([
    { rows: [{ id: 7 }] },
    { rows: [{ id: 56, channel: 'TELEGRAM', enabled: true }] },
    { rows: [] }, // nothing previously notified
    { rows: [] }, // SELECT broker_telegram_accounts -- none verified
  ]);
  let sendCalls = 0;
  const sendTelegram = async () => { sendCalls += 1; return { ok: true }; };
  await notifyMatchedBrokers({
    pool, sourceMessageId: 'req-1', structuredRequest,
    matches: [makeEntry('A1')],
    config: baseConfig(),
    deps: { sendTelegram },
  });
  assert.equal(sendCalls, 0);
});

test('notifyMatchedBrokers: TELEGRAM route with a verified linked account -- sends and records SENT', async () => {
  const pool = fakePool([
    { rows: [{ id: 7 }] },
    { rows: [{ id: 56, channel: 'TELEGRAM', enabled: true }] },
    { rows: [] },
    { rows: [{ telegram_chat_id: '999', bot_token: 'tok' }] },
    { rows: [] }, // insert
  ]);
  let captured = null;
  const sendTelegram = async (args) => { captured = args; return { ok: true }; };
  await notifyMatchedBrokers({
    pool, sourceMessageId: 'req-1', structuredRequest,
    matches: [makeEntry('A1')],
    config: baseConfig(),
    deps: { sendTelegram },
  });
  assert.equal(captured.chatId, '999');
  assert.equal(captured.botToken, 'tok');
  const insert = pool.calls.find((c) => /INSERT INTO matching_dubai\.notification_deliveries/.test(c.sql));
  assert.equal(insert.params[7], 'SENT');
});

test('notifyMatchedBrokers: a send failure still inserts a delivery row, with status FAILED', async () => {
  const pool = fakePool([
    { rows: [{ id: 7 }] },
    { rows: [{ id: 55, channel: 'WHATSAPP', enabled: true, whatsapp_account_id: 'wa_anna' }] },
    { rows: [] },
    { rows: [] }, // insert
  ]);
  const sendWhatsapp = async () => ({ ok: false, error: 'timeout' });
  await notifyMatchedBrokers({
    pool, sourceMessageId: 'req-1', structuredRequest,
    matches: [makeEntry('A1')],
    config: baseConfig(),
    deps: { sendWhatsapp },
  });
  const insert = pool.calls.find((c) => /INSERT INTO matching_dubai\.notification_deliveries/.test(c.sql));
  assert.equal(insert.params[7], 'FAILED');
  assert.ok(insert.params[8]); // error_text populated
});

test('notifyMatchedBrokers: two different brokers in the same MATCH are each routed independently', async () => {
  const pool = fakePool([
    { rows: [{ id: 7 }] }, // broker A lookup
    { rows: [] }, // broker A has no routes
    { rows: [{ id: 8 }] }, // broker B lookup
    { rows: [{ id: 60, channel: 'WHATSAPP', enabled: true, whatsapp_account_id: 'wa_anna' }] },
    { rows: [] }, // nothing previously sent for B
    { rows: [] }, // insert
  ]);
  const sendWhatsapp = async () => ({ ok: true });
  const matches = [makeEntry('A1', { broker_contact: '+971500000001' }), makeEntry('B1', { broker_contact: '+971500000002' })];
  await notifyMatchedBrokers({ pool, sourceMessageId: 'req-1', structuredRequest, matches, config: baseConfig(), deps: { sendWhatsapp } });
  assert.equal(pool.calls.length, 6);
});
