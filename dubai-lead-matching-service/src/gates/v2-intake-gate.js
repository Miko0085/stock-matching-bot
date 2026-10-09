'use strict';

// Nika Matching V2, Phase 3 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase
// 3, requirement 1). The pure, deterministic core of the FUTURE V2 intake
// gate. SHADOW MODE ONLY -- nothing calls this from the live decision path
// yet (see src/services/shadow-evaluator.js for the read-only orchestrator
// that does call it, and services/pipeline.js's `finish()` for the single,
// non-blocking, try/caught integration point).
//
// Deliberately side-effect-free: no DB, no AI, no network, no filesystem.
// Everything it needs (message text, source context, active settings,
// active rules) is handed to it as plain data -- this is what makes it
// directly unit-testable and safe to reuse later for a real (non-shadow)
// cutover in Phase 4 without any behavior change at that point.

const REASONS = Object.freeze({
  SOURCE_DISABLED: 'SOURCE_DISABLED',
  BLACKLIST: 'BLACKLIST',
  SEND_TO_AI_RULE: 'SEND_TO_AI_RULE',
  WHITELIST_AND_PROPERTY_SIGNAL: 'WHITELIST_AND_PROPERTY_SIGNAL',
  // Phase 4 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase 4, requirement
  // 4): the REQUIRE_ANY counterpart to WHITELIST_AND_PROPERTY_SIGNAL above.
  // Kept as a DISTINCT reason string (not a reused/renamed one) so
  // dashboard/shadow-queries.js's existing hardcoded
  // v2_reason = 'WHITELIST_AND_PROPERTY_SIGNAL' filters keep meaning
  // exactly what they already mean, and a REQUIRE_ANY match is never
  // silently miscounted as a REQUIRE_BOTH one in historical telemetry.
  WHITELIST_OR_PROPERTY_SIGNAL: 'WHITELIST_OR_PROPERTY_SIGNAL',
  INSUFFICIENT_BUYER_SIGNAL: 'INSUFFICIENT_BUYER_SIGNAL',
});

// Phase 4: the two buyer-signal combination policies a config version may
// select (spec section 4). REQUIRE_BOTH is the original Phase 1-3
// behavior (AND); REQUIRE_ANY is the Phase 3.5-calibrated emergency
// permissive mode (OR) -- see docs/MATCHING_V2_PHASE35_GATE_CALIBRATION.md
// for why OR is temporary, not a permanent hardcoded default.
const BUYER_SIGNAL_POLICIES = Object.freeze({
  REQUIRE_BOTH: 'REQUIRE_BOTH',
  REQUIRE_ANY: 'REQUIRE_ANY',
});

function normalizeText(text) {
  return String(text || '').toLowerCase();
}

// REGEX syntax is already validated at write time (Phase 2's
// config-validation.js) -- this still fails SAFE (never matches, never
// throws) against any bad pattern that somehow reaches here anyway (spec
// section 2: "nevertheless fail safely if bad DB data somehow exists").
function ruleMatches(rule, normalizedText, originalText) {
  if (rule.match_type === 'PHRASE') {
    // Case-insensitive literal substring match -- deterministic, no
    // fuzzy matching, no stemming, no embeddings, no AI (spec section 2).
    return normalizedText.includes(String(rule.pattern).toLowerCase());
  }
  if (rule.match_type === 'REGEX') {
    try {
      const re = new RegExp(rule.pattern, 'iu');
      return re.test(originalText);
    } catch {
      return false;
    }
  }
  return false;
}

// Returns the subset of `rules` that hit `text` -- disabled rules never
// participate (defense-in-depth: the config repository's
// getEnabledIntakeRules() already filters these out, but a caller passing
// an unfiltered list must still get correct behavior).
function findHits(rules, text) {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  const normalized = normalizeText(text);
  return rules.filter((rule) => rule.enabled !== false && ruleMatches(rule, normalized, text));
}

// evaluateV2IntakeGate() implements exactly the rule-matching CORE of the
// "TARGET FUTURE GATE LOGIC" (spec section 2 of the Phase 3 instructions):
//
//   if source disabled          -> REJECT / SOURCE_DISABLED
//   else if blacklist hit       -> REJECT / BLACKLIST
//   else if SEND_TO_AI hit      -> SEND_TO_AI / SEND_TO_AI_RULE
//   else if whitelist >= threshold AND property_signal >= threshold
//                                -> SEND_TO_AI / WHITELIST_AND_PROPERTY_SIGNAL
//   else                         -> REJECT / INSUFFICIENT_BUYER_SIGNAL
//
// "event duplicate -> DUPLICATE" from that same target logic is
// DELIBERATELY NOT part of this pure function -- event/content dedup
// requires a database lookup (matching_dubai.processed_events /
// checkDuplicate()), which this module is explicitly forbidden from doing
// (spec section 1: "Do not query PostgreSQL inside this pure evaluation
// function"). The orchestrator (shadow-evaluator.js) already knows the
// REAL pipeline's dedup outcome for free (it observes the same request the
// live pipeline just processed) and short-circuits to DUPLICATE without
// ever calling this function at all -- see shadow-evaluator.js's own
// comment for the exact reasoning (spec section 14: "do not force
// duplicate shadow evaluation unnecessarily").
//
// `runtimeSettings` -- the shape getActiveRuntimeSettings() returns:
//   { [key]: { value, enabled } }
// `intakeRules` -- the shape getEnabledIntakeRules() returns:
//   { BLACKLIST: [...], WHITELIST: [...], PROPERTY_SIGNAL: [...], SEND_TO_AI: [...] }
function evaluateV2IntakeGate({ message, sourceContext = {}, runtimeSettings = {}, intakeRules = {} }) {
  const text = message && message.text ? message.text : '';

  const whitelistThreshold = runtimeSettings.whitelist_threshold?.value ?? 1;
  const propertySignalThreshold = runtimeSettings.property_signal_threshold?.value ?? 1;
  const thresholds = { whitelist: whitelistThreshold, property_signal: propertySignalThreshold };

  // Phase 4: config-driven combination policy, defaulting to the original
  // REQUIRE_BOTH (AND) semantics if the setting is absent (e.g. a config
  // version created before migration 0023 seeded it). An UNRECOGNIZED
  // value is a hard failure, not a silent fallback -- "unknown policy:
  // validation should prevent it [at write time]; runtime must fail
  // safely [here, at read time]" (spec section 4). Failing safely means
  // THROWING, not guessing OR vs AND: the caller (services/pipeline.js,
  // when cutover is ON) wraps every gate evaluation in a try/catch that
  // falls back to the legacy decision path on any error, so throwing here
  // is what "fail safely" actually cashes out to -- never silently
  // widening or narrowing buyer eligibility from bad config data.
  const buyerSignalPolicy = runtimeSettings.buyer_signal_policy?.value || BUYER_SIGNAL_POLICIES.REQUIRE_BOTH;
  if (!Object.prototype.hasOwnProperty.call(BUYER_SIGNAL_POLICIES, buyerSignalPolicy)) {
    throw new Error(`evaluateV2IntakeGate: unrecognized buyer_signal_policy "${buyerSignalPolicy}"`);
  }

  const empty = { blacklist_hits: [], whitelist_hits: [], property_signal_hits: [], send_to_ai_hits: [] };

  // Not wired to any real per-source enabled/disabled signal today -- the
  // current UAE intake path has no source-routing check in its live
  // decision flow yet (documented limitation, Phase 3 doc section 13).
  // `sourceContext.disabled` exists so this function's shape already
  // matches the target future logic; it is simply never set true by
  // today's orchestrator.
  if (sourceContext.disabled) {
    return { decision: 'REJECT', reason: REASONS.SOURCE_DISABLED, ...empty, thresholds };
  }

  const blacklistHits = findHits(intakeRules.BLACKLIST, text);
  if (blacklistHits.length > 0) {
    return { decision: 'REJECT', reason: REASONS.BLACKLIST, ...empty, blacklist_hits: blacklistHits, thresholds };
  }

  const sendToAiHits = findHits(intakeRules.SEND_TO_AI, text);
  if (sendToAiHits.length > 0) {
    return { decision: 'SEND_TO_AI', reason: REASONS.SEND_TO_AI_RULE, ...empty, send_to_ai_hits: sendToAiHits, thresholds };
  }

  const whitelistHits = findHits(intakeRules.WHITELIST, text);
  const propertySignalHits = findHits(intakeRules.PROPERTY_SIGNAL, text);
  const whitelistMet = whitelistHits.length >= whitelistThreshold;
  const propertySignalMet = propertySignalHits.length >= propertySignalThreshold;

  const buyerSignalMet = buyerSignalPolicy === BUYER_SIGNAL_POLICIES.REQUIRE_ANY
    ? (whitelistMet || propertySignalMet)
    : (whitelistMet && propertySignalMet);

  if (buyerSignalMet) {
    return {
      decision: 'SEND_TO_AI',
      reason: buyerSignalPolicy === BUYER_SIGNAL_POLICIES.REQUIRE_ANY
        ? REASONS.WHITELIST_OR_PROPERTY_SIGNAL
        : REASONS.WHITELIST_AND_PROPERTY_SIGNAL,
      ...empty,
      whitelist_hits: whitelistHits,
      property_signal_hits: propertySignalHits,
      thresholds,
      buyer_signal_policy: buyerSignalPolicy,
    };
  }

  return {
    decision: 'REJECT',
    reason: REASONS.INSUFFICIENT_BUYER_SIGNAL,
    ...empty,
    whitelist_hits: whitelistHits,
    property_signal_hits: propertySignalHits,
    thresholds,
    buyer_signal_policy: buyerSignalPolicy,
  };
}

module.exports = { evaluateV2IntakeGate, findHits, ruleMatches, REASONS, BUYER_SIGNAL_POLICIES };
