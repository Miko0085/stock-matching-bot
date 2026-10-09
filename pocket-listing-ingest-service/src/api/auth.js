'use strict';

// Copied verbatim from dubai-lead-matching-service/src/api/auth.js --
// fully generic (shared API key OR shared webhook secret), nothing here
// is Dubai-matcher-specific.
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
