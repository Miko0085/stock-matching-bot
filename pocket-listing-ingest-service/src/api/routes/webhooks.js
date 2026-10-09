'use strict';

const { z } = require('zod');
const { runWebhookPipeline } = require('../../services/pipeline');

const idLike = z.union([z.string(), z.number()]).transform((v) => String(v));

// Same raw envelope whatsapp-worker already sends to every monitored
// webhook target (confirmed against whatsapp-worker/wa_events.js's
// buildMessageEvent output) -- only the fields this service actually
// reads. WhatsApp-only: this service has no Telegram source at all.
const rawEnvelopeSchema = z
  .object({
    chat_id: idLike,
    message_id: idLike,
    account_id: z.string().nullable().optional(),
    text: z.string().optional().default(''),
    sender_id: z.string().nullable().optional(),
    sender_id_alt: z.string().nullable().optional(),
    sender_name: z.string().nullable().optional(),
    posted_at: z.string().nullable().optional(),
  })
  .passthrough();

function registerWebhookRoutes(app, { deps }) {
  app.post('/v1/webhooks/whatsapp', async (request, reply) => {
    const parsed = rawEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Payload does not match the raw envelope contract', issues: parsed.error.issues } });
    }
    try {
      const result = await runWebhookPipeline({ rawPayload: parsed.data, deps });
      reply.code(200).send(result);
    } catch (err) {
      request.log.error({ err }, 'pocket-listing-ingest webhook pipeline failed');
      reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error processing the message' } });
    }
  });
}

module.exports = { registerWebhookRoutes };
