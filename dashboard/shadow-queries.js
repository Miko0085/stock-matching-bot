'use strict';

// Nika Matching V2, Phase 3 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase
// 3, requirements 9-11). Read-only query layer over
// matching_dubai.shadow_gate_evaluations (migration 0022) -- purely observational
// dashboard analytics. Nothing here is read by, or feeds back into, any
// live routing decision.
//
// Reuses the same rolling-interval period convention as
// dashboard/summary-queries.js (PERIODS/resolvePeriodStart) so "24h/7d/30d"
// means the same thing on both pages.
const { PERIODS, DEFAULT_PERIOD, resolvePeriodStart, CURRENT_MATCHER_VERSION } = require('./summary-queries');

function safeRate(numerator, denominator) {
  if (!denominator) return null; // zero-safe: never NaN/Infinity
  return numerator / denominator;
}

// Formulas exactly as specified (Phase 3, requirement 9):
//   net_projected_ai_change = v2_send_to_ai_count - old_send_to_ai_count
//   projected_ai_reduction_pct = (old_send_to_ai_count - v2_send_to_ai_count) / old_send_to_ai_count * 100
// `old_send_to_ai_count` counts only old_decision='SEND_TO_AI' (a FRESH AI
// call that actually happened) -- CACHE_HIT_AI is deliberately excluded
// from this baseline since it cost nothing incrementally (see
// services/shadow-evaluator.js's normalizeOldDecision/computeDisagreement
// for the same distinction applied at evaluation time).
// Phase 4: explicitly scoped to mode = 'SHADOW' -- AUTHORITATIVE/FALLBACK
// rows have no old_decision (legacy never ran for them) and would corrupt
// the old-vs-V2 comparison math below if included. This is the PROJECTED
// view; see getActualGateSummary() for what actually happened once
// cutover is on.
async function getShadowSummary(pool, { period = DEFAULT_PERIOD } = {}) {
  const periodStart = resolvePeriodStart(period);
  const { rows } = await pool.query(
    `SELECT
       count(*)::int AS evaluated,
       count(*) FILTER (WHERE old_decision = 'SEND_TO_AI')::int AS old_send_to_ai_count,
       count(*) FILTER (WHERE v2_decision = 'SEND_TO_AI')::int AS v2_send_to_ai_count,
       count(*) FILTER (WHERE projected_ai_saved)::int AS projected_ai_saved_count,
       count(*) FILTER (WHERE projected_ai_added)::int AS projected_ai_added_count,
       count(*) FILTER (WHERE disagreement)::int AS disagreement_count,
       count(*) FILTER (WHERE NOT disagreement)::int AS agreement_count
     FROM matching_dubai.shadow_gate_evaluations
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)
       AND backfilled = false AND mode = 'SHADOW'`,
    [periodStart]
  );
  const r = rows[0];
  const netProjectedAiChange = r.v2_send_to_ai_count - r.old_send_to_ai_count;
  const projectedAiReductionPct = r.old_send_to_ai_count > 0
    ? ((r.old_send_to_ai_count - r.v2_send_to_ai_count) / r.old_send_to_ai_count) * 100
    : null;

  return {
    period,
    evaluated: r.evaluated,
    oldSendToAiCount: r.old_send_to_ai_count,
    v2SendToAiCount: r.v2_send_to_ai_count,
    projectedAiSavedCount: r.projected_ai_saved_count,
    projectedAiAddedCount: r.projected_ai_added_count,
    netProjectedAiChange,
    projectedAiReductionPct,
    disagreementCount: r.disagreement_count,
    agreementCount: r.agreement_count,
    agreementRate: safeRate(r.agreement_count, r.evaluated),
  };
}

// Disagreement breakdown (Phase 3, requirement 10). Every category is
// derivable from columns migration 0022 already persists -- no new schema,
// no fabricated metric. "Missing whitelist/property signal" is scoped to
// the INSUFFICIENT_BUYER_SIGNAL reason and the complementary hit array
// being non-empty, i.e. "this message had ONE of the two required signals
// but not the other".
async function getDisagreementBreakdown(pool, { period = DEFAULT_PERIOD } = {}) {
  const periodStart = resolvePeriodStart(period);
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE old_decision = 'SEND_TO_AI' AND v2_decision = 'REJECT')::int AS old_send_to_ai_v2_reject,
       count(*) FILTER (WHERE old_decision = 'REJECT_WITHOUT_AI' AND v2_decision = 'SEND_TO_AI')::int AS old_reject_v2_send_to_ai,
       count(*) FILTER (WHERE old_decision = 'PARSED_LOCALLY' AND v2_decision = 'SEND_TO_AI')::int AS old_parsed_locally_v2_send_to_ai,
       count(*) FILTER (WHERE disagreement AND v2_reason = 'BLACKLIST')::int AS blacklist_disagreement,
       count(*) FILTER (
         WHERE disagreement AND v2_reason = 'INSUFFICIENT_BUYER_SIGNAL'
           AND jsonb_array_length(whitelist_hits) = 0 AND jsonb_array_length(property_signal_hits) > 0
       )::int AS missing_whitelist_signal,
       count(*) FILTER (
         WHERE disagreement AND v2_reason = 'INSUFFICIENT_BUYER_SIGNAL'
           AND jsonb_array_length(property_signal_hits) = 0 AND jsonb_array_length(whitelist_hits) > 0
       )::int AS missing_property_signal,
       count(*) FILTER (WHERE disagreement AND v2_reason = 'SEND_TO_AI_RULE')::int AS send_to_ai_exception_rule_hit
     FROM matching_dubai.shadow_gate_evaluations
     WHERE ($1::timestamptz IS NULL OR created_at >= $1)
       AND backfilled = false AND mode = 'SHADOW'`,
    [periodStart]
  );
  const r = rows[0];
  return {
    period,
    oldSendToAiV2Reject: r.old_send_to_ai_v2_reject,
    oldRejectV2SendToAi: r.old_reject_v2_send_to_ai,
    oldParsedLocallyV2SendToAi: r.old_parsed_locally_v2_send_to_ai,
    blacklistDisagreement: r.blacklist_disagreement,
    missingWhitelistSignal: r.missing_whitelist_signal,
    missingPropertySignal: r.missing_property_signal,
    sendToAiExceptionRuleHit: r.send_to_ai_exception_rule_hit,
  };
}

// Rule-hit analytics (Phase 3, requirement 11). Each hit JSONB entry
// already embeds its own rule id/rule_group/pattern/description AS OF THE
// MOMENT IT MATCHED (see gates/v2-intake-gate.js's findHits -- it returns
// the full rule row), so this needs no join back to matching_dubai.intake_rules
// and stays correct even if a rule is later edited or deleted.
//
// The "how many became AI-confirmed buyer later" sub-metric from the spec
// is DELIBERATELY NOT implemented: shadow_gate_evaluations rows are not
// linked to a match_runs id (only a content-only text hash, which is not
// unique enough for a safe join -- the same phrase reposted by unrelated
// senders would collide), so there is no reliable way to trace a shadow
// row forward to "this later became a confirmed match" today. Documented
// as a known limitation in docs/MATCHING_V2_PHASE3_SHADOW_GATE.md rather
// than fabricated from an unsound join.
async function getRuleHitAnalytics(pool, { period = DEFAULT_PERIOD, limit = 20 } = {}) {
  const periodStart = resolvePeriodStart(period);
  const { rows } = await pool.query(
    `WITH scoped AS (
       SELECT old_decision, v2_decision, blacklist_hits, whitelist_hits, property_signal_hits, send_to_ai_hits
       FROM matching_dubai.shadow_gate_evaluations
       WHERE ($1::timestamptz IS NULL OR created_at >= $1)
         AND backfilled = false AND mode = 'SHADOW'
     ),
     all_hits AS (
       SELECT old_decision, v2_decision, hit
       FROM scoped, jsonb_array_elements(blacklist_hits || whitelist_hits || property_signal_hits || send_to_ai_hits) AS hit
     )
     SELECT
       hit->>'id' AS rule_id,
       hit->>'rule_group' AS rule_group,
       hit->>'pattern' AS pattern,
       hit->>'description' AS description,
       count(*)::int AS hit_count,
       count(*) FILTER (WHERE old_decision = 'SEND_TO_AI')::int AS old_send_to_ai_count,
       count(*) FILTER (WHERE v2_decision = 'SEND_TO_AI')::int AS v2_send_to_ai_count
     FROM all_hits
     GROUP BY 1, 2, 3, 4
     ORDER BY hit_count DESC, rule_id ASC
     LIMIT $2`,
    [periodStart, limit]
  );
  return rows.map((r) => ({
    ruleId: r.rule_id,
    ruleGroup: r.rule_group,
    pattern: r.pattern,
    description: r.description,
    hitCount: r.hit_count,
    oldSendToAiCount: r.old_send_to_ai_count,
    v2SendToAiCount: r.v2_send_to_ai_count,
  }));
}

// Phase 4 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase 4, requirement
// 11): how much of the period's telemetry is which mode. FALLBACK should
// be rare/zero in healthy operation -- a sustained non-zero count is one
// of the documented rollback triggers (docs/MATCHING_V2_PHASE4_GATE_CUTOVER.md).
async function getGateModeCounts(pool, { period = DEFAULT_PERIOD } = {}) {
  const periodStart = resolvePeriodStart(period);
  const { rows } = await pool.query(
    `SELECT mode, count(*)::int c
     FROM matching_dubai.shadow_gate_evaluations
     WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND backfilled = false
     GROUP BY 1`,
    [periodStart]
  );
  const counts = { SHADOW: 0, AUTHORITATIVE: 0, FALLBACK: 0 };
  for (const r of rows) counts[r.mode] = r.c;
  return counts;
}

// ACTUAL authoritative gate behavior (as opposed to getShadowSummary's
// PROJECTED view) -- only meaningful once cutover has actually been on
// for some of the period. `freshAiCalls`/`cacheHits` are computed via a
// JOIN to matching_dubai.match_runs on source_message_id (reliable: unlike the
// deferred "AI-confirmed-buyer" rule metric from Phase 3, this joins on
// the message's own real id, not a content-only hash) -- restricted to
// v2_decision = 'SEND_TO_AI' rows, since a deterministic REJECT never
// reaches the AI interpreter at all. Never fabricates a cost figure this
// join cannot support (spec section 11: "Do not fabricate cost figures").
async function getActualGateSummary(pool, { period = DEFAULT_PERIOD } = {}) {
  const periodStart = resolvePeriodStart(period);
  const { rows } = await pool.query(
    `SELECT
       count(*)::int AS evaluated,
       count(*) FILTER (WHERE v2_decision = 'SEND_TO_AI')::int AS v2_send_to_ai_count,
       count(*) FILTER (WHERE v2_decision = 'REJECT')::int AS v2_reject_count,
       count(*) FILTER (WHERE v2_reason = 'BLACKLIST')::int AS blacklist_reject_count,
       count(*) FILTER (WHERE v2_reason = 'INSUFFICIENT_BUYER_SIGNAL')::int AS insufficient_signal_count
     FROM matching_dubai.shadow_gate_evaluations
     WHERE mode = 'AUTHORITATIVE' AND ($1::timestamptz IS NULL OR created_at >= $1) AND backfilled = false`,
    [periodStart]
  );

  const { rows: fallbackRows } = await pool.query(
    `SELECT count(*)::int AS c FROM matching_dubai.shadow_gate_evaluations
     WHERE mode = 'FALLBACK' AND ($1::timestamptz IS NULL OR created_at >= $1)`,
    [periodStart]
  );

  const { rows: aiRows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE m.interpretation_source = 'ai')::int AS fresh_ai_calls,
       count(*) FILTER (WHERE m.interpretation_source = 'cache_ai')::int AS cache_hits
     FROM matching_dubai.shadow_gate_evaluations s
     JOIN matching_dubai.match_runs m ON m.source_message_id = s.source_message_id
     WHERE s.mode = 'AUTHORITATIVE' AND s.v2_decision = 'SEND_TO_AI'
       AND ($1::timestamptz IS NULL OR s.created_at >= $1)
       AND m.matcher_version = $2`,
    [periodStart, CURRENT_MATCHER_VERSION]
  );

  const r = rows[0];
  return {
    period,
    evaluated: r.evaluated,
    v2SendToAiCount: r.v2_send_to_ai_count,
    v2RejectCount: r.v2_reject_count,
    blacklistRejectCount: r.blacklist_reject_count,
    insufficientSignalCount: r.insufficient_signal_count,
    fallbackCount: fallbackRows[0].c,
    freshAiCalls: aiRows[0].fresh_ai_calls,
    cacheHits: aiRows[0].cache_hits,
  };
}

// Live rule performance statistics for the /settings rule cards (Settings
// UI simplification follow-up, 2026-09-27). Read-only, additive: reuses the
// exact same matching_dubai.shadow_gate_evaluations JSONB hit arrays as
// getRuleHitAnalytics() above, and the same rule identity already embedded
// in each hit object (`hit->>'id'`, from getEnabledIntakeRules()'s `id,
// rule_group, match_type, pattern, priority, description` -- see
// v2-intake-gate.js's findHits()/config-repository.js). No new schema, no
// new telemetry, no per-rule query.
//
// Unlike getRuleHitAnalytics() (which is SHADOW-only -- it answers "what
// WOULD V2 do"), Settings cards need "what IS V2 actually doing right now",
// so this scopes to mode IN ('AUTHORITATIVE', 'SHADOW') in ONE query and
// lets the caller pick AUTHORITATIVE-first per rule (spec: "Do NOT silently
// mix AUTHORITATIVE and SHADOW into one number unless explicitly
// labeled"). FALLBACK rows are excluded entirely -- they reflect a gate
// infrastructure failure, not real rule performance.
const RULE_STATS_PERIODS = ['24h', '7d', '30d'];
const DEFAULT_RULE_STATS_PERIOD = '24h';

function resolveRuleStatsPeriod(period) {
  return RULE_STATS_PERIODS.includes(period) ? period : DEFAULT_RULE_STATS_PERIOD;
}

async function getRulePerformanceStats(pool, { period = DEFAULT_RULE_STATS_PERIOD } = {}) {
  const resolvedPeriod = resolveRuleStatsPeriod(period);
  const periodStart = resolvePeriodStart(resolvedPeriod);
  const { rows } = await pool.query(
    `WITH scoped AS (
       SELECT mode, v2_decision, blacklist_hits, whitelist_hits, property_signal_hits, send_to_ai_hits
       FROM matching_dubai.shadow_gate_evaluations
       WHERE ($1::timestamptz IS NULL OR created_at >= $1)
         AND backfilled = false AND mode IN ('AUTHORITATIVE', 'SHADOW')
     ),
     all_hits AS (
       SELECT mode, v2_decision, hit
       FROM scoped, jsonb_array_elements(blacklist_hits || whitelist_hits || property_signal_hits || send_to_ai_hits) AS hit
     )
     SELECT
       hit->>'id' AS rule_id,
       hit->>'rule_group' AS rule_group,
       hit->>'match_type' AS match_type,
       hit->>'pattern' AS pattern,
       mode,
       count(*)::int AS hit_count,
       count(*) FILTER (WHERE v2_decision = 'SEND_TO_AI')::int AS v2_send_to_ai_count,
       count(*) FILTER (WHERE v2_decision = 'REJECT')::int AS v2_reject_count
     FROM all_hits
     GROUP BY 1, 2, 3, 4, 5`,
    [periodStart]
  );

  // Rule identity: prefer the stable DB id embedded in the hit payload
  // (spec section 2). Fallback ONLY if legacy telemetry lacks it --
  // group+match_type+pattern, same identity convention already used by
  // settings-view.js's duplicate-pattern detection.
  const byRule = new Map();
  for (const r of rows) {
    const key = r.rule_id != null ? `id:${r.rule_id}` : `key:${r.rule_group}::${r.match_type}::${r.pattern}`;
    if (!byRule.has(key)) byRule.set(key, { usedFallbackKey: r.rule_id == null, AUTHORITATIVE: null, SHADOW: null });
    byRule.get(key)[r.mode] = {
      hits: r.hit_count,
      v2SendToAi: r.v2_send_to_ai_count,
      v2Reject: r.v2_reject_count,
    };
  }

  // Collapse AUTHORITATIVE/SHADOW into ONE displayable stat per rule,
  // explicitly labeled (spec section 4) -- never averaged/summed together.
  const result = new Map();
  for (const [key, entry] of byRule) {
    const chosenMode = entry.AUTHORITATIVE ? 'AUTHORITATIVE' : entry.SHADOW ? 'SHADOW' : null;
    const stats = chosenMode ? entry[chosenMode] : { hits: 0, v2SendToAi: 0, v2Reject: 0 };
    result.set(key, {
      mode: chosenMode,
      usedFallbackKey: entry.usedFallbackKey,
      hits: stats.hits,
      v2SendToAi: stats.v2SendToAi,
      v2Reject: stats.v2Reject,
      hitToAiPct: safeRate(stats.v2SendToAi, stats.hits),
      hitToRejectPct: safeRate(stats.v2Reject, stats.hits),
    });
  }
  return { period: resolvedPeriod, byRule: result };
}

function ruleStatsKeyFor(rule) {
  return rule.id != null && Number(rule.id) > 0 ? `id:${rule.id}` : `key:${rule.rule_group}::${rule.match_type}::${rule.pattern}`;
}

// Group-level summary (spec section 10, optional). Deliberately computed
// from the SAME scoped rows as getRulePerformanceStats() above -- one more
// small, bounded aggregate query (grouped by rule_group + mode only, not
// per-rule), never a per-rule query. "Rule hits" intentionally overlap
// across a single message (spec: "Rule hits can overlap; one message may
// trigger multiple rules") -- this returns raw counts only, the UI layer
// adds the disclaimer text.
async function getRuleGroupPerformanceSummary(pool, { period = DEFAULT_RULE_STATS_PERIOD } = {}) {
  const resolvedPeriod = resolveRuleStatsPeriod(period);
  const periodStart = resolvePeriodStart(resolvedPeriod);
  const { rows } = await pool.query(
    `WITH scoped AS (
       SELECT mode, v2_decision, blacklist_hits, whitelist_hits, property_signal_hits, send_to_ai_hits
       FROM matching_dubai.shadow_gate_evaluations
       WHERE ($1::timestamptz IS NULL OR created_at >= $1)
         AND backfilled = false AND mode IN ('AUTHORITATIVE', 'SHADOW')
     ),
     by_group AS (
       SELECT mode, v2_decision, 'BLACKLIST'::text AS rule_group, blacklist_hits AS hits FROM scoped
       UNION ALL SELECT mode, v2_decision, 'WHITELIST', whitelist_hits FROM scoped
       UNION ALL SELECT mode, v2_decision, 'PROPERTY_SIGNAL', property_signal_hits FROM scoped
       UNION ALL SELECT mode, v2_decision, 'SEND_TO_AI', send_to_ai_hits FROM scoped
     ),
     -- Row-level counts (one row per evaluated message) -- computed
     -- WITHOUT unnesting, so jsonb_array_length()/count(*) stay at the
     -- correct per-message cardinality.
     group_counts AS (
       SELECT rule_group, mode,
         count(*) FILTER (WHERE jsonb_array_length(hits) > 0)::int AS messages_with_hit,
         count(*) FILTER (WHERE jsonb_array_length(hits) > 0 AND v2_decision = 'SEND_TO_AI')::int AS messages_reaching_ai,
         sum(jsonb_array_length(hits))::int AS total_rule_hits
       FROM by_group
       GROUP BY 1, 2
     ),
     -- Distinct rule ids -- a SEPARATE unnest over the same by_group rows,
     -- never combined with group_counts' row-level aggregates in one
     -- FROM clause (that would multiply message counts by hits-per-message).
     group_rule_ids AS (
       SELECT rule_group, mode, count(DISTINCT h->>'id')::int AS distinct_rule_ids
       FROM by_group, jsonb_array_elements(hits) AS h
       GROUP BY 1, 2
     )
     SELECT gc.rule_group, gc.mode, gc.messages_with_hit, gc.messages_reaching_ai, gc.total_rule_hits,
            coalesce(gri.distinct_rule_ids, 0) AS distinct_rule_ids
     FROM group_counts gc
     LEFT JOIN group_rule_ids gri ON gri.rule_group = gc.rule_group AND gri.mode = gc.mode`,
    [periodStart]
  );

  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.rule_group)) byGroup.set(r.rule_group, { AUTHORITATIVE: null, SHADOW: null });
    byGroup.get(r.rule_group)[r.mode] = {
      messagesWithHit: r.messages_with_hit,
      messagesReachingAi: r.messages_reaching_ai,
      totalRuleHits: r.total_rule_hits,
      distinctRuleIds: Number(r.distinct_rule_ids) || 0,
    };
  }

  const result = new Map();
  for (const [group, entry] of byGroup) {
    const chosenMode = entry.AUTHORITATIVE ? 'AUTHORITATIVE' : entry.SHADOW ? 'SHADOW' : null;
    result.set(group, { mode: chosenMode, ...(chosenMode ? entry[chosenMode] : { messagesWithHit: 0, messagesReachingAi: 0, totalRuleHits: 0, distinctRuleIds: 0 }) });
  }
  return { period: resolvedPeriod, byGroup: result };
}

module.exports = {
  PERIODS,
  DEFAULT_PERIOD,
  getShadowSummary,
  getDisagreementBreakdown,
  getRuleHitAnalytics,
  getGateModeCounts,
  getActualGateSummary,
  RULE_STATS_PERIODS,
  DEFAULT_RULE_STATS_PERIOD,
  resolveRuleStatsPeriod,
  getRulePerformanceStats,
  getRuleGroupPerformanceSummary,
  ruleStatsKeyFor,
};
