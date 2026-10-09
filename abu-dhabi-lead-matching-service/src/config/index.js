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
    host: env.ABU_DHABI_MATCHER_HOST || '127.0.0.1',
    port: toNumber(env.ABU_DHABI_MATCHER_PORT, 8097),
    apiKey: env.ABU_DHABI_MATCHER_API_KEY || '',
    databaseUrl: env.DATABASE_URL || '',
    testDatabaseUrl: env.TEST_DATABASE_URL || '',
    matcherVersion: env.MATCHER_VERSION || 'abu-dhabi-lead-matching-service-v1',
    logLevel: env.LOG_LEVEL || 'info',

    // Own OpenAI key/model (may be the same key as Dubai's, but never
    // share the runtime config object) and own parser version (bumping it
    // invalidates matching_abu_dhabi.message_interpretation_cache
    // independently of Dubai's cache).
    openaiApiKey: env.ABU_DHABI_OPENAI_API_KEY || env.OPENAI_API_KEY || '',
    openaiModel: env.ABU_DHABI_OPENAI_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini',
    parserVersion: env.ABU_DHABI_PARSER_VERSION || 'abu-dhabi-lead-matching-service-parser-v1',
    aiCacheTtlDays: toNumber(env.ABU_DHABI_AI_CACHE_TTL_DAYS, 14),
    contentDedupTtlHours: toNumber(env.ABU_DHABI_CONTENT_DEDUP_TTL_HOURS, 48),

    // Separate Telegram bot (per the user's decision -- own token, own
    // chat, never Dubai's or RF's).
    telegramNotificationsEnabled: String(env.ABU_DHABI_TELEGRAM_NOTIFICATIONS_ENABLED).toLowerCase() === 'true',
    telegramBotToken: env.ABU_DHABI_TELEGRAM_BOT_TOKEN || '',
    telegramMatchChatId: env.ABU_DHABI_TELEGRAM_MATCH_CHAT_ID || '',
    telegramMaxMessageLength: toNumber(env.ABU_DHABI_TELEGRAM_MAX_MESSAGE_LENGTH, 3800),
  });
}

module.exports = { loadConfig };
