'use strict';

require('dotenv').config();

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

// A single frozen config object built once at process start. Nothing here
// mutates at runtime -- concurrent requests never race on shared config
// state (TZ 102).
function loadConfig(env = process.env) {
  return Object.freeze({
    nodeEnv: env.NODE_ENV || 'development',

    host: env.MATCHER_HOST || '127.0.0.1',
    port: toNumber(env.MATCHER_PORT, 8095),
    apiKey: env.MATCHER_API_KEY || '',
    // Accepted as an ALTERNATIVE credential to X-API-Key (see src/api/
    // auth.js) -- telegram-worker's own webhook delivery queue
    // (telegram_events.py) sends every n8n-style webhook target a shared
    // `X-Webhook-Secret` header (TELEGRAM_MONITOR_WEBHOOK_SECRET on that side), never
    // an X-API-Key. This lets the pre-existing third fan-out target in
    // telegram-worker's TELEGRAM_MONITOR_WEBHOOK_URL actually authenticate
    // against this service instead of every real message bouncing 401.
    webhookSecret: env.MATCHER_WEBHOOK_SECRET || '',

    databaseUrl: env.DATABASE_URL || '',
    testDatabaseUrl: env.TEST_DATABASE_URL || '',

    openaiApiKey: env.OPENAI_API_KEY || '',
    openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',

    matchPriceTolerancePct: toNumber(env.MATCH_PRICE_TOLERANCE_PCT, 10),
    dedupWindowHours: toNumber(env.DEDUP_WINDOW_HOURS, 48),
    // Cost-optimization plan (part A.1.B): how long a cached AI/local
    // interpretation is trusted before being treated as a fresh miss.
    // Bumping parserVersion below invalidates the cache immediately
    // regardless of this TTL, since the cache key includes it.
    interpretationCacheTtlDays: toNumber(env.INTERPRETATION_CACHE_TTL_DAYS, 14),
    stockStaleHours: toNumber(env.STOCK_STALE_HOURS, 36),
    matcherVersion: env.MATCHER_VERSION || 'lead-matching-service-v1',
    parserVersion: env.PARSER_VERSION || 'lead-matching-service-v1',

    matchDebug: toBool(env.MATCH_DEBUG, false),
    logLevel: env.LOG_LEVEL || 'info',

    runOpenAiLiveTests: toBool(env.RUN_OPENAI_LIVE_TESTS, false),

    // Notification Router was explicitly out of scope for v1 (TZ 4/107) --
    // added afterward, on direct request, reusing the SAME production bot
    // token/chat the old pilot used. Off by default: a dev/test run must
    // never accidentally message the real broker chat just because
    // TELEGRAM_BOT_TOKEN happens to be set in .env.
    telegramNotificationsEnabled: toBool(env.TELEGRAM_NOTIFICATIONS_ENABLED, false),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramMatchChatId: env.TELEGRAM_MATCH_CHAT_ID || '',
    telegramMaxMessageLength: toNumber(env.TELEGRAM_MAX_MESSAGE_LENGTH, 3800),

    // Qualified-buyer visibility (matching-correctness spec sections 34-39):
    // thin stock means a genuine, well-qualified buyer often still resolves
    // to NO_MATCH or INSUFFICIENT_CRITERIA -- these two paths make that
    // buyer visible WITHOUT ever faking result_status or MATCH. Both
    // default false: enabling either is an explicit operator decision, and
    // must never start a new message stream just by deploying this code.
    // Existing MATCH notification behavior (telegramNotificationsEnabled
    // above) is completely unaffected by either flag.
    telegramNotifyQualifiedNoMatch: toBool(env.TELEGRAM_NOTIFY_QUALIFIED_NO_MATCH, false),
    telegramNotifyNeedsCriteria: toBool(env.TELEGRAM_NOTIFY_NEEDS_CRITERIA, false),

    // Per-broker Telegram/WhatsApp match notifications (2026-10-08, direct
    // request -- see notifications/broker-notifier.js). Off by default,
    // same posture as telegramNotificationsEnabled above: deploying this
    // code must never start messaging real brokers just because this
    // service happens to be running.
    brokerNotificationsEnabled: toBool(env.BROKER_NOTIFICATIONS_ENABLED, false),
    whatsappWorkerUrl: env.WHATSAPP_WORKER_URL || 'http://localhost:8092',
    workerApiKey: env.WORKER_API_KEY || '',
  });
}

module.exports = { loadConfig };
