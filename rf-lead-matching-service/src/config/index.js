'use strict';

require('dotenv').config();

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(env = process.env) {
  return Object.freeze({
    nodeEnv: env.NODE_ENV || 'development',
    host: env.RF_MATCHER_HOST || '127.0.0.1',
    port: toNumber(env.RF_MATCHER_PORT, 8096),
    apiKey: env.RF_MATCHER_API_KEY || '',
    databaseUrl: env.DATABASE_URL || '',
    testDatabaseUrl: env.TEST_DATABASE_URL || '',
    matcherVersion: env.MATCHER_VERSION || 'rf-lead-matching-service-v1',
    logLevel: env.LOG_LEVEL || 'info',

    // Real matching (2026-09-29) -- own OpenAI key/model (may be the same
    // key as UAE's, but never share the runtime config object) and own
    // parser version (bumping it invalidates matching_moscow.
    // message_interpretation_cache independently of UAE's cache).
    openaiApiKey: env.RF_OPENAI_API_KEY || env.OPENAI_API_KEY || '',
    openaiModel: env.RF_OPENAI_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini',
    parserVersion: env.RF_PARSER_VERSION || 'rf-lead-matching-service-parser-v1',
    aiCacheTtlDays: toNumber(env.RF_AI_CACHE_TTL_DAYS, 14),
    contentDedupTtlHours: toNumber(env.RF_CONTENT_DEDUP_TTL_HOURS, 48),

    // Separate Telegram bot (per the user's decision -- own token, one
    // shared/general chat for now, no per-broker routing).
    telegramNotificationsEnabled: String(env.RF_TELEGRAM_NOTIFICATIONS_ENABLED).toLowerCase() === 'true',
    telegramBotToken: env.RF_TELEGRAM_BOT_TOKEN || '',
    telegramMatchChatId: env.RF_TELEGRAM_MATCH_CHAT_ID || '',
    telegramMaxMessageLength: toNumber(env.RF_TELEGRAM_MAX_MESSAGE_LENGTH, 3800),
  });
}

module.exports = { loadConfig };
