'use strict';

// Nika Matching V2, Phase 3. Thin persistence layer for
// matching_dubai.shadow_gate_evaluations (migration 0022). No decision logic
// lives here -- see gates/v2-intake-gate.js (pure gate) and
// services/shadow-evaluator.js (orchestrator that calls both this and the
// gate).
async function insertShadowEvaluation(pool, {
  sourceMessageId,
  provider,
  accountId,
  chatId,
  senderId,
  messageTextHash,
  oldDecision,
  oldReason,
  v2Decision,
  v2Reason,
  blacklistHits,
  whitelistHits,
  propertySignalHits,
  sendToAiHits,
  whitelistThreshold,
  propertySignalThreshold,
  configVersionId,
  disagreement,
  projectedAiSaved,
  projectedAiAdded,
  backfilled = false,
  // Phase 4 (migration 0023): 'SHADOW' (default, unchanged Phase 3
  // behavior -- old-vs-V2 comparison, never authoritative), 'AUTHORITATIVE'
  // (cutover ON, this row's v2_decision WAS the real live decision, no
  // old_decision exists because legacy triage never ran), or 'FALLBACK'
  // (cutover ON but gate infrastructure failed -- legacy processed the
  // message instead, see services/shadow-evaluator.js's
  // evaluateAuthoritativeGate).
  mode = 'SHADOW',
}) {
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.shadow_gate_evaluations (
       source_message_id, provider, account_id, chat_id, sender_id, message_text_hash,
       old_decision, old_reason, v2_decision, v2_reason,
       blacklist_hits, whitelist_hits, property_signal_hits, send_to_ai_hits,
       whitelist_threshold, property_signal_threshold, config_version_id,
       disagreement, projected_ai_saved, projected_ai_added, backfilled, mode
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING id, created_at`,
    [
      sourceMessageId,
      provider || null,
      accountId || null,
      chatId || null,
      senderId || null,
      messageTextHash || null,
      oldDecision ?? null,
      oldReason || null,
      v2Decision,
      v2Reason || null,
      JSON.stringify(blacklistHits || []),
      JSON.stringify(whitelistHits || []),
      JSON.stringify(propertySignalHits || []),
      JSON.stringify(sendToAiHits || []),
      whitelistThreshold ?? null,
      propertySignalThreshold ?? null,
      configVersionId ?? null,
      Boolean(disagreement),
      Boolean(projectedAiSaved),
      Boolean(projectedAiAdded),
      Boolean(backfilled),
      mode,
    ]
  );
  return rows[0];
}

module.exports = { insertShadowEvaluation };
