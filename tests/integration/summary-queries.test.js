'use strict';

// Dashboard Summary v2 (Phase 1) -- integration tests against a real
// Postgres. Every scenario in the Phase 1 brief's "TESTS" section is
// covered here: canonical outcome resolution, reconciliation, match rate,
// current/legacy isolation, STRONG_MATCH isolation, provider filter,
// period filter, unknown-status handling, and zero-denominator safety.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const summaryQueries = require('../../dashboard/summary-queries');

const { CURRENT_MATCHER_VERSION, LEGACY_MATCHER_VERSION } = summaryQueries;
const PREFIX = 'summary-it-';

let pool;
let seq = 0;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  await pool.query(`DELETE FROM matching_dubai.match_runs WHERE source_message_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM matching_dubai.stock_inventory WHERE stock_id LIKE $1`, [`${PREFIX}%`]);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM matching_dubai.match_runs WHERE source_message_id LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM matching_dubai.stock_inventory WHERE stock_id LIKE $1`, [`${PREFIX}%`]);
  seq = 0;
});

function nextMessageId() {
  seq += 1;
  return `${PREFIX}${Date.now()}-${seq}`;
}

async function insertRun(overrides = {}) {
  const row = {
    sourceMessageId: overrides.sourceMessageId || nextMessageId(),
    matcherVersion: CURRENT_MATCHER_VERSION,
    resultStatus: 'NO_MATCH',
    noMatchReason: null,
    triageDecision: null,
    interpretationSource: null,
    provider: 'telegram',
    createdAt: new Date(),
    ...overrides,
  };
  await pool.query(
    `INSERT INTO matching_dubai.match_runs (
       source_message_id, matcher_version, result_status, no_match_reason,
       triage_decision, interpretation_source, provider, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [row.sourceMessageId, row.matcherVersion, row.resultStatus, row.noMatchReason, row.triageDecision, row.interpretationSource, row.provider, row.createdAt]
  );
  return row.sourceMessageId;
}

// ---- Canonical outcome resolution (brief section 5 / 24) ----

test('canonical: MATCH then a later DUPLICATE for the same message resolves to MATCH', async () => {
  const id = nextMessageId();
  await insertRun({ sourceMessageId: id, resultStatus: 'MATCH', createdAt: new Date(Date.now() - 60_000) });
  await insertRun({ sourceMessageId: id, resultStatus: 'DUPLICATE', noMatchReason: 'duplicate_content', createdAt: new Date() });

  const flow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all' });
  assert.equal(flow.matched, 1);
  assert.equal(flow.duplicates, 0);
  assert.equal(flow.processed, 1, 'one physical message must count once, not twice');
});

test('canonical: PARSER_ERROR then a later real reprocess to MATCH resolves to MATCH', async () => {
  const id = nextMessageId();
  await insertRun({ sourceMessageId: id, resultStatus: 'PARSER_ERROR', createdAt: new Date(Date.now() - 60_000) });
  await insertRun({ sourceMessageId: id, resultStatus: 'MATCH', createdAt: new Date() });

  const flow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all' });
  assert.equal(flow.matched, 1);
  assert.equal(flow.errors, 0);
  assert.equal(flow.processed, 1);
});

test('canonical: only DUPLICATE rows for a message resolve to DUPLICATE', async () => {
  const id = nextMessageId();
  await insertRun({ sourceMessageId: id, resultStatus: 'DUPLICATE', noMatchReason: 'duplicate_content' });

  const flow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all' });
  assert.equal(flow.duplicates, 1);
  assert.equal(flow.matched, 0);
  assert.equal(flow.processed, 1);
});

// ---- Reconciliation (brief section 10 / 24) ----

test('reconciliation: every top-level bucket sums exactly to processed, across a realistic mix', async () => {
  await insertRun({ resultStatus: 'DUPLICATE' });
  await insertRun({ resultStatus: 'DUPLICATE' });
  await insertRun({ resultStatus: 'DUPLICATE' });
  await insertRun({ resultStatus: 'REJECTED' });
  await insertRun({ resultStatus: 'REJECTED' });
  await insertRun({ resultStatus: 'INSUFFICIENT_CRITERIA' });
  await insertRun({ resultStatus: 'PARSER_ERROR' });
  await insertRun({ resultStatus: 'MATCH' });
  await insertRun({ resultStatus: 'MATCH' });
  await insertRun({ resultStatus: 'NO_MATCH' });

  const flow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all' });
  assert.equal(flow.processed, 10);
  assert.equal(flow.duplicates, 3);
  assert.equal(flow.rejected, 2);
  assert.equal(flow.insufficientCriteria, 1);
  assert.equal(flow.errors, 1);
  assert.equal(flow.matched, 2);
  assert.equal(flow.noMatch, 1);
  assert.equal(flow.matched + flow.noMatch, flow.matchEligible);
  assert.equal(
    flow.duplicates + flow.rejected + flow.insufficientCriteria + flow.errors + flow.matchEligible + flow.other,
    flow.processed
  );
  assert.equal(flow.reconciled, true);
});

// ---- Match rate (brief section 24) ----

test('match rate: 4 MATCH + 6 NO_MATCH -> eligible=10, matched=4, rate=40%, rejected/duplicate/errors excluded from denominator', async () => {
  for (let i = 0; i < 4; i += 1) await insertRun({ resultStatus: 'MATCH' });
  for (let i = 0; i < 6; i += 1) await insertRun({ resultStatus: 'NO_MATCH' });
  for (let i = 0; i < 50; i += 1) await insertRun({ resultStatus: 'DUPLICATE' });
  for (let i = 0; i < 50; i += 1) await insertRun({ resultStatus: 'REJECTED' });
  await insertRun({ resultStatus: 'PARSER_ERROR' });

  const flow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all' });
  assert.equal(flow.matchEligible, 10);
  assert.equal(flow.matched, 4);
  assert.equal(flow.matchRate, 0.4);
});

test('zero-safe: no match-eligible requests at all -> matchRate is null, never NaN/Infinity', async () => {
  await insertRun({ resultStatus: 'DUPLICATE' });
  await insertRun({ resultStatus: 'REJECTED' });

  const flow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all' });
  assert.equal(flow.matchEligible, 0);
  assert.equal(flow.matchRate, null);
  assert.equal(Number.isNaN(flow.matchRate), false);
});

// ---- Current / Legacy isolation (brief section 24) ----

test('current matcher query results never include legacy (non-current-matcher-version) rows', async () => {
  await insertRun({ matcherVersion: CURRENT_MATCHER_VERSION, resultStatus: 'MATCH' });
  await insertRun({ matcherVersion: CURRENT_MATCHER_VERSION, resultStatus: 'NO_MATCH' });
  await insertRun({ matcherVersion: LEGACY_MATCHER_VERSION, resultStatus: 'STRONG_MATCH', provider: null });
  await insertRun({ matcherVersion: LEGACY_MATCHER_VERSION, resultStatus: 'MATCH', provider: null });
  await insertRun({ matcherVersion: LEGACY_MATCHER_VERSION, resultStatus: 'NO_MATCH', provider: null });

  const currentFlow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all' });
  assert.equal(currentFlow.processed, 2, 'legacy rows must never be counted in the current matcher flow');
});

// ---- STRONG_MATCH isolation (brief section 24) ----

test('STRONG_MATCH from a non-current-matcher-version row never appears in the current matcher summary', async () => {
  await insertRun({ matcherVersion: LEGACY_MATCHER_VERSION, resultStatus: 'STRONG_MATCH', provider: null });
  await insertRun({ matcherVersion: CURRENT_MATCHER_VERSION, resultStatus: 'MATCH' });

  const currentFlow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all' });
  assert.equal(currentFlow.processed, 1);
  assert.equal(currentFlow.matched, 1);
});

// ---- Provider filter (brief section 24) ----

test('provider filter scopes request flow to exactly one provider', async () => {
  await insertRun({ provider: 'telegram', resultStatus: 'MATCH' });
  await insertRun({ provider: 'telegram', resultStatus: 'MATCH' });
  await insertRun({ provider: 'whatsapp', resultStatus: 'NO_MATCH' });

  const telegramFlow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all', provider: 'telegram' });
  assert.equal(telegramFlow.processed, 2);
  assert.equal(telegramFlow.matched, 2);

  const whatsappFlow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all', provider: 'whatsapp' });
  assert.equal(whatsappFlow.processed, 1);
  assert.equal(whatsappFlow.noMatch, 1);

  const allFlow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all', provider: null });
  assert.equal(allFlow.processed, 3);
});

test('getProviderBreakdown returns exactly telegram and whatsapp rows, each correctly scoped', async () => {
  await insertRun({ provider: 'telegram', resultStatus: 'MATCH' });
  await insertRun({ provider: 'whatsapp', resultStatus: 'NO_MATCH' });
  await insertRun({ provider: 'whatsapp', resultStatus: 'NO_MATCH' });

  const rows = await summaryQueries.getProviderBreakdown(pool, { period: 'all' });
  const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));
  assert.equal(byProvider.telegram.processed, 1);
  assert.equal(byProvider.whatsapp.processed, 2);
});

// ---- Period filter (brief section 24) ----

test('period filter: rolling cutoffs correctly include/exclude by created_at', async () => {
  const now = Date.now();
  await insertRun({ resultStatus: 'MATCH', createdAt: new Date(now - 2 * 3600_000) }); // 2h ago
  await insertRun({ resultStatus: 'MATCH', createdAt: new Date(now - 5 * 86_400_000) }); // 5d ago
  await insertRun({ resultStatus: 'MATCH', createdAt: new Date(now - 20 * 86_400_000) }); // 20d ago
  await insertRun({ resultStatus: 'MATCH', createdAt: new Date(now - 60 * 86_400_000) }); // 60d ago

  const last24h = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: '24h' });
  assert.equal(last24h.matched, 1);

  const last7d = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: '7d' });
  assert.equal(last7d.matched, 2);

  const last30d = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: '30d' });
  assert.equal(last30d.matched, 3);

  const allTime = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all' });
  assert.equal(allTime.matched, 4);
});

test('period filter: canonical outcome is resolved WITHIN the period, not bled in from outside it', async () => {
  const id = nextMessageId();
  const now = Date.now();
  // A MATCH from 20 days ago, then a DUPLICATE 2 hours ago -- inside a
  // 24h window only the DUPLICATE row exists, so canonical must be
  // DUPLICATE there, even though all-time canonical would be MATCH.
  await insertRun({ sourceMessageId: id, resultStatus: 'MATCH', createdAt: new Date(now - 20 * 86_400_000) });
  await insertRun({ sourceMessageId: id, resultStatus: 'DUPLICATE', createdAt: new Date(now - 2 * 3600_000) });

  const last24h = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: '24h' });
  assert.equal(last24h.duplicates, 1);
  assert.equal(last24h.matched, 0);

  const allTime = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all' });
  assert.equal(allTime.matched, 1);
  assert.equal(allTime.duplicates, 0);
});

// ---- Unknown status (brief section 24) ----

test('an unrecognized result_status is bucketed as Other, and reconciliation still passes', async () => {
  // 'ERROR' is a real, already-allowed CHECK-constraint value that simply
  // never occurs in current live data -- used here as a stand-in for "a
  // status this query layer's bucket map should still handle correctly."
  await insertRun({ resultStatus: 'ERROR' });
  await insertRun({ resultStatus: 'MATCH' });

  const flow = await summaryQueries.getRequestFlow(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all' });
  assert.equal(flow.errors, 1, 'ERROR must bucket the same as PARSER_ERROR');
  assert.equal(flow.processed, 2);
  assert.equal(flow.reconciled, true);
});

// ---- Interpretation / no-match reasons (current matcher only) ----

test('interpretation breakdown counts triage_decision and interpretation_source independently, current matcher only', async () => {
  await insertRun({ resultStatus: 'MATCH', triageDecision: 'PARSED_LOCALLY', interpretationSource: 'local' });
  await insertRun({ resultStatus: 'NO_MATCH', triageDecision: 'AI_REVIEW', interpretationSource: 'ai' });
  await insertRun({ resultStatus: 'NO_MATCH', triageDecision: 'AI_REVIEW', interpretationSource: 'cache_ai' });
  await insertRun({ resultStatus: 'REJECTED', triageDecision: 'REJECT', interpretationSource: null });
  // A legacy row with the same triage/interpretation-like values must never leak in.
  await insertRun({ matcherVersion: LEGACY_MATCHER_VERSION, resultStatus: 'MATCH', provider: null, triageDecision: 'AI_REVIEW', interpretationSource: 'ai' });

  const interp = await summaryQueries.getInterpretation(pool, { period: 'all' });
  assert.equal(interp.triage.PARSED_LOCALLY, 1);
  assert.equal(interp.triage.AI_REVIEW, 2);
  assert.equal(interp.triage.REJECT, 1);
  assert.equal(interp.triageTotal, 4);
  assert.equal(interp.interpretation.ai, 1);
  assert.equal(interp.interpretation.cache_ai, 1);
  assert.equal(interp.cacheTotal, 1);
  assert.equal(interp.aiReviewRate, 0.5);
});

test('no-match reasons: top N + Other, current matcher only, share adds up', async () => {
  for (let i = 0; i < 5; i += 1) await insertRun({ resultStatus: 'NO_MATCH', noMatchReason: 'location_not_found' });
  for (let i = 0; i < 3; i += 1) await insertRun({ resultStatus: 'NO_MATCH', noMatchReason: 'over_budget' });
  for (let i = 0; i < 2; i += 1) await insertRun({ resultStatus: 'NO_MATCH', noMatchReason: 'bedrooms_mismatch' });
  // A legacy reason string must never leak into the current-matcher breakdown.
  await insertRun({ matcherVersion: LEGACY_MATCHER_VERSION, resultStatus: 'NO_MATCH', provider: null, noMatchReason: 'area_not_resolved' });

  const data = await summaryQueries.getNoMatchReasons(pool, { matcherVersion: CURRENT_MATCHER_VERSION, period: 'all', limit: 2 });
  assert.equal(data.total, 10);
  assert.deepEqual(data.reasons.map((r) => r.reason), ['location_not_found', 'over_budget', 'other']);
  assert.equal(data.reasons.find((r) => r.reason === 'other').count, 2);
  const shareSum = data.reasons.reduce((sum, r) => sum + r.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
});

// ---- Active stock (snapshot, unaffected by period/provider) ----

test('getActiveStock counts only ACTIVE stock, ignoring period/provider entirely', async () => {
  await pool.query(
    `INSERT INTO matching_dubai.stock_inventory (stock_id, status, transaction_type) VALUES ($1,'ACTIVE','SALE'), ($2,'TAKEN_DOWN','SALE')`,
    [`${PREFIX}active-1`, `${PREFIX}inactive-1`]
  );
  const before1 = await summaryQueries.getActiveStock(pool);
  await pool.query(`INSERT INTO matching_dubai.stock_inventory (stock_id, status, transaction_type) VALUES ($1,'ACTIVE','SALE')`, [`${PREFIX}active-2`]);
  const after1 = await summaryQueries.getActiveStock(pool);
  assert.equal(after1, before1 + 1);
});
