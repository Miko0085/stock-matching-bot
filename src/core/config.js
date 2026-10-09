'use strict';

// Default pilot configuration. Mirrors .env.example so unit tests never depend
// on a real environment. loadConfigFromEnv() overlays process.env on top of
// these defaults for scripts and workflow generation.

const DEFAULT_CONFIG = {
  matchAllowedTransactionTypes: ['SALE'],
  matchMinScore: 70,
  matchStrongScore: 85,
  matchPriceTolerancePct: 10,
  stockStaleHours: 36,
  matcherVersion: 'pilot-v1',
  parserVersion: 'pilot-v1',

  weights: {
    location: 30,
    bedrooms: 25,
    propertyType: 15,
    budget: 20,
    furnishing: 10,
  },

  budgetBands: {
    within: 20,
    over0to5: 12,
    over5to10: 5,
    over10: 0,
  },

  telegram: {
    maxMessageLength: 3800,
    sendAllMatches: true,
  },

  sourceMessagesTable: 'devi_messages',
};

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toList(value, fallback) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadConfigFromEnv(env = process.env) {
  return {
    ...DEFAULT_CONFIG,
    matchAllowedTransactionTypes: toList(
      env.MATCH_ALLOWED_TRANSACTION_TYPES,
      DEFAULT_CONFIG.matchAllowedTransactionTypes
    ),
    matchMinScore: toNumber(env.MATCH_MIN_SCORE, DEFAULT_CONFIG.matchMinScore),
    matchStrongScore: toNumber(env.MATCH_STRONG_SCORE, DEFAULT_CONFIG.matchStrongScore),
    matchPriceTolerancePct: toNumber(
      env.MATCH_PRICE_TOLERANCE_PCT,
      DEFAULT_CONFIG.matchPriceTolerancePct
    ),
    stockStaleHours: toNumber(env.STOCK_STALE_HOURS, DEFAULT_CONFIG.stockStaleHours),
    matcherVersion: env.MATCHER_VERSION || DEFAULT_CONFIG.matcherVersion,
    parserVersion: env.AI_PARSER_VERSION || DEFAULT_CONFIG.parserVersion,
    weights: {
      location: toNumber(env.MATCH_WEIGHT_LOCATION, DEFAULT_CONFIG.weights.location),
      bedrooms: toNumber(env.MATCH_WEIGHT_BEDROOMS, DEFAULT_CONFIG.weights.bedrooms),
      propertyType: toNumber(
        env.MATCH_WEIGHT_PROPERTY_TYPE,
        DEFAULT_CONFIG.weights.propertyType
      ),
      budget: toNumber(env.MATCH_WEIGHT_BUDGET, DEFAULT_CONFIG.weights.budget),
      furnishing: toNumber(env.MATCH_WEIGHT_FURNISHING, DEFAULT_CONFIG.weights.furnishing),
    },
    budgetBands: {
      within: toNumber(env.MATCH_BUDGET_SCORE_WITHIN, DEFAULT_CONFIG.budgetBands.within),
      over0to5: toNumber(
        env.MATCH_BUDGET_SCORE_OVER_0_TO_5,
        DEFAULT_CONFIG.budgetBands.over0to5
      ),
      over5to10: toNumber(
        env.MATCH_BUDGET_SCORE_OVER_5_TO_10,
        DEFAULT_CONFIG.budgetBands.over5to10
      ),
      over10: toNumber(env.MATCH_BUDGET_SCORE_OVER_10, DEFAULT_CONFIG.budgetBands.over10),
    },
    telegram: {
      maxMessageLength: toNumber(
        env.TELEGRAM_MAX_MESSAGE_LENGTH,
        DEFAULT_CONFIG.telegram.maxMessageLength
      ),
      sendAllMatches: toBool(
        env.SEND_ALL_MATCHES_TO_TELEGRAM,
        DEFAULT_CONFIG.telegram.sendAllMatches
      ),
    },
    sourceMessagesTable: env.SOURCE_MESSAGES_TABLE || DEFAULT_CONFIG.sourceMessagesTable,
  };
}

module.exports = { DEFAULT_CONFIG, loadConfigFromEnv };
