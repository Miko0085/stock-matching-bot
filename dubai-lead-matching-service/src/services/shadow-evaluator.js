'use strict';

// Nika Matching V2, Phase 3 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase
// 3). The ONLY orchestration layer that connects the pure V2 gate
// (gates/v2-intake-gate.js) to a real, already-processed message.
//
// ABSOLUTE SHADOW SAFETY (spec section 7): this module may ONLY
//   - read config (via deps.getActiveV2Config, cached)
//   - compute the V2 gate decision (a pure function call, no side effects)
//   - persist shadow telemetry (one INSERT)
//   - emit logs
// It must NEVER be awaited in a way that can change the real pipeline's
// return value, and a failure here must NEVER propagate into the live
// request. Both guarantees are enforced by the SINGLE call site
// (services/pipeline.js's `finish()`), which wraps every call to
// evaluateShadowGate() in its own try/catch and always returns the real
// `result` regardless of what happens here (see pipeline.js's comment at
// that call site for the exact wording proving this).
const { evaluateV2IntakeGate } = require('../gates/v2-intake-gate');
const { computeTextOnlyHash } = require('../../../src/core/content-dedup');
const shadowRepo = require('../repositories/shadow-repository');

// Maps the REAL pipeline's already-computed outcome (captured in the `log`
// object services/pipeline.js's runWebhookPipeline() builds for every
// request) onto the small, comparable vocabulary spec section 5 asks for
// (SEND_TO_AI, REJECT_WITHOUT_AI, PARSED_LOCALLY, DUPLICATE, ERROR --
// extended below with CACHE_HIT_AI and UNKNOWN). This NEVER changes what
// actually happened -- it only classifies it after the fact, for shadow
// comparison.
//
// Exact mapping (documented in docs/MATCHING_V2_PHASE3_SHADOW_GATE.md):
//   event_duplicate / duplicate (content)  -> DUPLICATE
//   parser_error_reason present            -> ERROR      (AI was attempted and failed)
//   triage_decision === 'REJECT'           -> REJECT_WITHOUT_AI (a deterministic, local,
//                                              never-even-fully-parsed reject -- e.g.
//                                              broker_solicitation, *_inventory_ad. Kept
//                                              DISTINCT from PARSED_LOCALLY per spec section
//                                              10's dashboard breakdown, even though both are
//                                              equally non-AI for the cost-comparison math in
//                                              computeDisagreement())
//   interpretation_source === 'ai'         -> SEND_TO_AI (a FRESH AI call actually happened)
//   interpretation_source === 'cache_ai'   -> CACHE_HIT_AI (reused a prior AI result -- ZERO
//                                              incremental AI cost this time, so this is
//                                              deliberately NOT the same bucket as SEND_TO_AI
//                                              for cost-comparison purposes)
//   interpretation_source === 'local'/'cache_local' -> PARSED_LOCALLY (a real local parse was
//                                              built -- triage.js's PARSED_LOCALLY branch, or a
//                                              cache hit of one; no AI call, ever)
//   anything else (should not happen)      -> UNKNOWN
function normalizeOldDecision(log) {
  if (log.event_duplicate || log.duplicate) {
    return { decision: 'DUPLICATE', reason: log.event_duplicate ? 'duplicate_event' : 'duplicate_content' };
  }
  if (log.parser_error_reason) {
    return { decision: 'ERROR', reason: log.parser_error_reason };
  }
  if (log.triage_decision === 'REJECT') {
    return { decision: 'REJECT_WITHOUT_AI', reason: log.no_match_reason || 'triage_reject' };
  }
  const source = log.interpretation_source;
  if (source === 'ai') return { decision: 'SEND_TO_AI', reason: 'ai' };
  if (source === 'cache_ai') return { decision: 'CACHE_HIT_AI', reason: 'cache_ai' };
  if (source === 'local' || source === 'cache_local') return { decision: 'PARSED_LOCALLY', reason: source };
  return { decision: 'UNKNOWN', reason: log.result_status || 'unknown' };
}

// Spec section 6's three cases, made precise:
//   A. old SEND_TO_AI -> V2 REJECT                                     => projected_ai_saved = true
//   B. old (REJECT_WITHOUT_AI/PARSED_LOCALLY/ERROR/UNKNOWN) -> V2 SEND_TO_AI => projected_ai_added = true
//      (explicitly NOT old CACHE_HIT_AI -> V2 SEND_TO_AI -- see below)
//   C. same broad AI-or-not outcome               => disagreement = false
//
// CACHE_HIT_AI is deliberately excluded from "added": the underlying
// content already paid for an AI call once (that is what made it
// cacheable); V2 sending the SAME content to AI again is not a NEW
// incremental cost pattern the way a genuinely-new REJECT/PARSED_LOCALLY
// -> SEND_TO_AI case is. It is still counted as a `disagreement` (the
// broad AI-or-not outcome differs), just not double-counted as "added".
function computeDisagreement(oldDecision, v2Decision) {
  const oldWasAi = oldDecision === 'SEND_TO_AI';
  const v2WasAi = v2Decision === 'SEND_TO_AI';
  const projectedAiSaved = oldWasAi && !v2WasAi;
  const projectedAiAdded = !oldWasAi && oldDecision !== 'CACHE_HIT_AI' && v2WasAi;
  const disagreement = oldWasAi !== v2WasAi;
  return { disagreement, projectedAiSaved, projectedAiAdded };
}

function baseFields(unifiedMessage) {
  return {
    sourceMessageId: unifiedMessage.source_message_id,
    provider: unifiedMessage.provider,
    accountId: unifiedMessage.account_id,
    chatId: unifiedMessage.chat_id,
    senderId: unifiedMessage.sender_id,
    messageTextHash: computeTextOnlyHash(unifiedMessage.original_text),
  };
}

// `deps` must provide `getActiveV2Config()` (cached loader,
// config-repository.js's loadActiveV2Config) and `pool`. Throws on a real
// failure -- failure isolation is the CALLER's responsibility (pipeline.js
// wraps every call in try/catch), so this function stays simple and
// honest about errors rather than silently swallowing them itself.
async function evaluateShadowGate({ unifiedMessage, log, deps }) {
  const old = normalizeOldDecision(log);

  // Spec section 14: "If a message is already rejected as an event
  // duplicate by current runtime, do not force duplicate shadow
  // evaluation unnecessarily." The FUTURE V2 gate's own target logic
  // (spec section 2) defers to the SAME dedup layer before ever reaching
  // rule matching, so it would reach the identical DUPLICATE outcome --
  // recording that directly, without loading config or running any rule
  // match, is both correct and cheaper.
  if (old.decision === 'DUPLICATE') {
    return shadowRepo.insertShadowEvaluation(deps.pool, {
      ...baseFields(unifiedMessage),
      oldDecision: 'DUPLICATE',
      oldReason: old.reason,
      v2Decision: 'DUPLICATE',
      v2Reason: 'DUPLICATE',
      blacklistHits: [],
      whitelistHits: [],
      propertySignalHits: [],
      sendToAiHits: [],
      whitelistThreshold: null,
      propertySignalThreshold: null,
      configVersionId: null,
      disagreement: false,
      projectedAiSaved: false,
      projectedAiAdded: false,
    });
  }

  const { settings, rules, configVersionId } = await deps.getActiveV2Config();
  const gateResult = evaluateV2IntakeGate({
    message: { text: unifiedMessage.original_text },
    sourceContext: {}, // no live source enable/disable signal exists yet -- see gate's own comment
    runtimeSettings: settings,
    intakeRules: rules,
  });

  const { disagreement, projectedAiSaved, projectedAiAdded } = computeDisagreement(old.decision, gateResult.decision);

  return shadowRepo.insertShadowEvaluation(deps.pool, {
    ...baseFields(unifiedMessage),
    oldDecision: old.decision,
    oldReason: old.reason,
    v2Decision: gateResult.decision,
    v2Reason: gateResult.reason,
    blacklistHits: gateResult.blacklist_hits,
    whitelistHits: gateResult.whitelist_hits,
    propertySignalHits: gateResult.property_signal_hits,
    sendToAiHits: gateResult.send_to_ai_hits,
    whitelistThreshold: gateResult.thresholds.whitelist,
    propertySignalThreshold: gateResult.thresholds.property_signal,
    configVersionId,
    disagreement,
    projectedAiSaved,
    projectedAiAdded,
  });
}

// ---------------------------------------------------------------------
// Phase 4 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase 4). Authoritative
// (or fallback) evaluation -- used ONLY from pipeline.js's cache-miss
// branch, and ONLY as a REPLACEMENT for the legacy triage decision when
// v2_intake_cutover_enabled is true. Unlike evaluateShadowGate() above,
// this function's return value DOES drive the real, live decision --
// pipeline.js is the caller responsible for actually rejecting the
// message or routing it to AI based on what this returns.
//
// Deliberately separate from evaluateShadowGate() rather than a shared
// code path: the two have fundamentally different safety contracts (this
// one's result controls the message; that one's result must never be
// allowed to), and keeping them as two distinct, small functions makes
// that boundary a matter of "which function got called," not a runtime
// branch buried inside one function that shadow-mode tests would also
// have to reason about.
async function evaluateAuthoritativeGate({ unifiedMessage, deps }) {
  const { settings, rules, configVersionId } = await deps.getActiveV2Config();
  const cutoverEnabled = settings.v2_intake_cutover_enabled?.value === true;
  if (!cutoverEnabled) {
    return { cutoverEnabled: false };
  }

  // May throw (e.g. an unrecognized buyer_signal_policy value) -- this is
  // intentional (spec section 4: "runtime must fail safely"); the caller
  // (pipeline.js) catches ANY failure from this whole function and falls
  // back to the legacy path, so a thrown error here IS "failing safely,"
  // not a bug to swallow internally.
  const gateResult = evaluateV2IntakeGate({
    message: { text: unifiedMessage.original_text },
    sourceContext: {}, // SOURCE_DISABLED deliberately not wired -- see gate's own comment and docs/MATCHING_V2_PHASE4_GATE_CUTOVER.md section 12.
    runtimeSettings: settings,
    intakeRules: rules,
  });

  // Telemetry persistence failing must NEVER invalidate an already-correct
  // gate decision (spec section 8: "Do not let telemetry insert failure
  // break the live message path") -- caught and logged here, never
  // rethrown, so the caller always gets a valid decision back even if this
  // INSERT fails.
  try {
    await shadowRepo.insertShadowEvaluation(deps.pool, {
      ...baseFields(unifiedMessage),
      oldDecision: null,
      oldReason: null,
      v2Decision: gateResult.decision,
      v2Reason: gateResult.reason,
      blacklistHits: gateResult.blacklist_hits,
      whitelistHits: gateResult.whitelist_hits,
      propertySignalHits: gateResult.property_signal_hits,
      sendToAiHits: gateResult.send_to_ai_hits,
      whitelistThreshold: gateResult.thresholds.whitelist,
      propertySignalThreshold: gateResult.thresholds.property_signal,
      configVersionId,
      disagreement: false,
      projectedAiSaved: false,
      projectedAiAdded: false,
      mode: 'AUTHORITATIVE',
    });
  } catch (err) {
    deps.logEvent?.({ level: 'error', event: 'shadow_telemetry_insert_failed', request_id: unifiedMessage.source_message_id, error: err.message });
  }

  return { cutoverEnabled: true, decision: gateResult.decision, reason: gateResult.reason, configVersionId };
}

// Best-effort telemetry for the "gate infrastructure itself failed" case
// (spec section 8: config load error, gate evaluation error, unexpected
// policy value, or any other dependency failure). Called from
// pipeline.js's catch block AFTER it has already decided to fall back to
// the legacy path -- this function only ever records that the fallback
// happened; it never influences the decision itself (the fallback
// decision was already made by the time this runs). `configVersionId` is
// unknown in this failure case (the load that would have told us is
// exactly what failed), hence null.
async function recordGateFallback({ unifiedMessage, deps, error }) {
  try {
    await shadowRepo.insertShadowEvaluation(deps.pool, {
      ...baseFields(unifiedMessage),
      oldDecision: null,
      oldReason: null,
      v2Decision: 'ERROR',
      v2Reason: 'V2_GATE_ERROR_FALLBACK',
      blacklistHits: [],
      whitelistHits: [],
      propertySignalHits: [],
      sendToAiHits: [],
      whitelistThreshold: null,
      propertySignalThreshold: null,
      configVersionId: null,
      disagreement: false,
      projectedAiSaved: false,
      projectedAiAdded: false,
      mode: 'FALLBACK',
    });
  } catch (insertErr) {
    deps.logEvent?.({ level: 'error', event: 'shadow_telemetry_insert_failed', request_id: unifiedMessage.source_message_id, error: insertErr.message, original_gate_error: error?.message });
  }
}

module.exports = { evaluateShadowGate, normalizeOldDecision, computeDisagreement, evaluateAuthoritativeGate, recordGateFallback };
