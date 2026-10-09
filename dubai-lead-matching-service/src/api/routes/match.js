'use strict';

const { z } = require('zod');
const { runStructuredRequestPipeline } = require('../../services/pipeline');

// TZ 30's StructuredRequest shape, validated on the way in for /v1/match
// (TZ 31): tests, debugging, dashboard, future Joker, manual calls all
// enter here, skipping adapters/gate/dedup/OpenAI entirely.
const structuredRequestSchema = z.object({
  schema_version: z.literal('1.0').optional().default('1.0'),
  request_id: z.string().min(1),
  source: z.object({
    provider: z.string().min(1),
    source_url: z.string().nullable().optional().default(null),
    group_name: z.string().nullable().optional().default(null),
    author_name: z.string().nullable().optional().default(null),
    author_contact: z.string().nullable().optional().default(null),
    original_text: z.string(),
  }),
  transaction_type: z.enum(['SALE', 'RENT']).nullable().optional().default(null),
  area: z.string().nullable().optional().default(null),
  // Multi-area (spec sections 10-17): every acceptable area, independently
  // resolved. Optional/back-compat -- a caller that only ever sends `area`
  // (singular) is unaffected; runStructuredRequestPipeline() falls back to
  // `[area]` when this is absent.
  areas: z.array(z.string()).nullable().optional().default(null),
  project: z.string().nullable().optional().default(null),
  building: z.string().nullable().optional().default(null),
  property_type: z.string().nullable().optional().default(null),
  bedrooms_min: z.number().int().nullable().optional().default(null),
  bedrooms_max: z.number().int().nullable().optional().default(null),
  budget_min: z.number().nullable().optional().default(null),
  budget_max: z.number().nullable().optional().default(null),
  furnishing: z.string().nullable().optional().default(null),
  cash_buyer: z.boolean().nullable().optional().default(null),
  ai_confidence: z.number().nullable().optional().default(null),
});

function registerMatchRoute(app, { deps }) {
  app.post('/v1/match', async (request, reply) => {
    const parsed = structuredRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'INVALID_STRUCTURED_REQUEST', message: 'Body does not match the StructuredRequest schema', details: parsed.error.issues },
      });
    }

    try {
      const result = await runStructuredRequestPipeline({ structuredRequest: parsed.data, deps });
      reply.code(200).send(result);
    } catch (err) {
      request.log.error({ err }, '/v1/match failed');
      reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error processing the request' } });
    }
  });
}

module.exports = { registerMatchRoute, structuredRequestSchema };
