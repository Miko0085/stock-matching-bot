'use strict';

// Nika Matching V2, Phase 3 -- integration tests for dashboard/shadow-queries.js
// against a real Postgres (migration 0022). Inserts real rows via the same
// repository the live shadow-evaluator uses, then verifies every aggregate
// formula (Phase 3 requirements 9-11): projected AI savings math,
// zero-denominator safety, disagreement breakdown categories, and rule-hit
// analytics extracted from the JSONB hit arrays.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const shadowQueries = require('../../dashboard/shadow-queries');
const { insertShadowEvaluation } = require('../../dubai-lead-matching-service/src/repositories/shadow-repository');

const PREFIX = 'shadow-q-it-';

let pool;
let seq = 0;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  await pool.query(`DELETE FROM matching_dubai.shadow_gate_evaluations WHERE source_message_id LIKE $1`, [`${PREFIX}%`]);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM matching_dubai.shadow_gate_evaluations WHERE source_message_id LIKE $1`, [`${PREFIX}%`]);
  seq = 0;
});

function nextMessageId() {
  seq += 1;
  return `${PREFIX}${Date.now()}-${seq}`;
}

function whitelistHit(overrides = {}) {
  return { id: '17', rule_group: 'WHITELIST', match_type: 'REGEX', pattern: '\\bneed\\b', priority: 100, description: 'test rule', ...overrides };
}

async function row(overrides = {}) {
  return insertShadowEvaluation(pool, {
    sourceMessageId: nextMessageId(),
    provider: 'telegram',
    oldDecision: 'SEND_TO_AI',
    v2Decision: 'REJECT',
    v2Reason: 'INSUFFICIENT_BUYER_SIGNAL',
    blacklistHits: [],
    whitelistHits: [],
    propertySignalHits: [],
    sendToAiHits: [],
    disagreement: true,
    projectedAiSaved: true,
    projectedAiAdded: false,
    ...overrides,
  });
}

test('getShadowSummary: zero rows in the period is completely safe (no NaN/Infinity, everything zero or null)', async () => {
  const summary = await shadowQueries.getShadowSummary(pool, { period: '24h' });
  assert.equal(summary.evaluated, 0);
  assert.equal(summary.oldSendToAiCount, 0);
  assert.equal(summary.netProjectedAiChange, 0);
  assert.equal(summary.projectedAiReductionPct, null);
  assert.equal(summary.agreementRate, null);
});

test('getShadowSummary: math reconciles for a known mix of old/v2 SEND_TO_AI outcomes', async () => {
  // 3 old SEND_TO_AI -> V2 REJECT (all 3 saved), 1 old REJECT_WITHOUT_AI -> V2 SEND_TO_AI (added), 1 agreement (REJECT/REJECT).
  await row({ oldDecision: 'SEND_TO_AI', v2Decision: 'REJECT', disagreement: true, projectedAiSaved: true, projectedAiAdded: false });
  await row({ oldDecision: 'SEND_TO_AI', v2Decision: 'REJECT', disagreement: true, projectedAiSaved: true, projectedAiAdded: false });
  await row({ oldDecision: 'SEND_TO_AI', v2Decision: 'REJECT', disagreement: true, projectedAiSaved: true, projectedAiAdded: false });
  await row({ oldDecision: 'REJECT_WITHOUT_AI', v2Decision: 'SEND_TO_AI', v2Reason: 'SEND_TO_AI_RULE', disagreement: true, projectedAiSaved: false, projectedAiAdded: true });
  await row({ oldDecision: 'REJECT_WITHOUT_AI', v2Decision: 'REJECT', disagreement: false, projectedAiSaved: false, projectedAiAdded: false });

  const summary = await shadowQueries.getShadowSummary(pool, { period: 'all' });
  assert.equal(summary.evaluated, 5);
  assert.equal(summary.oldSendToAiCount, 3);
  assert.equal(summary.v2SendToAiCount, 1);
  assert.equal(summary.projectedAiSavedCount, 3);
  assert.equal(summary.projectedAiAddedCount, 1);
  assert.equal(summary.netProjectedAiChange, 1 - 3);
  assert.equal(summary.projectedAiReductionPct, ((3 - 1) / 3) * 100);
  assert.equal(summary.disagreementCount, 4);
  assert.equal(summary.agreementCount, 1);
  assert.equal(summary.agreementRate, 1 / 5);
});

test('getShadowSummary: a backfilled row is excluded from the live aggregate', async () => {
  await row({ oldDecision: 'SEND_TO_AI', v2Decision: 'SEND_TO_AI', disagreement: false, backfilled: true });
  const summary = await shadowQueries.getShadowSummary(pool, { period: 'all' });
  assert.equal(summary.evaluated, 0);
});

test('getDisagreementBreakdown: each of the 7 categories counts only its own exact scenario', async () => {
  await row({ oldDecision: 'SEND_TO_AI', v2Decision: 'REJECT', v2Reason: 'INSUFFICIENT_BUYER_SIGNAL', disagreement: true });
  await row({ oldDecision: 'REJECT_WITHOUT_AI', v2Decision: 'SEND_TO_AI', v2Reason: 'WHITELIST_AND_PROPERTY_SIGNAL', disagreement: true });
  await row({ oldDecision: 'PARSED_LOCALLY', v2Decision: 'SEND_TO_AI', v2Reason: 'WHITELIST_AND_PROPERTY_SIGNAL', disagreement: true });
  await row({ oldDecision: 'SEND_TO_AI', v2Decision: 'REJECT', v2Reason: 'BLACKLIST', disagreement: true, blacklistHits: [{ id: '1', rule_group: 'BLACKLIST', pattern: 'x' }] });
  await row({ oldDecision: 'SEND_TO_AI', v2Decision: 'REJECT', v2Reason: 'INSUFFICIENT_BUYER_SIGNAL', disagreement: true, whitelistHits: [], propertySignalHits: [whitelistHit({ id: '33', rule_group: 'PROPERTY_SIGNAL' })] });
  await row({ oldDecision: 'SEND_TO_AI', v2Decision: 'REJECT', v2Reason: 'INSUFFICIENT_BUYER_SIGNAL', disagreement: true, whitelistHits: [whitelistHit()], propertySignalHits: [] });
  await row({ oldDecision: 'REJECT_WITHOUT_AI', v2Decision: 'SEND_TO_AI', v2Reason: 'SEND_TO_AI_RULE', disagreement: true, sendToAiHits: [{ id: '99', rule_group: 'SEND_TO_AI', pattern: 'urgent' }] });

  const breakdown = await shadowQueries.getDisagreementBreakdown(pool, { period: 'all' });
  assert.equal(breakdown.oldSendToAiV2Reject, 4, 'this counts EVERY old SEND_TO_AI -> V2 REJECT row regardless of v2_reason, including the blacklist/missing-signal ones');
  assert.equal(breakdown.oldRejectV2SendToAi, 2, 'counts every old REJECT_WITHOUT_AI -> V2 SEND_TO_AI row regardless of v2_reason, including the SEND_TO_AI-exception-rule one');
  assert.equal(breakdown.oldParsedLocallyV2SendToAi, 1);
  assert.equal(breakdown.blacklistDisagreement, 1);
  assert.equal(breakdown.missingWhitelistSignal, 1);
  assert.equal(breakdown.missingPropertySignal, 1);
  assert.equal(breakdown.sendToAiExceptionRuleHit, 1);
});

test('getRuleHitAnalytics: aggregates hits across all 4 hit-array columns by embedded rule id, without any join to intake_rules', async () => {
  await row({ oldDecision: 'SEND_TO_AI', v2Decision: 'SEND_TO_AI', v2Reason: 'WHITELIST_AND_PROPERTY_SIGNAL', disagreement: false, whitelistHits: [whitelistHit()], propertySignalHits: [whitelistHit({ id: '33', rule_group: 'PROPERTY_SIGNAL', pattern: '\\bbr\\b' })] });
  await row({ oldDecision: 'REJECT_WITHOUT_AI', v2Decision: 'SEND_TO_AI', v2Reason: 'WHITELIST_AND_PROPERTY_SIGNAL', disagreement: true, whitelistHits: [whitelistHit()], propertySignalHits: [whitelistHit({ id: '33', rule_group: 'PROPERTY_SIGNAL', pattern: '\\bbr\\b' })] });

  const rows = await shadowQueries.getRuleHitAnalytics(pool, { period: 'all' });
  const whitelistRow = rows.find((r) => r.ruleId === '17');
  const propertyRow = rows.find((r) => r.ruleId === '33');
  assert.ok(whitelistRow, 'the whitelist rule (id 17) must appear in the analytics');
  assert.equal(whitelistRow.hitCount, 2);
  assert.equal(whitelistRow.oldSendToAiCount, 1);
  assert.equal(whitelistRow.v2SendToAiCount, 2);
  assert.ok(propertyRow, 'the property-signal rule (id 33) must appear in the analytics');
  assert.equal(propertyRow.hitCount, 2);
});

// ---- getRulePerformanceStats / getRuleGroupPerformanceSummary -----------
// (Settings rule-card live statistics, 2026-09-27, read-only on top of the
// SAME matching_dubai.shadow_gate_evaluations telemetry -- no new schema.)

test('getRulePerformanceStats: unnests all 4 hit-array columns (blacklist/whitelist/property_signal/send_to_ai) and splits by v2_decision', async () => {
  await row({
    mode: 'AUTHORITATIVE', oldDecision: null, v2Decision: 'REJECT', v2Reason: 'BLACKLIST',
    blacklistHits: [{ id: '50', rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'сдам' }],
  });
  await row({
    mode: 'AUTHORITATIVE', oldDecision: null, v2Decision: 'SEND_TO_AI', v2Reason: 'SEND_TO_AI_RULE',
    sendToAiHits: [{ id: '60', rule_group: 'SEND_TO_AI', match_type: 'PHRASE', pattern: 'urgent' }],
  });

  const { byRule } = await shadowQueries.getRulePerformanceStats(pool, { period: 'all' });
  const blacklistStat = byRule.get('id:50');
  const sendToAiStat = byRule.get('id:60');
  assert.ok(blacklistStat, 'blacklist_hits must be unnested and attributed to its rule id');
  assert.equal(blacklistStat.hits, 1);
  assert.equal(blacklistStat.v2Reject, 1);
  assert.equal(blacklistStat.v2SendToAi, 0);
  assert.ok(sendToAiStat, 'send_to_ai_hits must be unnested and attributed to its rule id');
  assert.equal(sendToAiStat.v2SendToAi, 1);
});

test('getRulePerformanceStats: groups by the embedded rule id, not by pattern text alone -- two different rule ids sharing a pattern stay separate', async () => {
  await row({ mode: 'AUTHORITATIVE', oldDecision: null, v2Decision: 'REJECT', blacklistHits: [{ id: '70', rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'shared' }] });
  await row({ mode: 'AUTHORITATIVE', oldDecision: null, v2Decision: 'REJECT', blacklistHits: [{ id: '71', rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'shared' }] });

  const { byRule } = await shadowQueries.getRulePerformanceStats(pool, { period: 'all' });
  assert.equal(byRule.get('id:70').hits, 1);
  assert.equal(byRule.get('id:71').hits, 1);
});

test('getRulePerformanceStats: AUTHORITATIVE rows are preferred over SHADOW for the same rule id; SHADOW is used only when AUTHORITATIVE is absent', async () => {
  const hit = { id: '80', rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'need' };
  await row({ mode: 'SHADOW', oldDecision: 'SEND_TO_AI', v2Decision: 'SEND_TO_AI', whitelistHits: [hit] });
  await row({ mode: 'SHADOW', oldDecision: 'SEND_TO_AI', v2Decision: 'SEND_TO_AI', whitelistHits: [hit] });
  await row({ mode: 'AUTHORITATIVE', oldDecision: null, v2Decision: 'SEND_TO_AI', whitelistHits: [hit] });

  const { byRule } = await shadowQueries.getRulePerformanceStats(pool, { period: 'all' });
  const stat = byRule.get('id:80');
  assert.equal(stat.mode, 'AUTHORITATIVE', 'AUTHORITATIVE must win even though SHADOW has more rows');
  assert.equal(stat.hits, 1, 'must show ONLY the AUTHORITATIVE count, never a mix of the two modes');
});

test('getRulePerformanceStats: a rule with ONLY SHADOW telemetry (no AUTHORITATIVE rows at all) falls back to labeled SHADOW stats', async () => {
  const hit = { id: '81', rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'seeking' };
  await row({ mode: 'SHADOW', oldDecision: 'SEND_TO_AI', v2Decision: 'SEND_TO_AI', whitelistHits: [hit] });

  const { byRule } = await shadowQueries.getRulePerformanceStats(pool, { period: 'all' });
  const stat = byRule.get('id:81');
  assert.equal(stat.mode, 'SHADOW');
  assert.equal(stat.hits, 1);
});

test('getRulePerformanceStats: FALLBACK-mode rows are excluded entirely, even though they carry real hits', async () => {
  const hit = { id: '82', rule_group: 'BLACKLIST', match_type: 'PHRASE', pattern: 'fallback-only' };
  await row({ mode: 'FALLBACK', oldDecision: 'SEND_TO_AI', v2Decision: 'REJECT', blacklistHits: [hit] });

  const { byRule } = await shadowQueries.getRulePerformanceStats(pool, { period: 'all' });
  assert.equal(byRule.has('id:82'), false, 'a FALLBACK-only rule must not appear at all -- it reflects a gate failure, not real rule performance');
});

test('getRulePerformanceStats: DUPLICATE rows (always recorded with empty hit arrays) contribute zero rule hits', async () => {
  await row({ mode: 'SHADOW', oldDecision: 'DUPLICATE', v2Decision: 'DUPLICATE', v2Reason: 'DUPLICATE', blacklistHits: [], whitelistHits: [], propertySignalHits: [], sendToAiHits: [] });

  const { byRule } = await shadowQueries.getRulePerformanceStats(pool, { period: 'all' });
  assert.equal(byRule.size, 0, 'a DUPLICATE row has no hit-array contents, so it cannot and must not contribute any rule-level hit');
});

test('getRulePerformanceStats: hitToAiPct/hitToRejectPct are computed correctly and are zero-safe', async () => {
  const hit = { id: '90', rule_group: 'PROPERTY_SIGNAL', match_type: 'REGEX', pattern: '\\bsqft\\b' };
  await row({ mode: 'AUTHORITATIVE', oldDecision: null, v2Decision: 'SEND_TO_AI', propertySignalHits: [hit] });
  await row({ mode: 'AUTHORITATIVE', oldDecision: null, v2Decision: 'SEND_TO_AI', propertySignalHits: [hit] });
  await row({ mode: 'AUTHORITATIVE', oldDecision: null, v2Decision: 'REJECT', propertySignalHits: [hit] });

  const { byRule } = await shadowQueries.getRulePerformanceStats(pool, { period: 'all' });
  const stat = byRule.get('id:90');
  assert.equal(stat.hits, 3);
  assert.equal(stat.v2SendToAi, 2);
  assert.equal(stat.v2Reject, 1);
  assert.equal(stat.hitToAiPct, 2 / 3);
  assert.equal(stat.hitToRejectPct, 1 / 3);
});

test('getRulePerformanceStats: respects the period filter -- a row older than the window is excluded', async () => {
  const hit = { id: '91', rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'old-row' };
  const inserted = await row({ mode: 'AUTHORITATIVE', oldDecision: null, v2Decision: 'SEND_TO_AI', whitelistHits: [hit] });
  await pool.query(`UPDATE matching_dubai.shadow_gate_evaluations SET created_at = now() - interval '10 days' WHERE id = $1`, [inserted.id]);

  const recent = await shadowQueries.getRulePerformanceStats(pool, { period: '24h' });
  assert.equal(recent.byRule.has('id:91'), false, 'a 10-day-old row must not appear in a 24h window');

  const wide = await shadowQueries.getRulePerformanceStats(pool, { period: '30d' });
  assert.equal(wide.byRule.has('id:91'), true, 'the same row must appear in a wider 30d window');
});

test('getRulePerformanceStats: an unrecognized period value falls back to the default (24h), never throws', async () => {
  const { period } = await shadowQueries.getRulePerformanceStats(pool, { period: 'not-a-real-period' });
  assert.equal(period, '24h');
});

test('getRuleGroupPerformanceSummary: counts distinct rule ids and messages correctly, and one message hitting two rules in the same group counts as ONE message but TWO rule hits', async () => {
  const ruleA = { id: '100', rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'ищу' };
  const ruleB = { id: '101', rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'нужен' };
  // One message hits BOTH whitelist rules at once.
  await row({ mode: 'AUTHORITATIVE', oldDecision: null, v2Decision: 'SEND_TO_AI', whitelistHits: [ruleA, ruleB] });
  // A second, separate message hits only ruleA.
  await row({ mode: 'AUTHORITATIVE', oldDecision: null, v2Decision: 'REJECT', whitelistHits: [ruleA] });

  const { byGroup } = await shadowQueries.getRuleGroupPerformanceSummary(pool, { period: 'all' });
  const whitelistSummary = byGroup.get('WHITELIST');
  assert.equal(whitelistSummary.messagesWithHit, 2, 'two distinct evaluations had a whitelist hit');
  assert.equal(whitelistSummary.totalRuleHits, 3, 'rule hits overlap: 2 + 1 = 3 total rule hits across those 2 messages');
  assert.equal(whitelistSummary.distinctRuleIds, 2);
  assert.equal(whitelistSummary.messagesReachingAi, 1, 'only the first message actually reached AI (v2_decision=SEND_TO_AI)');
});

test('getRuleGroupPerformanceSummary: a group with zero evaluations in the period reports no entry (never a fake zero row)', async () => {
  const { byGroup } = await shadowQueries.getRuleGroupPerformanceSummary(pool, { period: 'all' });
  assert.equal(byGroup.has('SEND_TO_AI'), false);
});
