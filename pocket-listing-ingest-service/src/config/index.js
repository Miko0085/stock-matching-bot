'use strict';

require('dotenv').config();

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// POCKET_LISTING_SOURCE_CHAT_IDS: comma-separated WhatsApp chat_ids this
// service actually reads. Defaults to the one group it was built for
// ("Secondary Nika Estate") -- a comma-separated list (not a single value)
// so a second pocket-listing source group can be added later without a
// code change, same convention as telegram-worker's TELEGRAM_MONITOR_CHAT_IDS.
function parseChatIds(raw) {
  const value = raw && raw.trim() ? raw : '120363410119594257@g.us';
  return value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  return Object.freeze({
    nodeEnv: env.NODE_ENV || 'development',
    host: env.POCKET_LISTING_INGEST_HOST || '127.0.0.1',
    port: toNumber(env.POCKET_LISTING_INGEST_PORT, 8098),
    apiKey: env.POCKET_LISTING_INGEST_API_KEY || '',
    webhookSecret: env.POCKET_LISTING_INGEST_WEBHOOK_SECRET || '',
    databaseUrl: env.DATABASE_URL || '',
    testDatabaseUrl: env.TEST_DATABASE_URL || '',
    logLevel: env.LOG_LEVEL || 'info',

    sourceChatIds: parseChatIds(env.POCKET_LISTING_SOURCE_CHAT_IDS),

    // Own OpenAI key/model (may be the same key as Dubai's matcher, but
    // never shares its runtime config object or its interpretation cache
    // -- this service has no cache at all, see README).
    openaiApiKey: env.POCKET_LISTING_OPENAI_API_KEY || env.OPENAI_API_KEY || '',
    openaiModel: env.POCKET_LISTING_OPENAI_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini',
    parserVersion: env.POCKET_LISTING_PARSER_VERSION || 'pocket-listing-ingest-service-parser-v1',
  });
}

module.exports = { loadConfig };
