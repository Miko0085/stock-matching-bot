'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDateRange, bucketForStatus, DEFAULT_PERIOD } = require('../../dashboard/notification-stats-queries');

test('resolveDateRange: with no from/to, falls back to the rolling period, usingCalendar=false', () => {
  const { start, end, usingCalendar } = resolveDateRange({ period: '7d' });
  assert.ok(start instanceof Date);
  assert.equal(end, null);
  assert.equal(usingCalendar, false);
});

test('resolveDateRange: a from date alone sets start, leaves end open-ended', () => {
  const { start, end, usingCalendar } = resolveDateRange({ from: '2026-10-01' });
  assert.equal(start.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(end, null);
  assert.equal(usingCalendar, true);
});

test('resolveDateRange: a to date is treated as inclusive of the whole day', () => {
  const { end } = resolveDateRange({ to: '2026-10-05' });
  assert.equal(end.toISOString(), '2026-10-05T23:59:59.999Z');
});

test('resolveDateRange: from+to together overrides the rolling period entirely, even if period is also passed', () => {
  const { start, end, usingCalendar } = resolveDateRange({ period: '24h', from: '2026-10-01', to: '2026-10-02' });
  assert.equal(start.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(end.toISOString(), '2026-10-02T23:59:59.999Z');
  assert.equal(usingCalendar, true);
});

test('resolveDateRange: omitting period entirely uses DEFAULT_PERIOD, never throws', () => {
  const { start } = resolveDateRange({});
  assert.ok(start instanceof Date);
  assert.equal(DEFAULT_PERIOD, '7d');
});

test('bucketForStatus: SENT and DELIVERED both count as sent', () => {
  assert.equal(bucketForStatus('SENT'), 'sent');
  assert.equal(bucketForStatus('DELIVERED'), 'sent');
});

test('bucketForStatus: FAILED counts as failed', () => {
  assert.equal(bucketForStatus('FAILED'), 'failed');
});

test('bucketForStatus: PENDING/SENDING/SKIPPED/an unknown future value all fall into skipped, never thrown away', () => {
  assert.equal(bucketForStatus('PENDING'), 'skipped');
  assert.equal(bucketForStatus('SENDING'), 'skipped');
  assert.equal(bucketForStatus('SKIPPED'), 'skipped');
  assert.equal(bucketForStatus('SOME_FUTURE_STATUS'), 'skipped');
});
