'use strict';

const { deriveSourcePostLinks } = require('../core/source-links');

async function insertMatchRun(client, {
  sourceMessageId,
  resultStatus,
  parsedRequest,
  normalizedRequest,
  stockSyncedAt,
  activeStockCount,
  candidatesCount,
  matchesCount,
  bestScore,
  noMatchReason,
  parserVersion,
  matcherVersion,
}) {
  const { rows } = await client.query(
    `INSERT INTO matching_dubai.match_runs (
       source_message_id, result_status, parsed_request, normalized_request,
       stock_synced_at, active_stock_count, candidates_count, matches_count,
       best_score, no_match_reason, parser_version, matcher_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, created_at`,
    [
      sourceMessageId,
      resultStatus,
      JSON.stringify(parsedRequest || null),
      JSON.stringify(normalizedRequest || null),
      stockSyncedAt,
      activeStockCount,
      candidatesCount,
      matchesCount,
      bestScore,
      noMatchReason,
      parserVersion,
      matcherVersion,
    ]
  );
  return rows[0];
}

const UPSERT_RESULT_SQL = `
  INSERT INTO matching_dubai.match_results (
    match_run_id, source_message_id, stock_id, match_score, match_status, match_rank,
    location_score, bedrooms_score, property_type_score, budget_score, furnishing_score,
    score_breakdown, telegram_post, whatsapp_post, updated_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
  ON CONFLICT (source_message_id, stock_id) DO UPDATE SET
    match_run_id = EXCLUDED.match_run_id,
    match_score = EXCLUDED.match_score,
    match_status = EXCLUDED.match_status,
    match_rank = EXCLUDED.match_rank,
    location_score = EXCLUDED.location_score,
    bedrooms_score = EXCLUDED.bedrooms_score,
    property_type_score = EXCLUDED.property_type_score,
    budget_score = EXCLUDED.budget_score,
    furnishing_score = EXCLUDED.furnishing_score,
    score_breakdown = EXCLUDED.score_breakdown,
    telegram_post = EXCLUDED.telegram_post,
    whatsapp_post = EXCLUDED.whatsapp_post,
    updated_at = now()
  RETURNING id
`;

// telegram_post/whatsapp_post describe the ACCEPTED REQUEST's original chat
// post (derived from provider + sourceUrl), not the stock item.
async function upsertMatchResult(client, { matchRunId, sourceMessageId, entry, provider, sourceUrl }) {
  const { telegramPost, whatsappPost } = deriveSourcePostLinks(provider, sourceUrl);
  const { rows } = await client.query(UPSERT_RESULT_SQL, [
    matchRunId,
    sourceMessageId,
    entry.stock.stock_id,
    entry.score.total,
    entry.status,
    entry.rank,
    entry.score.location,
    entry.score.bedrooms,
    entry.score.propertyType,
    entry.score.budget,
    entry.score.furnishing,
    JSON.stringify(entry.score),
    telegramPost,
    whatsappPost,
  ]);
  return rows[0];
}

// Persists one matcher.js outcome: always writes match_runs, and only writes
// match_results for the successful (MATCH/STRONG_MATCH) subset — NO_MATCH
// never creates a match_results row.
async function persistMatchOutcome(client, {
  sourceMessageId,
  parsedRequest,
  matchOutcome,
  stockSyncedAt,
  parserVersion,
  matcherVersion,
  provider = null,
  sourceUrl = null,
}) {
  const run = await insertMatchRun(client, {
    sourceMessageId,
    resultStatus: matchOutcome.resultStatus,
    parsedRequest,
    normalizedRequest: matchOutcome.normalizedRequest,
    stockSyncedAt,
    activeStockCount: matchOutcome.activeStockCount,
    candidatesCount: matchOutcome.candidatesCount,
    matchesCount: matchOutcome.matchesCount,
    bestScore: matchOutcome.bestScore,
    noMatchReason: matchOutcome.noMatchReason,
    parserVersion,
    matcherVersion,
  });

  const results = [];
  for (const entry of matchOutcome.successfulMatches) {
    const result = await upsertMatchResult(client, {
      matchRunId: run.id,
      sourceMessageId,
      entry,
      provider,
      sourceUrl,
    });
    results.push(result);
  }

  return { matchRunId: run.id, results };
}

module.exports = { insertMatchRun, upsertMatchResult, persistMatchOutcome };
