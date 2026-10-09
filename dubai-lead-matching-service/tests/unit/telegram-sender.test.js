'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendMatchNotification } = require('../../src/notifications/telegram-sender');

function fakeFetch(responses) {
  let call = 0;
  return async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: r.ok, status: r.status ?? 200, json: async () => r.body ?? { ok: r.ok } };
  };
}

test('sends every message and reports overall success when all succeed', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch([{ ok: true }, { ok: true }]));
  const result = await sendMatchNotification({ botToken: 'x', chatId: '1', messages: ['a', 'b'] });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
});

test('a Telegram rejection is retried up to maxRetries, never throws', async (t) => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls += 1;
    return { ok: false, status: 429, json: async () => ({ ok: false }) };
  });
  const result = await sendMatchNotification({ botToken: 'x', chatId: '1', messages: ['a'], maxRetries: 2 });
  assert.equal(result.ok, false);
  assert.equal(calls, 3); // initial + 2 retries
});

test('a network error never throws out of sendMatchNotification', async (t) => {
  t.mock.method(global, 'fetch', async () => {
    throw new Error('network down');
  });
  await assert.doesNotReject(() => sendMatchNotification({ botToken: 'x', chatId: '1', messages: ['a'], maxRetries: 0 }));
});

test('one message failing does not stop the others from being attempted', async (t) => {
  const sent = [];
  t.mock.method(global, 'fetch', async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body.text);
    if (body.text === 'fails') return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  await sendMatchNotification({ botToken: 'x', chatId: '1', messages: ['fails', 'succeeds'], maxRetries: 0 });
  assert.deepEqual(sent, ['fails', 'succeeds']);
});
