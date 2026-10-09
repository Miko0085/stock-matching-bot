'use strict';

// Internal API security (TZ 76): a shared API key via `X-API-Key`, OR a
// shared webhook secret via `X-Webhook-Secret` (config.webhookSecret) --
// the same header telegram-worker's WebhookDeliveryQueue already sends to
// every n8n-style webhook target, including this service when it's
// listed in TELEGRAM_MONITOR_WEBHOOK_URL. Either credential alone is
// sufficient; this is additive (existing X-API-Key callers -- dashboard,
// tools/, direct /v1/match callers -- are unaffected). If NEITHER is
// configured the service runs fully unauthenticated -- fine for local
// dev bound to 127.0.0.1, never appropriate for anything reachable beyond
// localhost. /health is deliberately exempt (standard health-check
// convention, and TZ 75 doesn't require auth on it).
function requireApiKey(config) {
  return async function apiKeyPreHandler(request, reply) {
    if (!config.apiKey && !config.webhookSecret) return; // unauthenticated dev mode

    const providedApiKey = request.headers['x-api-key'];
    if (config.apiKey && providedApiKey === config.apiKey) return;

    const providedWebhookSecret = request.headers['x-webhook-secret'];
    if (config.webhookSecret && providedWebhookSecret === config.webhookSecret) return;

    reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid X-API-Key / X-Webhook-Secret' } });
  };
}

module.exports = { requireApiKey };
