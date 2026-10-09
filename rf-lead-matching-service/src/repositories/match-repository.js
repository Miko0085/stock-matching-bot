'use strict';

// Migration 0018 kept this table domain-free while the RF stock contract
// was unapproved; migration 0032 (2026-09-29) added the real domain
// columns once it was. `insertNotImplementedRun`/`insertRejectedRun`
// (gate-only outcomes, pre-dating real matching) are unchanged below --
// `insertMatchRun`/`upsertMatchResult` are new, BY ANALOGY with
// lead-matching-service/src/repositories/match-repository.js's shape,
// adapted to Moscow's own columns (no source_url/group_name/
// triage_decision/interpretation_source/match_diagnostics -- those are
// UAE-only columns from migrations 0014/0019 that Moscow's schema never
// grew; `stock_joker_object_id` instead of a string `stock_id`).

async function insertNotImplementedRun(pool, { sourceMessageId, provider, accountId, chatId, originalText, reason }) {
  const { rows } = await pool.query(
    `INSERT INTO matching_moscow.match_runs (source_message_id, provider, account_id, chat_id, original_text, result_status, reason)
     VALUES ($1, $2, $3, $4, $5, 'NOT_IMPLEMENTED', $6)
     RETURNING id, created_at`,
    [sourceMessageId, provider, accountId, chatId, originalText, reason]
  );
  return rows[0];
}

async function insertRejectedRun(pool, { sourceMessageId, provider, accountId, chatId, originalText, reason }) {
  const { rows } = await pool.query(
    `INSERT INTO matching_moscow.match_runs (source_message_id, provider, account_id, chat_id, original_text, result_status, reason)
     VALUES ($1, $2, $3, $4, $5, 'REJECTED', $6)
     RETURNING id, created_at`,
    [sourceMessageId, provider, accountId, chatId, originalText, reason]
  );
  return rows[0];
}

// Content-hash dedup (mirrors UAE's checkDuplicate) -- a real re-send of
// the exact same text within the window is a DUPLICATE, not a fresh run.
async function checkDuplicate(pool, { contentHash, windowHours }) {
  const { rows } = await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM matching_moscow.match_runs
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
  originalText,
  resultStatus,
  reason,
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
}) {
  const { rows } = await pool.query(
    `INSERT INTO matching_moscow.match_runs (
       source_message_id, provider, account_id, chat_id, original_text,
       result_status, reason, parsed_request, normalized_request, stock_synced_at,
       active_stock_count, candidates_count, matches_count, best_score,
       no_match_reason, parser_version, matcher_version, content_hash,
       requester_contact_url, requester_sender_id, requester_name
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING id, created_at`,
    [
      sourceMessageId,
      provider,
      accountId,
      chatId,
      originalText,
      resultStatus,
      reason ?? null,
      JSON.stringify(parsedRequest ?? null),
      JSON.stringify(normalizedRequest ?? null),
      stockSyncedAt ?? null,
      activeStockCount ?? null,
      candidatesCount ?? null,
      matchesCount ?? null,
      bestScore ?? null,
      noMatchReason ?? null,
      parserVersion ?? null,
      matcherVersion ?? null,
      contentHash ?? null,
      requesterContactUrl ?? null,
      requesterSenderId ?? null,
      requesterName ?? null,
    ]
  );
  return rows[0];
}

async function upsertMatchResult(pool, { matchRunId, sourceMessageId, entry, telegramPost, whatsappPost }) {
  const { rows } = await pool.query(
    `INSERT INTO matching_moscow.match_results (
       match_run_id, source_message_id, stock_joker_object_id, match_score, match_status, match_rank,
       score_breakdown, telegram_post, whatsapp_post, updated_at
     ) VALUES ($1,$2,$3,$4,'MATCH',$5,$6,$7,$8,now())
     ON CONFLICT (source_message_id, stock_joker_object_id) DO UPDATE SET
       match_run_id = EXCLUDED.match_run_id,
       match_score = EXCLUDED.match_score,
       match_rank = EXCLUDED.match_rank,
       score_breakdown = EXCLUDED.score_breakdown,
       telegram_post = EXCLUDED.telegram_post,
       whatsapp_post = EXCLUDED.whatsapp_post,
       updated_at = now()
     RETURNING id`,
    [
      matchRunId,
      sourceMessageId,
      entry.stock.joker_object_id,
      entry.score.total,
      entry.rank,
      JSON.stringify(entry.score),
      telegramPost,
      whatsappPost,
    ]
  );
  return rows[0];
}

module.exports = { insertNotImplementedRun, insertRejectedRun, checkDuplicate, insertMatchRun, upsertMatchResult };
