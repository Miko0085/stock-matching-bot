'use strict';

// Pure source-routing decision (MARKET_CONTOURS_AND_SOURCE_ROUTING.md
// section 11-13, ADR-028). Deliberately contains NO domain matching logic
// -- it only decides WHICH contour(s), if any, a raw event should be
// handed to, using the source's stored operator decision plus (only for
// AUTO) cheap deterministic text evidence. Never queries a database,
// never calls OpenAI: routing must not spend an AI call merely to guess
// the market when the source itself can just be assigned manually.

const DUBAI_EVIDENCE_PATTERNS = [
  /\bAED\b/i,
  /\bDubai\b/i,
  /\bUAE\b/i,
  /\bU\.A\.E\.?\b/i,
];

// Deliberately NOT using \b word-boundary assertions around the Cyrillic
// patterns: JS regex's \b is defined against ASCII \w only, so Cyrillic
// letters are never "word characters" to it -- \bМосква\b silently never
// matches at all (confirmed live). Plain substring patterns are used
// instead, same workaround already established in primary-lead-gate.js.
const RF_EVIDENCE_PATTERNS = [
  /\bRUB\b/i,
  /₽/,
  /москва/iu,
  /московская\s+область/iu,
  /млн/iu, // "миллион" (RUB) -- a strong RF-only unit signal, never used in AED phrasing
];

// Returns 'DUBAI' | 'RF' | 'UNRESOLVED'. Ambiguous (both or neither) ->
// UNRESOLVED, never guessed -- ambiguity here is a config/data problem to
// surface, not something to silently paper over.
function detectMarketEvidence(text) {
  const hasDubai = DUBAI_EVIDENCE_PATTERNS.some((p) => p.test(text || ''));
  const hasRf = RF_EVIDENCE_PATTERNS.some((p) => p.test(text || ''));
  if (hasDubai && !hasRf) return 'DUBAI';
  if (hasRf && !hasDubai) return 'RF';
  return 'UNRESOLVED';
}

// `sourceRoute` is the {monitoring_enabled, route_mode} shape returned by
// source-repository.js (or an equivalent plain object in tests).
// `originalText` is only consulted when route_mode === 'AUTO'.
//
// Returns { contours: string[], reason: string }. `contours` is empty for
// NONE/monitoring-disabled/unresolved-AUTO -- callers stop entirely in
// that case, they never fall back to a default contour.
function resolveRoute({ sourceRoute, originalText }) {
  if (!sourceRoute || !sourceRoute.monitoring_enabled) {
    return { contours: [], reason: 'monitoring_disabled' };
  }

  switch (sourceRoute.route_mode) {
    case 'NONE':
      return { contours: [], reason: 'route_none' };
    case 'DUBAI':
      return { contours: ['DUBAI'], reason: 'route_dubai' };
    case 'RF':
      return { contours: ['RF'], reason: 'route_rf' };
    case 'BOTH':
      // Each contour is invoked independently downstream -- one
      // rejecting must never suppress the other (section 13).
      return { contours: ['DUBAI', 'RF'], reason: 'route_both' };
    case 'AUTO': {
      const evidence = detectMarketEvidence(originalText);
      if (evidence === 'UNRESOLVED') return { contours: [], reason: 'auto_unresolved' };
      return { contours: [evidence], reason: `auto_${evidence.toLowerCase()}` };
    }
    default:
      return { contours: [], reason: 'unknown_route_mode' };
  }
}

module.exports = { resolveRoute, detectMarketEvidence };
