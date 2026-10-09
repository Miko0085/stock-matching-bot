'use strict';

const { z } = require('zod');

// Raw worker payload contracts (TZ 10 - Telegram, TZ 11 - WhatsApp). These
// are deliberately permissive (.passthrough()) -- workers are free to add
// fields later without this service rejecting the whole payload -- but the
// fields the adapters actually depend on are required/typed strictly.
const idLike = z.union([z.string(), z.number()]).transform((v) => String(v));

const telegramRawSchema = z
  .object({
    event: z.string().optional(),
    provider: z.literal('telegram'),
    account_id: z.string().nullable().optional(),
    chat_id: idLike,
    message_id: idLike,
    sender_id: idLike.nullable().optional(),
    sender_name: z.string().nullable().optional(),
    sender_username: z.string().nullable().optional(),
    text: z.string(),
    posted_at: z.string().nullable().optional(),
    chat_name: z.string().nullable().optional(),
    source_url: z.string().nullable().optional(),
  })
  .passthrough();

const whatsappRawSchema = z
  .object({
    event: z.string().optional(),
    provider: z.literal('whatsapp'),
    account_id: z.string().nullable().optional(),
    chat_id: idLike,
    message_id: idLike,
    sender_id: idLike.nullable().optional(),
    sender_id_alt: idLike.nullable().optional(),
    sender_name: z.string().nullable().optional(),
    text: z.string(),
    posted_at: z.string().nullable().optional(),
    chat_name: z.string().nullable().optional(),
    source_url: z.string().nullable().optional(),
  })
  .passthrough();

// Only used to decide which raw schema to apply next -- not the final
// validation. Rejecting here (TZ 14) means AI/matching never run.
const providerEnvelopeSchema = z
  .object({
    provider: z.enum(['telegram', 'whatsapp']),
  })
  .passthrough();

const RAW_SCHEMAS_BY_PROVIDER = {
  telegram: telegramRawSchema,
  whatsapp: whatsappRawSchema,
};

// UnifiedRawMessage (TZ 13) -- the one shape every provider adapter must
// produce. `original_text` is the canonical source of truth for the
// buyer's actual words and must never be rewritten downstream (TZ 8, 110).
const unifiedRawMessageSchema = z.object({
  schema_version: z.literal('1.0'),
  provider: z.enum(['telegram', 'whatsapp']),
  source_message_id: z.string().min(1),
  external_message_id: z.string().min(1),
  account_id: z.string().nullable(),
  chat_id: z.string().min(1),
  group_name: z.string().nullable(),
  sender_id: z.string().nullable(),
  sender_id_alt: z.string().nullable(),
  author_name: z.string().nullable(),
  author_username: z.string().nullable(),
  author_contact: z.string().nullable(),
  original_text: z.string(),
  source_url: z.string().nullable(),
  posted_at: z.string().nullable(),
  received_at: z.string(),
});

module.exports = {
  providerEnvelopeSchema,
  RAW_SCHEMAS_BY_PROVIDER,
  telegramRawSchema,
  whatsappRawSchema,
  unifiedRawMessageSchema,
};
