'use strict';

// Dashboard Summary v2 (Phase 1) — request-level query layer over the
// EXISTING matching_dubai.match_runs table. No schema change, no new view: see
// dashboard/SUMMARY_METRICS.md for the full rationale and known
// limitations behind every metric here.
//
// CORE PRINCIPLE (per the Phase 1 brief): every number here must have an
// unambiguous business meaning. Two structurally different systems once
// wrote into matching_dubai.match_runs -- lead-matching-service ("current
// matcher") and the legacy n8n pilot workflow ("legacy pilot") -- so
// every query here is explicitly scoped to ONE matcher_version. Nothing
// in this file ever aggregates across both without saying so.
//
// 2026-10-07: the legacy pilot's own dashboard section (getLegacySummary/
// renderLegacyPilot) was removed -- no longer relevant (the n8n pilot-v1
// workflow has been retired since 2026-10-02, AGENTS.md section 10, and
// produces no new rows). LEGACY_MATCHER_VERSION stays here and exported:
// the isolation tests in tests/integration/summary-queries.test.js use it
// to insert a known non-current-matcher row and assert every CURRENT
// query still excludes it -- that regression protection is unrelated to
// whether a legacy-specific widget exists on the page.
const CURRENT_MATCHER_VERSION = 'lead-matching-service-v1';
const LEGACY_MATCHER_VERSION = 'pilot-v1';

// Rolling intervals, not calendar-day buckets (Phase 1 brief section 6) --
// sidesteps timezone entirely for these KPIs. `null` means "all time" (no
// lower bound).
const PERIODS = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  all: null,
};
const DEFAULT_PERIOD = '7d';

function resolvePeriodStart(period) {
  const interval = Object.prototype.hasOwnProperty.call(PERIODS, period) ? PERIODS[period] : PERIODS[DEFAULT_PERIOD];
  if (!interval) return null; // 'all'
  return new Date(Date.now() - parseIntervalMs(interval));
}

function parseIntervalMs(interval) {
  const [amount, unit] = interval.split(' ');
  const n = Number(amount);
  const perUnit = { hours: 3600_000, days: 86_400_000 };
  return n * (perUnit[unit] || 0);
}

// Canonical request outcome (Phase 1 brief section 5): a single physical
// source_message_id can have more than one match_runs row (event retry,
// manual replay, or -- observed live, 4 real cases as of this writing --
// a genuine reprocess). Rule, encoded once here so every metric below
// agrees with every other one:
//   - prefer the latest NON-DUPLICATE row if one exists
//     (PARSER_ERROR at 10:00 then MATCH at 11:00 -> canonical MATCH;
//      MATCH at 10:00 then DUPLICATE at 10:01 -> canonical MATCH)
//   - only ever fall back to DUPLICATE when EVERY row for that message is
//     DUPLICATE
// Applied AFTER the period/provider filter, not before -- a period view
// reflects canonical outcomes among the rows that actually fall inside
// it, never bleeding in a status from outside the window (see
// SUMMARY_METRICS.md "period behavior").
function canonicalCte({ matcherVersionParamIndex, periodStartParamIndex, providerParamIndex }) {
  return `
    scoped AS (
      SELECT *
      FROM matching_dubai.match_runs
      WHERE matcher_version = $${matcherVersionParamIndex}
        AND ($${periodStartParamIndex}::timestamptz IS NULL OR created_at >= $${periodStartParamIndex})
        AND ($${providerParamIndex}::text IS NULL OR provider = $${providerParamIndex})
    ),
    canonical AS (
      SELECT DISTINCT ON (source_message_id) *
      FROM scoped
      ORDER BY source_message_id, (result_status <> 'DUPLICATE') DESC, created_at DESC
    )
  `;
}

// Every result_status this project's CHECK constraint allows maps to
// exactly one bucket -- including an explicit OTHER catch-all, so an
// unrecognized future status is never silently dropped from
// reconciliation (Phase 1 brief section 11). STRONG_MATCH is bucketed as
// "matched" generically (not hardcoded to only recognize the literal
// string 'MATCH') so this stays correct if the current matcher ever
// gains a STRONG_MATCH concept -- it does not have one today (verified:
// 0 STRONG_MATCH rows under lead-matching-service-v1 as of this writing).
const BUCKET_CASE_SQL = `
  CASE
    WHEN result_status = 'DUPLICATE' THEN 'duplicates'
    WHEN result_status = 'REJECTED' THEN 'rejected'
    WHEN result_status = 'INSUFFICIENT_CRITERIA' THEN 'insufficientCriteria'
    WHEN result_status IN ('PARSER_ERROR', 'ERROR') THEN 'errors'
    WHEN result_status IN ('MATCH', 'STRONG_MATCH') THEN 'matched'
    WHEN result_status = 'NO_MATCH' THEN 'noMatch'
    ELSE 'other'
  END
`;

const EMPTY_FLOW_BUCKETS = { duplicates: 0, rejected: 0, insufficientCriteria: 0, errors: 0, matched: 0, noMatch: 0, other: 0 };

function safeRate(numerator, denominator) {
  if (!denominator) return null; // zero-safe: no eligible requests -> no rate, never NaN/Infinity
  return numerator / denominator;
}

// Request Flow + Executive KPIs, scoped to one matcher_version/period/
// provider. Bucket sum ALWAYS equals `processed` by construction (every
// canonical row lands in exactly one bucket, including OTHER) -- the
// `reconciled` flag is a defensive assertion, not a hope.
async function getRequestFlow(pool, { matcherVersion, period = DEFAULT_PERIOD, provider = null } = {}) {
  const periodStart = resolvePeriodStart(period);
  const { rows } = await pool.query(
    `WITH ${canonicalCte({ matcherVersionParamIndex: 1, periodStartParamIndex: 2, providerParamIndex: 3 })}
     SELECT ${BUCKET_CASE_SQL} AS bucket, count(*)::int AS c
     FROM canonical
     GROUP BY 1`,
    [matcherVersion, periodStart, provider]
  );

  const buckets = { ...EMPTY_FLOW_BUCKETS };
  for (const row of rows) buckets[row.bucket] = row.c;

  const processed = Object.values(buckets).reduce((a, b) => a + b, 0);
  const matchEligible = buckets.matched + buckets.noMatch;
  const reconciled =
    buckets.duplicates + buckets.rejected + buckets.insufficientCriteria + buckets.errors + matchEligible + buckets.other === processed;

  return {
    period,
    provider,
    processed,
    duplicates: buckets.duplicates,
    rejected: buckets.rejected,
    insufficientCriteria: buckets.insufficientCriteria,
    errors: buckets.errors,
    other: buckets.other,
    matchEligible,
    matched: buckets.matched,
    noMatch: buckets.noMatch,
    matchRate: safeRate(buckets.matched, matchEligible),
    reconciled,
  };
}

// Interpretation (current matcher only -- triage_decision/
// interpretation_source only ever populated for lead-matching-service
// rows; always NULL for legacy). Denominators are documented explicitly
// in SUMMARY_METRICS.md: `triageTotal` excludes rows that never reach
// triage at all (content/event duplicates, and cache hits which record
// interpretation_source but skip a fresh evaluateTriage() call).
async function getInterpretation(pool, { period = DEFAULT_PERIOD, provider = null } = {}) {
  const periodStart = resolvePeriodStart(period);
  const { rows } = await pool.query(
    `WITH ${canonicalCte({ matcherVersionParamIndex: 1, periodStartParamIndex: 2, providerParamIndex: 3 })}
     SELECT triage_decision, interpretation_source, count(*)::int AS c
     FROM canonical
     GROUP BY 1, 2`,
    [CURRENT_MATCHER_VERSION, periodStart, provider]
  );

  const triage = { PARSED_LOCALLY: 0, AI_REVIEW: 0, REJECT: 0 };
  const interpretation = { local: 0, cache_local: 0, ai: 0, cache_ai: 0 };

  for (const row of rows) {
    if (row.triage_decision && Object.prototype.hasOwnProperty.call(triage, row.triage_decision)) {
      triage[row.triage_decision] += row.c;
    }
    if (row.interpretation_source && Object.prototype.hasOwnProperty.call(interpretation, row.interpretation_source)) {
      interpretation[row.interpretation_source] += row.c;
    }
  }

  const triageTotal = triage.PARSED_LOCALLY + triage.AI_REVIEW + triage.REJECT;
  const localTotal = interpretation.local + interpretation.cache_local;
  const aiTotal = interpretation.ai + interpretation.cache_ai;
  const cacheTotal = interpretation.cache_local + interpretation.cache_ai;
  const interpretationTotal = localTotal + aiTotal;

  return {
    period,
    provider,
    triage,
    triageTotal,
    aiReviewRate: safeRate(triage.AI_REVIEW, triageTotal),
    interpretation,
    localTotal,
    aiTotal,
    cacheTotal,
    interpretationTotal,
    aiCacheHitRate: safeRate(cacheTotal, interpretationTotal),
  };
}

// Why Requests Did Not Match -- current matcher only, top 8 + Other.
// Vocabulary is read from the data, never hardcoded (Phase 1 brief
// section 13) -- current and legacy no_match_reason strings are
// deliberately incompatible taxonomies (confirmed: only
// "property_type_mismatch" happens to overlap), so this is ALWAYS scoped
// to one matcher_version, never both.
async function getNoMatchReasons(pool, { matcherVersion, period = DEFAULT_PERIOD, provider = null, limit = 8 } = {}) {
  const periodStart = resolvePeriodStart(period);
  const { rows } = await pool.query(
    `WITH ${canonicalCte({ matcherVersionParamIndex: 1, periodStartParamIndex: 2, providerParamIndex: 3 })}
     SELECT no_match_reason, count(*)::int AS c
     FROM canonical
     WHERE no_match_reason IS NOT NULL
     GROUP BY 1
     ORDER BY c DESC, no_match_reason ASC`,
    [matcherVersion, periodStart, provider]
  );

  const total = rows.reduce((sum, r) => sum + r.c, 0);
  const top = rows.slice(0, limit);
  const otherCount = rows.slice(limit).reduce((sum, r) => sum + r.c, 0);

  const withShare = (reason, count) => ({ reason, count, share: safeRate(count, total) });
  const reasons = top.map((r) => withShare(r.no_match_reason, r.c));
  if (otherCount > 0) reasons.push(withShare('other', otherCount));

  return { period, provider, total, reasons };
}

// Traffic by Provider -- current matcher only (legacy never populates
// `provider`, confirmed: 100% NULL for matcher_version='pilot-v1').
async function getProviderBreakdown(pool, { period = DEFAULT_PERIOD } = {}) {
  const providers = ['telegram', 'whatsapp'];
  const results = await Promise.all(
    providers.map((provider) => getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period, provider }))
  );
  return providers.map((provider, i) => ({ provider, ...results[i] }));
}

async function getActiveStock(pool) {
  const { rows } = await pool.query(`SELECT count(*)::int AS c FROM matching_dubai.stock_inventory WHERE status = 'ACTIVE'`);
  return rows[0].c;
}

module.exports = {
  CURRENT_MATCHER_VERSION,
  LEGACY_MATCHER_VERSION,
  PERIODS,
  DEFAULT_PERIOD,
  resolvePeriodStart,
  getRequestFlow,
  getInterpretation,
  getNoMatchReasons,
  getProviderBreakdown,
  getActiveStock,
};
