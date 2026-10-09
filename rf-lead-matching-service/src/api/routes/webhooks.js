'use strict';

const { z } = require('zod');
const { runWebhookPipeline } = require('../../services/pipeline');

const idLike = z.union([z.string(), z.number()]).transform((v) => String(v));

// Deliberately its own, minimal raw-envelope contract -- not imported from
// lead-matching-service. Only the fields this skeleton actually reads.
const rawEnvelopeSchema = z
  .object({
    chat_id: idLike,
    message_id: idLike,
    account_id: z.string().nullable().optional(),
    text: z.string().optional().default(''),
  })
  .passthrough();

function registerWebhookRoutes(app, { deps }) {
  async function handle(request, reply, provider) {
    const parsed = rawEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Payload does not match the RF raw envelope contract', issues: parsed.error.issues } });
    }
    try {
      const result = await runWebhookPipeline({ rawPayload: parsed.data, provider, deps });
      reply.code(200).send(result);
    } catch (err) {
      request.log.error({ err }, 'RF webhook pipeline failed');
      reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error processing the RF message' } });
    }
  }

  app.post('/v1/webhooks/telegram', async (request, reply) => handle(request, reply, 'telegram'));
  app.post('/v1/webhooks/whatsapp', async (request, reply) => handle(request, reply, 'whatsapp'));
}

module.exports = { registerWebhookRoutes };
