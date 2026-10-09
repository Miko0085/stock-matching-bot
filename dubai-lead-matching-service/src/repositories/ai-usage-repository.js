'use strict';

// AI token/cost telemetry (dashboard "AI Usage" view, TZ 66).
const INSERT_AI_USAGE_LOG_SQL = `INSERT INTO matching_dubai.ai_usage_log (
  source_message_id, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd
) VALUES ($1, $2, $3, $4, $5, $6)`;

// Never throws -- a logging failure must not take down the main pipeline
// (TZ 71 "Failure usage logging не должен ломать основной pipeline").
async function logAiUsage(pool, { sourceMessageId, usage }) {
  try {
    await pool.query(INSERT_AI_USAGE_LOG_SQL, [
      sourceMessageId,
      usage.model,
      usage.promptTokens,
      usage.completionTokens,
      usage.totalTokens,
      usage.estimatedCostUsd,
    ]);
  } catch {
    // Swallowed by design (TZ 71).
  }
}

module.exports = { logAiUsage };
