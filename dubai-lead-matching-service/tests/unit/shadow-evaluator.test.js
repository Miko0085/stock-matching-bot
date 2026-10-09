'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOldDecision, computeDisagreement, evaluateShadowGate, evaluateAuthoritativeGate, recordGateFallback } = require('../../src/services/shadow-evaluator');

test('normalizeOldDecision: event_duplicate -> DUPLICATE / duplicate_event', () => {
  assert.deepEqual(normalizeOldDecision({ event_duplicate: true }), { decision: 'DUPLICATE', reason: 'duplicate_event' });
});

test('normalizeOldDecision: content duplicate -> DUPLICATE / duplicate_content', () => {
  assert.deepEqual(normalizeOldDecision({ duplicate: true }), { decision: 'DUPLICATE', reason: 'duplicate_content' });
});

test('normalizeOldDecision: parser_error_reason wins over interpretation_source -> ERROR', () => {
  const result = normalizeOldDecision({ interpretation_source: 'ai', parser_error_reason: 'timeout' });
  assert.deepEqual(result, { decision: 'ERROR', reason: 'timeout' });
});

test('normalizeOldDecision: interpretation_source ai -> SEND_TO_AI (a fresh AI call actually happened)', () => {
  assert.deepEqual(normalizeOldDecision({ interpretation_source: 'ai' }), { decision: 'SEND_TO_AI', reason: 'ai' });
});

test('normalizeOldDecision: interpretation_source cache_ai -> CACHE_HIT_AI, NOT SEND_TO_AI (no incremental AI cost)', () => {
  assert.deepEqual(normalizeOldDecision({ interpretation_source: 'cache_ai' }), { decision: 'CACHE_HIT_AI', reason: 'cache_ai' });
});

test('normalizeOldDecision: interpretation_source local/cache_local -> PARSED_LOCALLY', () => {
  assert.deepEqual(normalizeOldDecision({ interpretation_source: 'local' }), { decision: 'PARSED_LOCALLY', reason: 'local' });
  assert.deepEqual(normalizeOldDecision({ interpretation_source: 'cache_local' }), { decision: 'PARSED_LOCALLY', reason: 'cache_local' });
});

test('normalizeOldDecision: triage_decision REJECT -> REJECT_WITHOUT_AI (kept distinct from PARSED_LOCALLY per spec section 10 dashboard breakdown), using no_match_reason for the exact reason', () => {
  const result = normalizeOldDecision({ triage_decision: 'REJECT', interpretation_source: 'local', no_match_reason: 'broker_solicitation' });
  assert.deepEqual(result, { decision: 'REJECT_WITHOUT_AI', reason: 'broker_solicitation' });
});

test('normalizeOldDecision: triage_decision PARSED_LOCALLY (not REJECT) still falls through to the interpretation_source check -> PARSED_LOCALLY', () => {
  const result = normalizeOldDecision({ triage_decision: 'PARSED_LOCALLY', interpretation_source: 'local' });
  assert.deepEqual(result, { decision: 'PARSED_LOCALLY', reason: 'local' });
});

test('normalizeOldDecision: nothing recognizable -> UNKNOWN', () => {
  assert.deepEqual(normalizeOldDecision({}), { decision: 'UNKNOWN', reason: 'unknown' });
});

test('computeDisagreement: old SEND_TO_AI -> V2 REJECT: projected_ai_saved true, projected_ai_added false', () => {
  const result = computeDisagreement('SEND_TO_AI', 'REJECT');
  assert.deepEqual(result, { disagreement: true, projectedAiSaved: true, projectedAiAdded: false });
});

test('computeDisagreement: old REJECT_WITHOUT_AI -> V2 SEND_TO_AI: projected_ai_added true, projected_ai_saved false', () => {
  const result = computeDisagreement('REJECT_WITHOUT_AI', 'SEND_TO_AI');
  assert.deepEqual(result, { disagreement: true, projectedAiSaved: false, projectedAiAdded: true });
});

test('computeDisagreement: old PARSED_LOCALLY -> V2 SEND_TO_AI: projected_ai_added true (this is genuinely new AI spend)', () => {
  const result = computeDisagreement('PARSED_LOCALLY', 'SEND_TO_AI');
  assert.deepEqual(result, { disagreement: true, projectedAiSaved: false, projectedAiAdded: true });
});

test('computeDisagreement: old CACHE_HIT_AI -> V2 SEND_TO_AI: disagreement true, but projected_ai_added FALSE (already paid for this content once)', () => {
  const result = computeDisagreement('CACHE_HIT_AI', 'SEND_TO_AI');
  assert.deepEqual(result, { disagreement: true, projectedAiSaved: false, projectedAiAdded: false });
});

test('computeDisagreement: same broad AI-or-not outcome -> disagreement false', () => {
  assert.equal(computeDisagreement('SEND_TO_AI', 'SEND_TO_AI').disagreement, false);
  assert.equal(computeDisagreement('REJECT', 'REJECT').disagreement, false);
  assert.equal(computeDisagreement('PARSED_LOCALLY', 'REJECT').disagreement, false);
});

test('evaluateShadowGate: old_decision DUPLICATE short-circuits -- never loads config, never calls the gate, persists a trivial DUPLICATE/DUPLICATE row', async () => {
  let insertCalls = 0;
  let insertArgs = null;
  const shadowRepo = require('../../src/repositories/shadow-repository');
  const original = shadowRepo.insertShadowEvaluation;
  shadowRepo.insertShadowEvaluation = async (pool, args) => {
    insertCalls += 1;
    insertArgs = args;
    return { id: 1, created_at: new Date() };
  };
  try {
    let configLoadCalls = 0;
    const deps = {
      pool: { query: async () => { throw new Error('must never query the pool directly for a DUPLICATE short-circuit'); } },
      getActiveV2Config: async () => { configLoadCalls += 1; return { settings: {}, rules: {}, configVersionId: 1 }; },
    };
    await evaluateShadowGate({
      unifiedMessage: { source_message_id: 'x:1', provider: 'telegram', original_text: 'irrelevant' },
      log: { event_duplicate: true },
      deps,
    });
    assert.equal(configLoadCalls, 0);
    assert.equal(insertCalls, 1);
    assert.equal(insertArgs.oldDecision, 'DUPLICATE');
    assert.equal(insertArgs.v2Decision, 'DUPLICATE');
    assert.equal(insertArgs.disagreement, false);
    assert.equal(insertArgs.configVersionId, null);
  } finally {
    shadowRepo.insertShadowEvaluation = original;
  }
});

test('evaluateShadowGate: a non-duplicate old decision loads active config and calls the real gate, attributing the active config version', async () => {
  const shadowRepo = require('../../src/repositories/shadow-repository');
  const original = shadowRepo.insertShadowEvaluation;
  let insertArgs = null;
  shadowRepo.insertShadowEvaluation = async (pool, args) => { insertArgs = args; return { id: 2, created_at: new Date() }; };
  try {
    const deps = {
      pool: {},
      getActiveV2Config: async () => ({
        settings: { whitelist_threshold: { value: 1, enabled: true }, property_signal_threshold: { value: 1, enabled: true } },
        rules: { BLACKLIST: [], WHITELIST: [], PROPERTY_SIGNAL: [], SEND_TO_AI: [] },
        configVersionId: 7,
      }),
    };
    await evaluateShadowGate({
      unifiedMessage: { source_message_id: 'x:2', provider: 'telegram', original_text: 'hello, nothing special here' },
      log: { interpretation_source: 'ai' },
      deps,
    });
    assert.equal(insertArgs.oldDecision, 'SEND_TO_AI');
    assert.equal(insertArgs.v2Decision, 'REJECT');
    assert.equal(insertArgs.configVersionId, 7);
    assert.equal(insertArgs.projectedAiSaved, true);
  } finally {
    shadowRepo.insertShadowEvaluation = original;
  }
});

// ---------------------------------------------------------------------
// Phase 4 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase 4): authoritative
// evaluation and fallback telemetry.
// ---------------------------------------------------------------------

function mockShadowRepo(impl) {
  const shadowRepo = require('../../src/repositories/shadow-repository');
  const original = shadowRepo.insertShadowEvaluation;
  shadowRepo.insertShadowEvaluation = impl;
  return () => { shadowRepo.insertShadowEvaluation = original; };
}

test('evaluateAuthoritativeGate: cutover OFF -> returns cutoverEnabled:false, never evaluates the gate, never persists telemetry', async () => {
  let insertCalls = 0;
  const restore = mockShadowRepo(async () => { insertCalls += 1; return { id: 1 }; });
  try {
    const deps = {
      pool: {},
      getActiveV2Config: async () => ({
        settings: { v2_intake_cutover_enabled: { value: false, enabled: true } },
        rules: { BLACKLIST: [], WHITELIST: [], PROPERTY_SIGNAL: [], SEND_TO_AI: [] },
        configVersionId: 1,
      }),
    };
    const result = await evaluateAuthoritativeGate({ unifiedMessage: { source_message_id: 'x:1', original_text: 'anything' }, deps });
    assert.deepEqual(result, { cutoverEnabled: false });
    assert.equal(insertCalls, 0);
  } finally {
    restore();
  }
});

test('evaluateAuthoritativeGate: cutover ON, deterministic REJECT -> returns decision=REJECT, persists mode=AUTHORITATIVE with old_decision null', async () => {
  let insertArgs = null;
  const restore = mockShadowRepo(async (pool, args) => { insertArgs = args; return { id: 2 }; });
  try {
    const deps = {
      pool: {},
      getActiveV2Config: async () => ({
        settings: {
          v2_intake_cutover_enabled: { value: true, enabled: true },
          whitelist_threshold: { value: 1, enabled: true },
          property_signal_threshold: { value: 1, enabled: true },
        },
        rules: { BLACKLIST: [], WHITELIST: [], PROPERTY_SIGNAL: [], SEND_TO_AI: [] },
        configVersionId: 5,
      }),
    };
    const result = await evaluateAuthoritativeGate({ unifiedMessage: { source_message_id: 'x:2', original_text: 'no signal here' }, deps });
    assert.equal(result.cutoverEnabled, true);
    assert.equal(result.decision, 'REJECT');
    assert.equal(result.configVersionId, 5);
    assert.equal(insertArgs.oldDecision, null);
    assert.equal(insertArgs.v2Decision, 'REJECT');
    assert.equal(insertArgs.mode, 'AUTHORITATIVE');
    assert.equal(insertArgs.configVersionId, 5);
  } finally {
    restore();
  }
});

test('evaluateAuthoritativeGate: cutover ON, SEND_TO_AI -> returns decision=SEND_TO_AI', async () => {
  const restore = mockShadowRepo(async () => ({ id: 3 }));
  try {
    const deps = {
      pool: {},
      getActiveV2Config: async () => ({
        settings: {
          v2_intake_cutover_enabled: { value: true, enabled: true },
          whitelist_threshold: { value: 1, enabled: true },
          property_signal_threshold: { value: 1, enabled: true },
          buyer_signal_policy: { value: 'REQUIRE_ANY', enabled: true },
        },
        rules: { BLACKLIST: [], WHITELIST: [{ id: 1, rule_group: 'WHITELIST', match_type: 'PHRASE', pattern: 'need', enabled: true, priority: 100 }], PROPERTY_SIGNAL: [], SEND_TO_AI: [] },
        configVersionId: 6,
      }),
    };
    const result = await evaluateAuthoritativeGate({ unifiedMessage: { source_message_id: 'x:3', original_text: 'i need a place' }, deps });
    assert.equal(result.cutoverEnabled, true);
    assert.equal(result.decision, 'SEND_TO_AI');
  } finally {
    restore();
  }
});

test('evaluateAuthoritativeGate: an unrecognized buyer_signal_policy throws (propagates to the caller for fallback)', async () => {
  const restore = mockShadowRepo(async () => ({ id: 4 }));
  try {
    const deps = {
      pool: {},
      getActiveV2Config: async () => ({
        settings: { v2_intake_cutover_enabled: { value: true, enabled: true }, buyer_signal_policy: { value: 'NOT_A_REAL_POLICY', enabled: true } },
        rules: { BLACKLIST: [], WHITELIST: [], PROPERTY_SIGNAL: [], SEND_TO_AI: [] },
        configVersionId: 1,
      }),
    };
    await assert.rejects(
      evaluateAuthoritativeGate({ unifiedMessage: { source_message_id: 'x:4', original_text: 'text' }, deps }),
      /unrecognized buyer_signal_policy/
    );
  } finally {
    restore();
  }
});

test('evaluateAuthoritativeGate: a config-load failure propagates (caller falls back to legacy)', async () => {
  const deps = { pool: {}, getActiveV2Config: async () => { throw new Error('DB is down'); } };
  await assert.rejects(
    evaluateAuthoritativeGate({ unifiedMessage: { source_message_id: 'x:5', original_text: 'text' }, deps }),
    /DB is down/
  );
});

test('evaluateAuthoritativeGate: a telemetry INSERT failure does NOT invalidate the already-correct decision (spec: "telemetry persistence error does not lose message")', async () => {
  const restore = mockShadowRepo(async () => { throw new Error('insert failed'); });
  try {
    const loggedEvents = [];
    const deps = {
      pool: {},
      getActiveV2Config: async () => ({
        settings: { v2_intake_cutover_enabled: { value: true, enabled: true }, whitelist_threshold: { value: 1, enabled: true }, property_signal_threshold: { value: 1, enabled: true } },
        rules: { BLACKLIST: [], WHITELIST: [], PROPERTY_SIGNAL: [], SEND_TO_AI: [] },
        configVersionId: 1,
      }),
      logEvent: (fields) => loggedEvents.push(fields),
    };
    const result = await evaluateAuthoritativeGate({ unifiedMessage: { source_message_id: 'x:6', original_text: 'no signal' }, deps });
    assert.equal(result.cutoverEnabled, true);
    assert.equal(result.decision, 'REJECT', 'the decision is still returned correctly despite the telemetry insert failing');
    assert.ok(loggedEvents.some((e) => e.event === 'shadow_telemetry_insert_failed'));
  } finally {
    restore();
  }
});

test('recordGateFallback: persists a mode=FALLBACK row with v2_reason=V2_GATE_ERROR_FALLBACK, never throws even if the insert itself fails', async () => {
  let insertArgs = null;
  const restore = mockShadowRepo(async (pool, args) => { insertArgs = args; return { id: 7 }; });
  try {
    await recordGateFallback({ unifiedMessage: { source_message_id: 'x:7', original_text: 'text' }, deps: { pool: {} }, error: new Error('boom') });
    assert.equal(insertArgs.mode, 'FALLBACK');
    assert.equal(insertArgs.v2Reason, 'V2_GATE_ERROR_FALLBACK');
    assert.equal(insertArgs.oldDecision, null);
  } finally {
    restore();
  }

  const restore2 = mockShadowRepo(async () => { throw new Error('insert also fails'); });
  try {
    const loggedEvents = [];
    await assert.doesNotReject(
      recordGateFallback({ unifiedMessage: { source_message_id: 'x:8', original_text: 'text' }, deps: { pool: {}, logEvent: (f) => loggedEvents.push(f) }, error: new Error('boom') })
    );
    assert.ok(loggedEvents.some((e) => e.event === 'shadow_telemetry_insert_failed'));
  } finally {
    restore2();
  }
});
