'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requireApiKey } = require('../../src/api/auth');

function makeReply() {
  const reply = { statusCode: null, body: null };
  reply.code = (c) => { reply.statusCode = c; return reply; };
  reply.send = (b) => { reply.body = b; return reply; };
  return reply;
}

test('no apiKey and no webhookSecret configured -> unauthenticated dev mode, never blocks', async () => {
  const handler = requireApiKey({ apiKey: '', webhookSecret: '' });
  const reply = makeReply();
  await handler({ headers: {} }, reply);
  assert.equal(reply.statusCode, null);
});

test('X-API-Key alone still works exactly as before (backward compatible)', async () => {
  const handler = requireApiKey({ apiKey: 'secret-key', webhookSecret: '' });
  const ok = makeReply();
  await handler({ headers: { 'x-api-key': 'secret-key' } }, ok);
  assert.equal(ok.statusCode, null);

  const bad = makeReply();
  await handler({ headers: { 'x-api-key': 'wrong' } }, bad);
  assert.equal(bad.statusCode, 401);

  const missing = makeReply();
  await handler({ headers: {} }, missing);
  assert.equal(missing.statusCode, 401);
});

// AUDIT follow-up: telegram-worker's WebhookDeliveryQueue sends
// X-Webhook-Secret, never X-API-Key -- this is the fix that lets the
// pre-existing TELEGRAM_MONITOR_WEBHOOK_URL fan-out target actually
// authenticate instead of every real message bouncing 401.
test('X-Webhook-Secret alone authenticates when configured, independent of X-API-Key', async () => {
  const handler = requireApiKey({ apiKey: '', webhookSecret: 'shared-n8n-secret' });
  const ok = makeReply();
  await handler({ headers: { 'x-webhook-secret': 'shared-n8n-secret' } }, ok);
  assert.equal(ok.statusCode, null);

  const bad = makeReply();
  await handler({ headers: { 'x-webhook-secret': 'wrong' } }, bad);
  assert.equal(bad.statusCode, 401);
});

test('both credentials configured: EITHER a correct X-API-Key OR a correct X-Webhook-Secret is sufficient', async () => {
  const config = { apiKey: 'the-api-key', webhookSecret: 'the-webhook-secret' };

  const viaApiKey = makeReply();
  await requireApiKey(config)({ headers: { 'x-api-key': 'the-api-key' } }, viaApiKey);
  assert.equal(viaApiKey.statusCode, null);

  const viaWebhookSecret = makeReply();
  await requireApiKey(config)({ headers: { 'x-webhook-secret': 'the-webhook-secret' } }, viaWebhookSecret);
  assert.equal(viaWebhookSecret.statusCode, null);

  const neither = makeReply();
  await requireApiKey(config)({ headers: {} }, neither);
  assert.equal(neither.statusCode, 401);

  const wrongBoth = makeReply();
  await requireApiKey(config)({ headers: { 'x-api-key': 'nope', 'x-webhook-secret': 'nope' } }, wrongBoth);
  assert.equal(wrongBoth.statusCode, 401);
});

test('a correct X-API-Key is never defeated by an ALSO-present wrong X-Webhook-Secret header', async () => {
  const config = { apiKey: 'the-api-key', webhookSecret: 'the-webhook-secret' };
  const reply = makeReply();
  await requireApiKey(config)({ headers: { 'x-api-key': 'the-api-key', 'x-webhook-secret': 'garbage' } }, reply);
  assert.equal(reply.statusCode, null);
});
