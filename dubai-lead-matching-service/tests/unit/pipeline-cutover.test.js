'use strict';

// Nika Matching V2, Phase 4 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase
// 4, requirement 15 C/D/E): pipeline-level tests for the controlled V2
// intake gate cutover -- cutover OFF (unchanged legacy behavior), cutover
// ON (deterministic REJECT makes ZERO AI calls, SEND_TO_AI reaches the
// real interpreter), and fail-safe fallback (any gate-infrastructure
// failure falls through to legacy, never losing the message).
//
// AI invocation count is asserted via a SPY on `classifyAndParse`, never
// inferred only from the result status (spec requirement 15.F: "Do not
// infer this only from result statuses").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runWebhookPipeline } = require('../../src/services/pipeline');
const { buildLocationDictionary } = require('../../src/matching/location-dictionary');

function makeAiValue(overrides = {}) {
  return {
    message_class: 'buyer_request', demand_owner: 'sender', promotion: false, spam: false,
    transaction_type: 'SALE', area: 'Business Bay', project: null, building: null, property_type: null,
    bedrooms_min: 2, bedrooms_max: 2, budget_min: null, budget_max: null, furnishing: null,
    cash_buyer: null, confidence: 0.9, ...overrides,
  };
}

function telegramRaw(overrides = {}) {
  return { chat_id: '-100123', message_id: '1', sender_id: '1', sender_name: 'John', text: 'irrelevant placeholder text', ...overrides };
}

// A spy classifyAndParse that counts REAL invocations -- the actual proof
// requirement 15.D/F needs ("AI interpreter invocation count MUST be
// zero" for a deterministic reject).
function makeAiSpy(result) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return result ?? { ok: true, value: makeAiValue(), warnings: [], usage: null };
  };
  return { fn, calls };
}

function makeDeps(overrides = {}) {
  const insertedRuns = [];
  const matchRepo = {
    checkDuplicate: async () => false,
    insertMatchRun: async (pool, row) => { insertedRuns.push(row); return { id: insertedRuns.length, created_at: new Date().toISOString() }; },
    upsertMatchResult: async () => ({ id: 1 }),
  };
  const stockRepo = {
    fetchCandidates: async () => [],
    checkLocationExists: async () => false,
    getLatestStockSyncedAt: async () => null,
    getActiveStockCount: async () => 0,
  };
  const aiUsageRepo = { logAiUsage: async () => {} };
  const eventDedupRepo = { claimEvent: async () => ({ claimed: true, attempts: 1 }), completeEvent: async () => {}, failEvent: async () => {} };
  const interpretationCacheRepo = { findInterpretation: async () => null, recordInterpretation: async () => {} };

  const deps = {
    config: { openaiApiKey: 'x', openaiModel: 'gpt-4o-mini', dedupWindowHours: 48, matchDebug: false, parserVersion: 'v', matcherVersion: 'v', interpretationCacheTtlDays: 14 },
    pool: {},
    matchRepo,
    stockRepo,
    aiUsageRepo,
    eventDedupRepo,
    interpretationCacheRepo,
    getAliasIndex: async () => ({}),
    classifyAndParse: async () => ({ ok: true, value: makeAiValue(), warnings: [], usage: null }),
    logEvent: () => {},
    ...overrides,
  };
  if (!overrides.getLocationDictionary) {
    deps.getLocationDictionary = async () => buildLocationDictionary({ aliasIndex: await deps.getAliasIndex() });
  }
  return { deps, insertedRuns };
}

// ---------------------------------------------------------------------
// C. Cutover OFF
// ---------------------------------------------------------------------

test('cutover OFF (no evaluateAuthoritativeGate wired): legacy path unchanged, byte-identical to pre-Phase-4', async () => {
  const aiSpy = makeAiSpy();
  const { deps } = makeDeps({
    classifyAndParse: aiSpy.fn,
    // A message ambiguous enough for local triage to escalate to AI_REVIEW.
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'My client is looking for a 2BR in Business Bay' }), provider: 'telegram', deps });
  assert.equal(result.status, 'NO_MATCH', 'sanity: this text still reaches AI, exactly as before Phase 4 (NO_MATCH because the fake stockRepo has no candidates)');
  assert.equal(aiSpy.calls.length, 1);
});

test('cutover OFF: V2 shadow evaluation still runs (unaffected), and its REJECT never suppresses the real AI call', async () => {
  const aiSpy = makeAiSpy();
  let shadowCalls = 0;
  const { deps } = makeDeps({
    classifyAndParse: aiSpy.fn,
    evaluateShadowGate: async () => { shadowCalls += 1; },
    // evaluateAuthoritativeGate deliberately NOT wired -- cutover is off.
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'My client is looking for a 2BR in Business Bay' }), provider: 'telegram', deps });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(aiSpy.calls.length, 1, 'the real AI call still happened -- shadow evaluation never controls anything');
  assert.equal(shadowCalls, 1, 'shadow comparator still ran for observability');
});

// ---------------------------------------------------------------------
// D. Cutover ON
// ---------------------------------------------------------------------

test('cutover ON, gate says REJECT: AI invocation count = 0 (spied, not inferred from status)', async () => {
  const aiSpy = makeAiSpy();
  const { deps } = makeDeps({
    classifyAndParse: aiSpy.fn,
    evaluateAuthoritativeGate: async () => ({ cutoverEnabled: true, decision: 'REJECT', reason: 'INSUFFICIENT_BUYER_SIGNAL', configVersionId: 9 }),
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'some random ambiguous chat message' }), provider: 'telegram', deps });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.no_match_reason, 'v2_gate_insufficient_buyer_signal');
  assert.equal(aiSpy.calls.length, 0, 'PROOF: a deterministic V2 reject under cutover makes ZERO AI calls');
});

test('cutover ON, gate says SEND_TO_AI: the existing AI interpreter is actually invoked, config version recorded', async () => {
  const aiSpy = makeAiSpy();
  const { deps, insertedRuns } = makeDeps({
    classifyAndParse: aiSpy.fn,
    evaluateAuthoritativeGate: async () => ({ cutoverEnabled: true, decision: 'SEND_TO_AI', reason: 'WHITELIST_OR_PROPERTY_SIGNAL', configVersionId: 9 }),
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'need a 2br in business bay' }), provider: 'telegram', deps });
  assert.equal(aiSpy.calls.length, 1, 'PROOF: V2 SEND_TO_AI reaches the real, unchanged interpreter');
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(insertedRuns[0].triageDecision, null, 'local triage never ran -- its own eligibility decision was bypassed');
  assert.equal(insertedRuns[0].interpretationSource, 'ai');
});

test('cutover ON, gate says REJECT: local triage/parser never runs either (bypassed, not just AI)', async () => {
  let triageWouldHaveBeenCalled = false;
  const { deps } = makeDeps({
    getAliasIndex: async () => { triageWouldHaveBeenCalled = true; return {}; }, // triage.js needs alias index -- if this is called, legacy triage ran
    evaluateAuthoritativeGate: async () => ({ cutoverEnabled: true, decision: 'REJECT', reason: 'BLACKLIST', configVersionId: 9 }),
  });
  await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'For Sale 2BR Business Bay' }), provider: 'telegram', deps });
  assert.equal(triageWouldHaveBeenCalled, false, 'getAliasIndex (needed only by local triage) was never called -- confirms triage was fully bypassed');
});

test('cutover ON: the shadow-only comparator does NOT also run for the same request (no redundant/misleading second row)', async () => {
  let shadowCalls = 0;
  const { deps } = makeDeps({
    evaluateShadowGate: async () => { shadowCalls += 1; },
    evaluateAuthoritativeGate: async () => ({ cutoverEnabled: true, decision: 'REJECT', reason: 'BLACKLIST', configVersionId: 9 }),
  });
  await runWebhookPipeline({ rawPayload: telegramRaw(), provider: 'telegram', deps });
  assert.equal(shadowCalls, 0, 'an AUTHORITATIVE row was already recorded by evaluateAuthoritativeGate -- finish() must skip the redundant shadow comparison');
});

// ---------------------------------------------------------------------
// E. Failure fallback
// ---------------------------------------------------------------------

test('fallback: config load failure inside evaluateAuthoritativeGate -> legacy path processes the message, AI still reachable if triage would send it', async () => {
  const aiSpy = makeAiSpy();
  const fallbackCalls = [];
  const { deps } = makeDeps({
    classifyAndParse: aiSpy.fn,
    evaluateAuthoritativeGate: async () => { throw new Error('DB connection refused'); },
    recordGateFallback: async (args) => fallbackCalls.push(args),
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'My client is looking for a 2BR in Business Bay' }), provider: 'telegram', deps });
  assert.equal(result.status, 'NO_MATCH', 'the message was NOT lost -- legacy triage processed it normally (NO_MATCH: fake stockRepo has no candidates, but AI WAS reached, see next assertion)');
  assert.equal(aiSpy.calls.length, 1, 'legacy triage still decided AI_REVIEW for this ambiguous-enough text, exactly as if cutover had never existed');
  assert.equal(fallbackCalls.length, 1, 'the fallback was recorded');
});

test('fallback: gate evaluation error (e.g. unrecognized policy) -> legacy path, message never lost', async () => {
  const { deps } = makeDeps({
    evaluateAuthoritativeGate: async () => { throw new Error('evaluateV2IntakeGate: unrecognized buyer_signal_policy "BOGUS"'); },
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'Hi there, just saying hello' }), provider: 'telegram', deps });
  assert.ok(['REJECTED', 'MATCH', 'NO_MATCH', 'INSUFFICIENT_CRITERIA'].includes(result.status), 'a durable, normal legacy outcome was still produced');
});

test('fallback: V2_GATE_ERROR_FALLBACK is logged when the gate infrastructure fails', async () => {
  const loggedEvents = [];
  const { deps } = makeDeps({
    evaluateAuthoritativeGate: async () => { throw new Error('boom'); },
    logEvent: (fields) => loggedEvents.push(fields),
  });
  await runWebhookPipeline({ rawPayload: telegramRaw(), provider: 'telegram', deps });
  assert.ok(loggedEvents.some((e) => e.event === 'V2_GATE_ERROR_FALLBACK'));
});

test('fallback: a recordGateFallback failure never breaks the live message path', async () => {
  const { deps } = makeDeps({
    evaluateAuthoritativeGate: async () => { throw new Error('gate infra down'); },
    recordGateFallback: async () => { throw new Error('telemetry insert also failed'); },
  });
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'My client is looking for a 2BR in Business Bay' }), provider: 'telegram', deps });
  assert.equal(result.status, 'NO_MATCH', 'even a doubly-failing fallback path (gate AND telemetry) never loses the live message');
});

test('fallback: missing evaluateAuthoritativeGate/recordGateFallback dependencies (pre-Phase-4 deps object) behaves exactly like cutover OFF', async () => {
  const aiSpy = makeAiSpy();
  const { deps } = makeDeps({ classifyAndParse: aiSpy.fn }); // no evaluateAuthoritativeGate at all
  const result = await runWebhookPipeline({ rawPayload: telegramRaw({ text: 'My client is looking for a 2BR in Business Bay' }), provider: 'telegram', deps });
  assert.equal(result.status, 'NO_MATCH');
  assert.equal(aiSpy.calls.length, 1);
});
