'use strict';

// Unit tests for the account login/connect/logout helpers added to
// dashboard/workers.js for the Channels Account Management UI. global.fetch
// is mocked throughout — no real HTTP call ever leaves this process, and
// certainly no real Telegram/WhatsApp login.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV = { ...process.env };

function mockFetchOnce(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      text: async () => JSON.stringify(responseBody),
    };
  };
  return calls;
}

beforeEach(() => {
  process.env.TELEGRAM_WORKER_URL = 'http://telegram-worker.test';
  process.env.WHATSAPP_WORKER_URL = 'http://whatsapp-worker.test';
  process.env.WORKER_API_KEY = 'test-key';
  delete require.cache[require.resolve('../../dashboard/workers')];
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
});

test('startTelegramLogin POSTs account_id to /telegram/accounts with the API key header', async () => {
  const calls = mockFetchOnce({ status: 'ok', account_id: 'tg_new', login_status: 'waiting_for_scan' });
  const workers = require('../../dashboard/workers');

  const result = await workers.startTelegramLogin('tg_new');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://telegram-worker.test/telegram/accounts');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-API-Key'], 'test-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), { account_id: 'tg_new' });
  assert.equal(result.ok, true);
  assert.equal(result.data.login_status, 'waiting_for_scan');
});

test('getTelegramLoginStatus GETs /telegram/qr with account_id as a query param', async () => {
  const calls = mockFetchOnce({ status: 'ok', login_status: 'waiting_for_scan', qr_data_url: 'data:image/png;base64,x' });
  const workers = require('../../dashboard/workers');

  const result = await workers.getTelegramLoginStatus('tg_new');

  assert.equal(calls[0].url, 'http://telegram-worker.test/telegram/qr?account_id=tg_new');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(result.data.qr_data_url, 'data:image/png;base64,x');
});

test('getTelegramLoginStatus surfaces a 404 (no pending login) as ok:false', async () => {
  mockFetchOnce({ error: 'No pending Telegram login for tg_x.' }, { ok: false, status: 404 });
  const workers = require('../../dashboard/workers');

  const result = await workers.getTelegramLoginStatus('tg_x');

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('submitTelegramLoginPassword POSTs account_id and password', async () => {
  const calls = mockFetchOnce({ status: 'ok', login_status: 'connected' });
  const workers = require('../../dashboard/workers');

  await workers.submitTelegramLoginPassword('tg_2fa', 'hunter2');

  assert.equal(calls[0].url, 'http://telegram-worker.test/telegram/accounts/password');
  assert.deepEqual(JSON.parse(calls[0].options.body), { account_id: 'tg_2fa', password: 'hunter2' });
});

test('logoutTelegram POSTs to /telegram/accounts/logout', async () => {
  const calls = mockFetchOnce({ status: 'ok', account_id: 'tg_main' });
  const workers = require('../../dashboard/workers');

  await workers.logoutTelegram('tg_main');

  assert.equal(calls[0].url, 'http://telegram-worker.test/telegram/accounts/logout');
  assert.deepEqual(JSON.parse(calls[0].options.body), { account_id: 'tg_main' });
});

test('connectWhatsapp reuses the same call as reconnectWhatsapp (POST /whatsapp/accounts)', async () => {
  const calls = mockFetchOnce({ status: 'ok', account_id: 'wa_new' });
  const workers = require('../../dashboard/workers');

  await workers.connectWhatsapp('wa_new');

  assert.equal(calls[0].url, 'http://whatsapp-worker.test/whatsapp/accounts');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { account_id: 'wa_new' });
});

test('logoutWhatsapp POSTs to /whatsapp/accounts/logout', async () => {
  const calls = mockFetchOnce({ status: 'ok', account_id: 'wa_main' });
  const workers = require('../../dashboard/workers');

  await workers.logoutWhatsapp('wa_main');

  assert.equal(calls[0].url, 'http://whatsapp-worker.test/whatsapp/accounts/logout');
  assert.deepEqual(JSON.parse(calls[0].options.body), { account_id: 'wa_main' });
});
