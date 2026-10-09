'use strict';

const { providerEnvelopeSchema, RAW_SCHEMAS_BY_PROVIDER } = require('../../adapters/unified-message-schema');
const { runWebhookPipeline } = require('../../services/pipeline');

function sendValidationError(reply, code, message, details) {
  reply.code(400).send({ error: { code, message, details: details ?? undefined } });
}

// Validates the raw payload against the provider-specific contract (TZ 10,
// 11, 14) BEFORE anything else runs -- an invalid webhook never reaches the
// AI or the matcher, and never gets persisted (there is nothing trustworthy
// to persist yet).
function validateRawPayload(body, forcedProvider) {
  const candidate = forcedProvider ? { ...body, provider: forcedProvider } : body;

  const envelope = providerEnvelopeSchema.safeParse(candidate);
  if (!envelope.success) {
    return { ok: false, code: 'INVALID_PROVIDER', message: 'provider must be "telegram" or "whatsapp"' };
  }

  const schema = RAW_SCHEMAS_BY_PROVIDER[envelope.data.provider];
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: 'Payload does not match the raw provider contract', issues: parsed.error.issues };
  }

  return { ok: true, provider: envelope.data.provider, payload: parsed.data };
}

function registerWebhookRoutes(app, { deps }) {
  async function handle(request, reply, forcedProvider) {
    const validation = validateRawPayload(request.body, forcedProvider);
    if (!validation.ok) {
      return sendValidationError(reply, validation.code, validation.message, validation.issues);
    }

    try {
      const result = await runWebhookPipeline({ rawPayload: validation.payload, provider: validation.provider, deps });
      reply.code(200).send(result);
    } catch (err) {
      request.log.error({ err }, 'webhook pipeline failed');
      reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error processing the message' } });
    }
  }

  // TZ 9: one generic endpoint, provider read from the body.
  app.post('/v1/webhooks/messages', async (request, reply) => handle(request, reply, null));
  // TZ 9: convenience aliases -- same pipeline, provider forced by route.
  app.post('/v1/webhooks/telegram', async (request, reply) => handle(request, reply, 'telegram'));
  app.post('/v1/webhooks/whatsapp', async (request, reply) => handle(request, reply, 'whatsapp'));
}

module.exports = { registerWebhookRoutes, validateRawPayload };
