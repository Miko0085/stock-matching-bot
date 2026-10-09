'use strict';

const { normalizeAliasKey, normalizeText } = require('../../../src/core/normalize');
const { resolveAlias } = require('../../../src/core/aliases');

// Deterministic, free-form buyer-criteria extractor for the Dubai contour
// ONLY (cost-optimization plan item A.3-A.4, hardened per release-blocker
// audit P0.1/P1.4). Runs BEFORE OpenAI, on messages the triage stage has
// already screened for obvious ads/solicitations. Never infers a value
// that wasn't explicitly present in the text -- every field defaults to
// null and is only filled when a pattern actually matched.
//
// UAE / RF isolation (AGENTS.md, MARKET_CONTOURS_AND_SOURCE_ROUTING.md):
// this file must contain ONLY UAE (English/AED/sqft) semantics. Russian
// buyer phrases, RUB/млн amounts, "кв.м"/sqm, and "спальни" were removed
// from here deliberately -- they belong to the separate RF contour's own
// parser, never merged into this one just because both markets happen to
// exist in the same monorepo. A UAE message that only carries Russian
// buyer language will not be locally parsed here at all (no location/
// criteria will match) and correctly falls through to AI_REVIEW, where
// the (also UAE-only) AI prompt still applies -- RF text isn't expected
// to reach this contour at all once source routing is wired in.
function parseLocally(originalText, { aliasIndex = {} } = {}) {
  const text = normalizeText(originalText);

  if (hasHedge(text)) {
    return { ok: true, hedge: true, value: null, hasLocation: false, hasBuyerIntent: false, criteriaCount: 0 };
  }

  const location = detectLocation(originalText, aliasIndex);
  const bedrooms = detectBedrooms(text);
  const budget = detectBudget(text);
  const bathrooms = detectNumericRange(text, ['bathrooms?', 'bath']);
  const sizeSqft = detectNumericRange(text, ['sq\\.?\\s*ft', 'sqft']);
  const plotSizeSqft = detectNumericRange(text, ['plot\\s*sq\\.?\\s*ft', 'plot\\s*sqft']);
  const propertyType = detectPropertyTypeWithAlias(text, aliasIndex);
  const furnishing = detectFurnishing(text);
  const transactionType = detectTransactionType(text);
  const cashBuyer = detectCashBuyer(text);
  const hasBuyerIntent = detectStrongBuyerIntent(text);

  const hasLocation = Boolean(location.building || location.project || location.area);

  // P1.1 release blocker: only the SAME strong, independently-meaningful
  // criteria the matcher itself requires (location.js's
  // hasMinimumSpecificity -- bedrooms/budget/property_type, per
  // ADR-020/ADR-027's "a criterion has to be comparable exactly against
  // one specific stock item" bar) count toward "is this specific enough
  // to skip AI." bathrooms/size_sqft/furnishing are still extracted and
  // still become real hard filters once matching runs, but a weak field
  // alone must never be treated as sufficient justification for
  // PARSED_LOCALLY -- that would just reintroduce ADR-020's "one loose
  // field matches the whole stock" incident shape one layer up.
  const criteriaCount = [bedrooms, budget, propertyType].filter((v) => v !== null && v !== undefined).length;

  const value = {
    message_class: 'buyer_request',
    demand_owner: 'sender',
    promotion: false,
    spam: false,
    transaction_type: transactionType,
    area: location.area || null,
    project: location.project || null,
    building: location.building || null,
    property_type: propertyType,
    bedrooms_min: bedrooms ? bedrooms.min : null,
    bedrooms_max: bedrooms ? bedrooms.max : null,
    budget_min: budget ? budget.min : null,
    budget_max: budget ? budget.max : null,
    furnishing,
    cash_buyer: cashBuyer,
    bathrooms_min: bathrooms ? bathrooms.min : null,
    bathrooms_max: bathrooms ? bathrooms.max : null,
    size_sqft_min: sizeSqft ? sizeSqft.min : null,
    size_sqft_max: sizeSqft ? sizeSqft.max : null,
    plot_size_sqft_min: plotSizeSqft ? plotSizeSqft.min : null,
    plot_size_sqft_max: plotSizeSqft ? plotSizeSqft.max : null,
    // `view` is intentionally never populated by local parsing (P1.3):
    // it is carried in the schema as metadata only. Neither hard-filters.js
    // nor candidate-query.js filter on it -- claiming it were "supported"
    // without an end-to-end filter would be a false precision claim.
    view: null,
    confidence: 1,
  };

  return { ok: true, hedge: false, value, hasLocation, hasBuyerIntent, criteriaCount };
}

const UNIT_MULTIPLIERS = {
  m: 1_000_000,
  mln: 1_000_000,
  mil: 1_000_000,
  million: 1_000_000,
  k: 1_000,
  thousand: 1_000,
};

const MAX_CUES = [
  /\bmax(?:imum)?\b/i,
  /\bup\s*to\b/i,
  /\bnot\s+(?:above|more\s+than)\b/i,
  /\bunder\b/i,
  /\bbudget\b/i, // bare "budget X" -> ceiling, matches AI prompt's own rule
];

const MIN_CUES = [
  /\bmin(?:imum)?\b/i,
  /\bat\s+least\b/i,
  /\bfrom\b/i,
  /\bstarting\s+from\b/i,
];

const HEDGE_PATTERNS = [
  /\bmaybe\b/i,
  /\baround\b/i,
  /\bnot\s+sure\b/i,
  /\bsomewhere\b/i,
  /\bcould\s+stretch\b/i,
  /\bdepend(?:ing|s)?\s+on\b/i,
  /\bor\s+(?:so|thereabouts)\b/i,
];

// P0.1 release blocker: a bare listing-shaped message ("Business Bay /
// 2BR / AED 2.5M / Furnished") must NEVER auto-become a buyer_request
// just because location + criteria happened to be extractable -- that
// shape is exactly as consistent with someone advertising available
// stock. PARSED_LOCALLY additionally requires an explicit, UAE-English
// sender-owned demand signal. English only -- Russian buyer phrases
// belong to the RF contour (P1.4), never merged in here.
const STRONG_BUYER_INTENT_PATTERNS = [
  /\bneed(?:s|ed)?\b/i,
  /\blooking\s+for\b/i,
  /\blooking\s+to\s+buy\b/i,
  /\blooking\s+to\s+rent\b/i,
  /\bmy\s+client\s+needs?\b/i,
  /\bmy\s+client\s+is\s+looking\s+for\b/i,
  /\bclient\s+requirement\b/i,
  /\bwtb\b/i,
  /\brequired\b/i,
  /\bseeking\b/i,
];

function detectStrongBuyerIntent(text) {
  return STRONG_BUYER_INTENT_PATTERNS.some((p) => p.test(text));
}

const PROPERTY_TYPE_WORDS = [
  [/\bstudio\b/i, 'Studio'],
  [/\bapartment[s]?\b/i, 'Apartment'],
  [/\bflat[s]?\b/i, 'Apartment'],
  [/\bvilla[s]?\b/i, 'Villa'],
  [/\btownhouse[s]?\b/i, 'Townhouse'],
  [/\bpenthouse[s]?\b/i, 'Penthouse'],
  [/\bduplex(?:es)?\b/i, 'Duplex'],
  [/\boffice[s]?\b/i, 'Office'],
  [/\bretail\b/i, 'Retail'],
  [/\bland\b/i, 'Land'],
];

const FURNISHING_WORDS = [
  [/\bsemi[\s-]?furnished\b/i, 'Semi-Furnished'],
  [/\bunfurnished\b/i, 'Unfurnished'],
  [/\bfurnished\b/i, 'Furnished'],
];

function hasHedge(text) {
  return HEDGE_PATTERNS.some((p) => p.test(text));
}

function detectTransactionType(text) {
  if (/\b(rent|renting|rental|lease)\b/i.test(text)) return 'RENT';
  if (/\b(buy|buying|sale|purchase)\b/i.test(text)) return 'SALE';
  return null;
}

function detectCashBuyer(text) {
  if (/\bcash\b/i.test(text)) return true;
  if (/\bmortgage\b/i.test(text)) return false;
  return null;
}

function detectPropertyType(text) {
  for (const [pattern, canonical] of PROPERTY_TYPE_WORDS) {
    if (pattern.test(text)) return canonical;
  }
  return null;
}

function detectFurnishing(text) {
  for (const [pattern, canonical] of FURNISHING_WORDS) {
    if (pattern.test(text)) return canonical;
  }
  return null;
}

// Bedrooms: Studio -> 0,0; "2BR"/"2 bed"/"2 bedroom" -> min=max; "2-3BR"
// range; "3BR+" open-ended max.
function detectBedrooms(text) {
  if (/\bstudio\b/i.test(text)) return { min: 0, max: 0 };

  let m = text.match(/(\d+)\s*-\s*(\d+)\s*(?:br|bed(?:room)?s?)\b/i);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };

  // "3BR+" (suffix plus) and "3+ BR" (prefix plus) are both open-ended.
  m = text.match(/(\d+)\s*(?:br|bed(?:room)?s?)\s*\+/i);
  if (m) return { min: Number(m[1]), max: null };

  m = text.match(/(\d+)\s*\+\s*(?:br|bed(?:room)?s?)\b/i);
  if (m) return { min: Number(m[1]), max: null };

  m = text.match(/(\d+)\s*(?:br|bed(?:room)?s?)\b/i);
  if (m) return { min: Number(m[1]), max: Number(m[1]) };

  return null;
}

function parseAmountToken(rawNumber, rawUnit) {
  const n = Number(String(rawNumber).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = rawUnit ? String(rawUnit).toLowerCase() : null;
  const multiplier = unit && UNIT_MULTIPLIERS[unit] ? UNIT_MULTIPLIERS[unit] : 1;
  return n * multiplier;
}

const AMOUNT_RE = '(\\d[\\d,]*(?:\\.\\d+)?)\\s*(m|mln|mil|million|k|thousand)?';

// Comma- AND space-grouped numeric token, reserved for detectNumericRange
// below (bathrooms/sqft/plot sqft are always plain counts, never "1.2M
// sqft", so this has no unit-multiplier suffix unlike AMOUNT_RE). `\d+`
// greedily consumes a plain run of digits first ("1100" matches whole, no
// grouping needed), and each optional `[,\s]\d{3}` extends it by exactly
// one 3-digit group -- "1,100" and "1 100" both parse as 1100, "10,000" as
// 10000. A bare `.` stays decimal-only, same as AMOUNT_RE -- this fix does
// not touch or assume anything about period-as-thousands-separator
// notation (e.g. "1.100"), which has no documented rule in this codebase
// and is deliberately left alone.
const NUMERIC_TOKEN_RE = '(\\d+(?:[,\\s]\\d{3})*(?:\\.\\d+)?)';

function parseNumericToken(raw) {
  const n = Number(String(raw).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Detects an explicit numeric constraint pair with min/max cue words, e.g.
// "bathrooms 2-3", "size min 900 sqft". Deliberately narrow/explicit -- a
// bare number near "sqft" with no unit keyword nearby is NOT claimed here
// (left null; AI_REVIEW can still pick it up later).
//
// P1 release blocker (spec section 32/50-56): this used to match with a
// plain `\d+(?:\.\d+)?` token, which has no comma support at all -- for
// "1,100 sqft" the regex engine would skip the leading "1," (it can't match
// a comma inside `\d+`) and match starting at "100 sqft", silently
// truncating 1,100 down to 100. Every branch below now uses the same
// comma-aware NUMERIC_TOKEN_RE as detectBudget's AMOUNT_RE.
function detectNumericRange(text, unitWords) {
  const unitAlt = unitWords.join('|');
  const rangeRe = new RegExp(`${NUMERIC_TOKEN_RE}\\s*-\\s*${NUMERIC_TOKEN_RE}\\s*(?:${unitAlt})\\b`, 'i');
  let m = text.match(rangeRe);
  if (m) return { min: parseNumericToken(m[1]), max: parseNumericToken(m[2]) };

  const maxRe = new RegExp(`(?:max(?:imum)?|up\\s*to|not\\s+(?:above|more\\s+than))\\s+${NUMERIC_TOKEN_RE}\\s*(?:${unitAlt})\\b`, 'i');
  m = text.match(maxRe);
  if (m) return { min: null, max: parseNumericToken(m[1]) };

  const minRe = new RegExp(`(?:min(?:imum)?|at\\s+least|from)\\s+${NUMERIC_TOKEN_RE}\\s*(?:${unitAlt})\\b`, 'i');
  m = text.match(minRe);
  if (m) return { min: parseNumericToken(m[1]), max: null };

  const bareRe = new RegExp(`${NUMERIC_TOKEN_RE}\\s*(?:${unitAlt})\\b`, 'i');
  m = text.match(bareRe);
  if (m) {
    const value = parseNumericToken(m[1]);
    return { min: value, max: value };
  }

  return null;
}

// Budget: AED-flavored amounts with min/max cue words checked in a small
// window before the amount. A plain range like "2-2.5m" is recognized
// directly. A single stated figure with no cue defaults to budget_max
// only (never budget_min) -- same rule the AI prompt uses, kept
// consistent so local vs AI parsing never disagree on this ambiguity.
function detectBudget(text) {
  const rangeRe = new RegExp(`${AMOUNT_RE}\\s*-\\s*${AMOUNT_RE}\\s*(?:aed)?`, 'i');
  let m = text.match(rangeRe);
  if (m && (m[2] || m[4] || /aed/i.test(text))) {
    const min = parseAmountToken(m[1], m[2] || m[4]);
    const max = parseAmountToken(m[3], m[4] || m[2]);
    if (min !== null && max !== null) return { min, max };
  }

  const amountRe = new RegExp(AMOUNT_RE, 'gi');
  let match;
  const candidates = [];
  while ((match = amountRe.exec(text)) !== null) {
    if (!match[2] && !/aed/i.test(text.slice(match.index, match.index + 30))) continue;
    candidates.push({ index: match.index, amount: parseAmountToken(match[1], match[2]) });
  }

  for (const candidate of candidates) {
    if (candidate.amount === null) continue;
    const before = text.slice(Math.max(0, candidate.index - 20), candidate.index);
    if (MAX_CUES.some((p) => p.test(before))) return { min: null, max: candidate.amount };
    if (MIN_CUES.some((p) => p.test(before))) return { min: candidate.amount, max: null };
  }

  if (candidates.length === 1 && candidates[0].amount !== null) {
    return { min: null, max: candidates[0].amount };
  }

  return null;
}

// P1.8: do not assume an alias is at most 3 words -- real UAE project/
// community names can run longer ("Sobha Hartland II", "The Address
// Downtown", "Emaar Beachfront"). The underlying alias index
// (src/core/aliases.js) stores keys with all whitespace stripped, so the
// original word count per alias can't be recovered from the index alone
// without changing that shared module (used by the production n8n
// pipeline too) -- MAX_ALIAS_PHRASE_WORDS is a deliberately generous,
// documented upper bound for deterministic longest-match scanning rather
// than a hard assumption tied to today's data.
const MAX_ALIAS_PHRASE_WORDS = 6;

// Scans n-grams (longest-first, up to MAX_ALIAS_PHRASE_WORDS) of the
// ORIGINAL (not alias-stripped) text against the alias index for a given
// type, so a longer exact match is always preferred over a shorter
// spurious one. Returns the raw matched text (not yet resolved to
// canonical -- resolveAlias() runs again later in buildStructuredRequest,
// same as the AI path).
function findAliasMention(text, aliasIndex, type) {
  const bucket = aliasIndex && aliasIndex[type];
  if (!bucket || bucket.size === 0) return null;

  const tokens = text.split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);

  for (let n = Math.min(MAX_ALIAS_PHRASE_WORDS, tokens.length); n >= 1; n -= 1) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      const phrase = tokens.slice(i, i + n).join(' ');
      const key = normalizeAliasKey(phrase);
      if (key && bucket.has(key)) return phrase;
    }
  }
  return null;
}

function detectLocation(originalText, aliasIndex) {
  const building = findAliasMention(originalText, aliasIndex, 'building');
  const project = findAliasMention(originalText, aliasIndex, 'project');
  const area = findAliasMention(originalText, aliasIndex, 'area');
  return { building, project, area };
}

// Fallback direct property-type alias check (in case the caller's index
// has type='property_type' rows too) layered on top of the built-in
// PROPERTY_TYPE_WORDS dictionary -- alias hit wins when both fire, since
// it may carry deployment-specific synonyms this file doesn't know about.
function detectPropertyTypeWithAlias(text, aliasIndex) {
  const aliasHit = findAliasMention(text, aliasIndex, 'property_type');
  if (aliasHit) {
    const resolved = resolveAlias('property_type', aliasHit, aliasIndex);
    if (resolved.resolved) return resolved.value;
  }
  return detectPropertyType(text);
}

module.exports = {
  parseLocally,
  hasHedge,
  detectBedrooms,
  detectBudget,
  detectNumericRange,
  detectLocation,
  detectStrongBuyerIntent,
  MAX_ALIAS_PHRASE_WORDS,
};
