'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAliasCache } = require('../../src/services/alias-cache');

test('caches the loader result within the TTL window', async () => {
  let calls = 0;
  let clock = 0;
  const cache = createAliasCache({ loader: async () => { calls += 1; return { call: calls }; }, ttlMs: 1000, now: () => clock });

  const a = await cache.get();
  clock += 500;
  const b = await cache.get();

  assert.equal(calls, 1);
  assert.equal(a, b);
});

test('refreshes after the TTL expires (TZ 102: bounded staleness, not unbounded)', async () => {
  let calls = 0;
  let clock = 0;
  const cache = createAliasCache({ loader: async () => { calls += 1; return { call: calls }; }, ttlMs: 1000, now: () => clock });

  await cache.get();
  clock += 1001;
  const second = await cache.get();

  assert.equal(calls, 2);
  assert.equal(second.call, 2);
});

test('concurrent calls during a refresh share the same in-flight promise (no thundering herd)', async () => {
  let calls = 0;
  const cache = createAliasCache({
    loader: () =>
      new Promise((resolve) => {
        calls += 1;
        setTimeout(() => resolve({ call: calls }), 20);
      }),
    ttlMs: 1000,
  });

  const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('invalidate() forces the next get() to reload', async () => {
  let calls = 0;
  const cache = createAliasCache({ loader: async () => { calls += 1; return calls; } });
  await cache.get();
  cache.invalidate();
  await cache.get();
  assert.equal(calls, 2);
});
