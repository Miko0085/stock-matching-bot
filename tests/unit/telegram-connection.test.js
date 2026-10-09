'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateConnectionToken, resolveConnectionToken, DEFAULT_TTL_MINUTES } = require('../../src/core/telegram-connection');

test('generateConnectionToken produces a non-empty, URL-safe token', () => {
  const { token } = generateConnectionToken();
  assert.ok(token.length > 0);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(token), 'token must be safe to embed in a t.me/<bot>?start= URL');
});

test('two generated tokens are never the same', () => {
  const a = generateConnectionToken();
  const b = generateConnectionToken();
  assert.notEqual(a.token, b.token);
});

test('expiresAt respects the default TTL', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const { expiresAt } = generateConnectionToken({ now });
  assert.equal(expiresAt.getTime() - now.getTime(), DEFAULT_TTL_MINUTES * 60 * 1000);
});

test('a custom TTL is respected', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const { expiresAt } = generateConnectionToken({ now, ttlMinutes: 5 });
  assert.equal(expiresAt.getTime() - now.getTime(), 5 * 60 * 1000);
});

test('resolveConnectionToken finds the matching pending (unverified) account', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const accounts = [
    { id: 1, broker_id: 7, connection_token: 'tok-abc', connection_token_expires_at: '2026-09-15T12:30:00.000Z', is_verified: false },
  ];
  const match = resolveConnectionToken(accounts, 'tok-abc', now);
  assert.equal(match.broker_id, 7);
});

test('an already-verified row never resolves again — single-use', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const accounts = [
    { id: 1, broker_id: 7, connection_token: 'tok-abc', connection_token_expires_at: '2026-09-15T12:30:00.000Z', is_verified: true },
  ];
  assert.equal(resolveConnectionToken(accounts, 'tok-abc', now), null);
});

test('an expired token never resolves', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const accounts = [
    { id: 1, broker_id: 7, connection_token: 'tok-abc', connection_token_expires_at: '2026-09-15T11:59:00.000Z', is_verified: false },
  ];
  assert.equal(resolveConnectionToken(accounts, 'tok-abc', now), null);
});

test('an unknown token resolves to null, not a crash', () => {
  assert.equal(resolveConnectionToken([], 'nope', new Date()), null);
});

test('a missing/empty presented token never matches anything', () => {
  const accounts = [{ id: 1, connection_token: '', is_verified: false }];
  assert.equal(resolveConnectionToken(accounts, '', new Date()), null);
  assert.equal(resolveConnectionToken(accounts, null, new Date()), null);
});
