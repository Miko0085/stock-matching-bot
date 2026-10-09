'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveStatus,
  normalizeTelegramHealth,
  normalizeWhatsappHealth,
  isChannelActionSupported,
} = require('../../src/core/channel-health');

const now = new Date('2026-09-15T12:00:00.000Z');

test('healthy heartbeat: connected session, fresh heartbeat -> OK', () => {
  const status = deriveStatus({ processStatus: 'RUNNING', sessionStatus: 'CONNECTED', lastHeartbeatAt: now, now });
  assert.equal(status, 'OK');
});

test('disconnected session -> DOWN', () => {
  const status = deriveStatus({ processStatus: 'RUNNING', sessionStatus: 'REQUIRES_AUTH', lastHeartbeatAt: now, now });
  assert.equal(status, 'DOWN');
});

test('stale heartbeat (older than the threshold) -> DEGRADED even if the session looks connected', () => {
  const staleHeartbeat = new Date(now.getTime() - 10 * 60 * 1000); // 10 min ago
  const status = deriveStatus({
    processStatus: 'RUNNING',
    sessionStatus: 'CONNECTED',
    lastHeartbeatAt: staleHeartbeat,
    now,
    staleAfterMs: 5 * 60 * 1000,
  });
  assert.equal(status, 'DEGRADED');
});

test('provider/session error -> DOWN regardless of heartbeat freshness', () => {
  const status = deriveStatus({ processStatus: 'RUNNING', sessionStatus: 'ERROR', lastHeartbeatAt: now, now });
  assert.equal(status, 'DOWN');
});

test('unreachable process -> DOWN even with an otherwise-fine session status', () => {
  const status = deriveStatus({ processStatus: 'UNREACHABLE', sessionStatus: 'CONNECTED', lastHeartbeatAt: now, now });
  assert.equal(status, 'DOWN');
});

test('a healthy-looking status is never derived from heartbeat/last-message alone without checking session status', () => {
  // No sessionStatus at all ("CONNECTING") must not resolve to OK just
  // because the heartbeat is fresh — this is the literal mandate "do not
  // determine worker health only from last message received."
  const status = deriveStatus({ processStatus: 'RUNNING', sessionStatus: 'CONNECTING', lastHeartbeatAt: now, now });
  assert.equal(status, 'DEGRADED');
});

test('normalizeTelegramHealth: reachable + connected + authorized account -> OK', () => {
  const result = normalizeTelegramHealth(
    {
      reachable: true,
      health: {},
      accounts: [{ status: 'connected', connected: true, authorized: true }],
    },
    now
  );
  assert.equal(result.channel, 'TELEGRAM_MONITORING');
  assert.equal(result.status, 'OK');
  assert.equal(result.sessionStatus, 'CONNECTED');
});

test('normalizeTelegramHealth: unreachable worker -> DOWN with UNREACHABLE error code', () => {
  const result = normalizeTelegramHealth({ reachable: false, error: 'timed out' }, now);
  assert.equal(result.status, 'DOWN');
  assert.equal(result.errorCode, 'UNREACHABLE');
});

test('normalizeWhatsappHealth: connected account -> OK', () => {
  const result = normalizeWhatsappHealth(
    { reachable: true, accounts: [{ status: 'connected', connected: true }] },
    now
  );
  assert.equal(result.status, 'OK');
});

test('normalizeWhatsappHealth: requires_auth -> DOWN, error surfaced', () => {
  const result = normalizeWhatsappHealth(
    { reachable: true, accounts: [{ status: 'requires_auth', connected: false, last_error: 'Connection Failure' }] },
    now
  );
  assert.equal(result.status, 'DOWN');
  assert.equal(result.sessionStatus, 'REQUIRES_AUTH');
  assert.equal(result.errorText, 'Connection Failure');
});

test('normalizeWhatsappHealth: throttled reconnect backoff surfaces as an error code with metadata', () => {
  const result = normalizeWhatsappHealth(
    {
      reachable: true,
      accounts: [{ status: 'disconnected', connected: false, throttled: true, consecutive_failures: 6, next_retry_at: '2026-09-15T12:05:00.000Z' }],
    },
    now
  );
  assert.equal(result.errorCode, 'THROTTLED');
  assert.equal(result.metadata.consecutive_failures, 6);
});

test('reconnect is a supported action for WhatsApp monitoring', () => {
  assert.equal(isChannelActionSupported('WHATSAPP_MONITORING', 'reconnect'), true);
});

test('UNSUPPORTED RECONNECT ACTION: Telegram Monitoring has no reconnect endpoint and must reject the request', () => {
  assert.equal(isChannelActionSupported('TELEGRAM_MONITORING', 'reconnect'), false);
});

test('an unknown channel name supports no actions', () => {
  assert.equal(isChannelActionSupported('CARRIER_PIGEON', 'reconnect'), false);
});
