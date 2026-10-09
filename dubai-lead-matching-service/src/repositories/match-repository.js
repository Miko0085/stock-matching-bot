'use strict';

// Full persistence for this service's own result shape (TZ 68-70). Not
// reused from src/db/matchRepository.js on purpose: that file predates
// content_hash/requester_*/provider/source_url/group_name/original_text
// and is only ever exercised by this project's OLD integration tests
// (pilot-v1 compatibility path, see AGENTS.md). Writing a complete,
// up-to-date repository here avoids inheriting that drift.

async function checkDuplicate(pool, { contentHash, windowHours }) {
  const { rows } = await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM matching_dubai.match_runs
       WHERE content_hash = $1 AND created_at > now() - ($2 || ' hours')::interval
     ) AS is_duplicate`,
    [contentHash, windowHours]
  );
  return rows[0].is_duplicate;
}

async function insertMatchRun(pool, {
  sourceMessageId,
  provider,
  accountId,
  chatId,
  sourceUrl,
  groupName,
  originalText,
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
  contentHash,
  requesterContactUrl,
  requesterSenderId,
  requesterName,
  triageDecision,
  interpretationSource,
  matchDiagnostics,
}) {
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.match_runs (
       source_message_id, provider, source_url, group_name, original_text,
       result_status, parsed_request, normalized_request, stock_synced_at,
       active_stock_count, candidates_count, matches_count, best_score,
       no_match_reason, parser_version, matcher_version, content_hash,
       requester_contact_url, requester_sender_id, requester_name,
       triage_decision, interpretation_source, match_diagnostics, account_id, chat_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     RETURNING id, created_at`,
    [
      sourceMessageId,
      provider,
      sourceUrl,
      groupName,
      originalText,
      resultStatus,
      JSON.stringify(parsedRequest ?? null),
      JSON.stringify(normalizedRequest ?? null),
      stockSyncedAt,
      activeStockCount,
      candidatesCount,
      matchesCount,
      bestScore,
      noMatchReason,
      parserVersion,
      matcherVersion,
      contentHash,
      requesterContactUrl,
      requesterSenderId,
      requesterName,
      triageDecision ?? null,
      interpretationSource ?? null,
      // Additive, nullable (migration 0019) -- absent/undefined for any
      // caller that doesn't pass it (e.g. persistNonMatchingOutcome's
      // REJECTED/DUPLICATE/PARSER_ERROR paths) stores SQL NULL, exactly
      // like legacy pilot-v1 rows always will.
      matchDiagnostics ? JSON.stringify(matchDiagnostics) : null,
      accountId ?? null,
      chatId ?? null,
    ]
  );
  return rows[0];
}

async function upsertMatchResult(pool, { matchRunId, sourceMessageId, entry, telegramPost, whatsappPost }) {
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.match_results (
       match_run_id, source_message_id, stock_id, match_score, match_status, match_rank,
       location_score, bedrooms_score, property_type_score, budget_score, furnishing_score,
       score_breakdown, telegram_post, whatsapp_post, updated_at
     ) VALUES ($1,$2,$3,$4,'MATCH',$5,$6,$7,$8,$9,NULL,$10,$11,$12,now())
     ON CONFLICT (source_message_id, stock_id) DO UPDATE SET
       match_run_id = EXCLUDED.match_run_id,
       match_score = EXCLUDED.match_score,
       match_rank = EXCLUDED.match_rank,
       location_score = EXCLUDED.location_score,
       bedrooms_score = EXCLUDED.bedrooms_score,
       property_type_score = EXCLUDED.property_type_score,
       budget_score = EXCLUDED.budget_score,
       score_breakdown = EXCLUDED.score_breakdown,
       telegram_post = EXCLUDED.telegram_post,
       whatsapp_post = EXCLUDED.whatsapp_post,
       updated_at = now()
     RETURNING id`,
    [
      matchRunId,
      sourceMessageId,
      entry.stock.stock_id,
      entry.score.total,
      entry.rank,
      entry.score.components.location?.score ?? null,
      entry.score.components.bedrooms?.score ?? null,
      entry.score.components.propertyType?.score ?? null,
      entry.score.components.budget?.score ?? null,
      JSON.stringify(entry.score),
      telegramPost,
      whatsappPost,
    ]
  );
  return rows[0];
}

module.exports = { checkDuplicate, insertMatchRun, upsertMatchResult };
