'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DUBAI_ROUTE_REJECT_REASONS,
  getRetentionDays,
  cleanupGenericRouteRejects,
  cleanupDubaiStyleRouteRejects,
  scheduleRouteRejectCleanup,
} = require('../../src/db/route-reject-cleanup');

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

test('getRetentionDays: reads the setting and coerces to a number', async () => {
  const pool = fakePool([{ rows: [{ value_text: '7' }] }]);
  const days = await getRetentionDays(pool, 'matching_moscow');
  assert.equal(days, 7);
  assert.match(pool.calls[0].sql, /matching_moscow\.runtime_settings/);
});

test('getRetentionDays: returns null when the setting row is missing (never a crash)', async () => {
  const pool = fakePool([{ rows: [] }]);
  const days = await getRetentionDays(pool, 'matching_dubai');
  assert.equal(days, null);
});

test('getRetentionDays: a malformed value_text returns null, not NaN', async () => {
  const pool = fakePool([{ rows: [{ value_text: 'not-a-number' }] }]);
  const days = await getRetentionDays(pool, 'matching_moscow');
  assert.equal(days, null);
});

test('cleanupGenericRouteRejects: skipped when retention is 0 (never deletes with a zero/negative window)', async () => {
  const pool = fakePool([{ rows: [{ value_text: '0' }] }]);
  const result = await cleanupGenericRouteRejects(pool, 'matching_moscow');
  assert.deepEqual(result, { skipped: true, retentionDays: 0 });
  assert.equal(pool.calls.length, 1, 'must never issue the DELETE when disabled');
});

test('cleanupGenericRouteRejects: skipped when the setting row does not exist at all', async () => {
  const pool = fakePool([{ rows: [] }]);
  const result = await cleanupGenericRouteRejects(pool, 'matching_abu_dhabi');
  assert.equal(result.skipped, true);
  assert.equal(pool.calls.length, 1);
});

test('cleanupGenericRouteRejects: deletes only ROUTE_REJECT-prefixed REJECTED rows older than the window, scoped to the given schema', async () => {
  const pool = fakePool([{ rows: [{ value_text: '7' }] }, { rows: [], rowCount: 42 }]);
  const result = await cleanupGenericRouteRejects(pool, 'matching_moscow');
  assert.deepEqual(result, { skipped: false, retentionDays: 7, deleted: 42 });
  const deleteCall = pool.calls[1];
  assert.match(deleteCall.sql, /DELETE FROM matching_moscow\.match_runs/);
  assert.match(deleteCall.sql, /result_status = 'REJECTED'/);
  assert.match(deleteCall.sql, /reason LIKE 'ROUTE_REJECT:%'/);
  assert.deepEqual(deleteCall.params, [7]);
});

test('cleanupDubaiStyleRouteRejects: matches only the exhaustive route-gate reason allow-list, never a blanket REJECTED delete', async () => {
  const pool = fakePool([{ rows: [{ value_text: '7' }] }, { rows: [], rowCount: 10 }]);
  const result = await cleanupDubaiStyleRouteRejects(pool, 'matching_dubai');
  assert.equal(result.deleted, 10);
  const deleteCall = pool.calls[1];
  assert.match(deleteCall.sql, /DELETE FROM matching_dubai\.match_runs/);
  assert.match(deleteCall.sql, /no_match_reason = ANY\(\$1\)/);
  assert.deepEqual(deleteCall.params[0], DUBAI_ROUTE_REJECT_REASONS);
  // Confirms content-gate reasons (real diagnostic value) are never in the list.
  assert.ok(!DUBAI_ROUTE_REJECT_REASONS.includes('v2_gate_blacklist'));
  assert.ok(!DUBAI_ROUTE_REJECT_REASONS.includes('advertisement'));
  assert.ok(!DUBAI_ROUTE_REJECT_REASONS.includes('not_buyer_request'));
});

test('cleanupDubaiStyleRouteRejects: skipped when retention is disabled (negative value treated as disabled too)', async () => {
  const pool = fakePool([{ rows: [{ value_text: '-5' }] }]);
  const result = await cleanupDubaiStyleRouteRejects(pool, 'matching_dubai');
  assert.deepEqual(result, { skipped: true, retentionDays: -5 });
  assert.equal(pool.calls.length, 1);
});

test('scheduleRouteRejectCleanup: runs once after the startup delay and then on each interval tick, and stop() clears both timers', (t, done) => {
  let callCount = 0;
  const pool = {};
  const cleanupFn = async () => {
    callCount += 1;
    return { skipped: false, retentionDays: 7, deleted: 0 };
  };
  const stop = scheduleRouteRejectCleanup(pool, {
    schema: 'matching_moscow',
    cleanupFn,
    log: { info: () => {}, error: () => {} },
    intervalMs: 20,
    startupDelayMs: 5,
  });
  setTimeout(() => {
    stop();
    const countAtStop = callCount;
    assert.ok(countAtStop >= 1, 'should have run at least once by now');
    setTimeout(() => {
      assert.equal(callCount, countAtStop, 'no further ticks after stop()');
      done();
    }, 40);
  }, 30);
});

test('scheduleRouteRejectCleanup: a cleanupFn failure is swallowed, never thrown/crashes the caller', (t, done) => {
  const pool = {};
  const cleanupFn = async () => {
    throw new Error('transient DB hiccup');
  };
  const errors = [];
  const stop = scheduleRouteRejectCleanup(pool, {
    schema: 'matching_moscow',
    cleanupFn,
    log: { info: () => {}, error: (obj) => errors.push(obj) },
    intervalMs: 1000,
    startupDelayMs: 5,
  });
  setTimeout(() => {
    stop();
    assert.ok(errors.length >= 1);
    done();
  }, 30);
});
