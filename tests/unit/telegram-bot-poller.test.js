'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pollOneBot } = require('../../dashboard/telegram-bot-poller');

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

function fakeFetch(body) {
  return async () => ({ json: async () => body });
}

const bot = { id: 1, bot_token: 'tok-1', last_update_id: 10 };

test('pollOneBot: no updates at all still bumps last_healthcheck_at via the final UPDATE, offset unchanged', async () => {
  const pool = fakePool([]); // no /start seen -> no pending-accounts query needed
  await pollOneBot(pool, bot, fakeFetch({ ok: true, result: [] }));
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /UPDATE matching_dubai\.telegram_bots SET last_update_id/);
  assert.deepEqual(pool.calls[0].params, [10, 1]);
});

test('pollOneBot: a non-/start message still advances the offset, issues no token lookup', async () => {
  const pool = fakePool([]);
  const update = { update_id: 15, message: { text: 'hello', from: { id: 1 }, chat: { id: 1 } } };
  await pollOneBot(pool, bot, fakeFetch({ ok: true, result: [update] }));
  assert.equal(pool.calls.length, 1, 'no SELECT on broker_telegram_accounts for a non-/start message');
  assert.deepEqual(pool.calls[0].params, [15, 1]);
});

test('pollOneBot: a /start with no token after it is ignored, offset still advances', async () => {
  const pool = fakePool([]);
  const update = { update_id: 20, message: { text: '/start', from: { id: 1 }, chat: { id: 1 } } };
  await pollOneBot(pool, bot, fakeFetch({ ok: true, result: [update] }));
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].params, [20, 1]);
});

test('pollOneBot: a /start with a valid pending token resolves the handshake -- UPDATE issued, telegram identity fields filled', async () => {
  const pendingAccount = {
    id: 99,
    broker_id: 7,
    connection_token: 'tok-abc',
    connection_token_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    is_verified: false,
  };
  const pool = fakePool([
    { rows: [pendingAccount] }, // SELECT pending broker_telegram_accounts
    { rows: [] }, // UPDATE broker_telegram_accounts (handshake)
  ]);
  const update = {
    update_id: 30,
    message: { text: '/start tok-abc', from: { id: 555, username: 'ivan', first_name: 'Ivan' }, chat: { id: 555 } },
  };
  await pollOneBot(pool, bot, fakeFetch({ ok: true, result: [update] }));

  assert.equal(pool.calls.length, 3);
  assert.match(pool.calls[0].sql, /SELECT \* FROM matching_dubai\.broker_telegram_accounts/);
  assert.match(pool.calls[1].sql, /UPDATE matching_dubai\.broker_telegram_accounts/);
  assert.deepEqual(pool.calls[1].params, ['555', '555', 'ivan', 'Ivan', null, 99]);
  assert.match(pool.calls[2].sql, /UPDATE matching_dubai\.telegram_bots/);
  assert.deepEqual(pool.calls[2].params, [30, 1]);
});

test('pollOneBot: an already-verified token resolves to nothing -- no UPDATE on broker_telegram_accounts, offset still advances', async () => {
  const pendingAccount = {
    id: 99,
    connection_token: 'tok-abc',
    connection_token_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    is_verified: true,
  };
  const pool = fakePool([{ rows: [pendingAccount] }]);
  const update = { update_id: 31, message: { text: '/start tok-abc', from: { id: 555 }, chat: { id: 555 } } };
  await pollOneBot(pool, bot, fakeFetch({ ok: true, result: [update] }));

  assert.equal(pool.calls.length, 2, 'SELECT happens, but no UPDATE handshake and no further write beyond the offset bump');
  assert.match(pool.calls[1].sql, /UPDATE matching_dubai\.telegram_bots/);
});

test('pollOneBot: body.ok=false never throws, issues no queries at all', async () => {
  const pool = fakePool([]);
  await pollOneBot(pool, bot, fakeFetch({ ok: false, description: 'Unauthorized' }));
  assert.equal(pool.calls.length, 0);
});

test('pollOneBot: a fetch rejection (network error) never throws, issues no queries', async () => {
  const pool = fakePool([]);
  await pollOneBot(pool, bot, async () => { throw new Error('ECONNRESET'); });
  assert.equal(pool.calls.length, 0);
});

test('pollOneBot: multiple updates in one batch advance the offset to the MAX update_id seen, not the last processed', async () => {
  const pool = fakePool([]);
  const updates = [
    { update_id: 40, message: { text: 'hi', from: { id: 1 }, chat: { id: 1 } } },
    { update_id: 42, message: { text: 'hi again', from: { id: 1 }, chat: { id: 1 } } },
    { update_id: 41, message: { text: 'out of order', from: { id: 1 }, chat: { id: 1 } } },
  ];
  await pollOneBot(pool, bot, fakeFetch({ ok: true, result: updates }));
  assert.deepEqual(pool.calls[0].params, [42, 1]);
});
