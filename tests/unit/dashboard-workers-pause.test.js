'use strict';

// Unit tests for the pause/resume helpers added to dashboard/workers.js.
// global.fetch is mocked throughout -- no real HTTP call ever leaves this
// process.

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

test('pauseTelegram POSTs account_id to /telegram/accounts/pause', async () => {
  const calls = mockFetchOnce({ status: 'ok', account_id: 'tg_main', paused: true, paused_at: '2026-09-26T00:00:00Z' });
  const workers = require('../../dashboard/workers');

  const result = await workers.pauseTelegram('tg_main');

  assert.equal(calls[0].url, 'http://telegram-worker.test/telegram/accounts/pause');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['X-API-Key'], 'test-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), { account_id: 'tg_main' });
  assert.equal(result.data.paused, true);
});

test('resumeTelegram POSTs account_id to /telegram/accounts/resume', async () => {
  const calls = mockFetchOnce({ status: 'ok', account_id: 'tg_main', paused: false, was_paused: true });
  const workers = require('../../dashboard/workers');

  await workers.resumeTelegram('tg_main');

  assert.equal(calls[0].url, 'http://telegram-worker.test/telegram/accounts/resume');
  assert.deepEqual(JSON.parse(calls[0].options.body), { account_id: 'tg_main' });
});

test('pauseWhatsapp POSTs account_id to /whatsapp/accounts/pause', async () => {
  const calls = mockFetchOnce({ status: 'ok', account_id: 'wa_main', paused: true });
  const workers = require('../../dashboard/workers');

  await workers.pauseWhatsapp('wa_main');

  assert.equal(calls[0].url, 'http://whatsapp-worker.test/whatsapp/accounts/pause');
  assert.deepEqual(JSON.parse(calls[0].options.body), { account_id: 'wa_main' });
});

test('resumeWhatsapp POSTs account_id to /whatsapp/accounts/resume', async () => {
  const calls = mockFetchOnce({ status: 'ok', account_id: 'wa_main', paused: false, was_paused: true });
  const workers = require('../../dashboard/workers');

  await workers.resumeWhatsapp('wa_main');

  assert.equal(calls[0].url, 'http://whatsapp-worker.test/whatsapp/accounts/resume');
  assert.deepEqual(JSON.parse(calls[0].options.body), { account_id: 'wa_main' });
});
