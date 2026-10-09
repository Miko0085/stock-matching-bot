'use strict';

const { normalizeBedrooms, normalizeText } = require('./normalize');

const TRANSACTION_TYPES = ['SALE', 'RENT'];
const FURNISHING_VALUES = ['Furnished', 'Unfurnished', 'Semi-Furnished'];

function coerceEnum(rawValue, allowed, fieldName, warnings) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  const match = allowed.find((v) => normalizeText(v) === normalizeText(rawValue));
  if (!match) {
    warnings.push(`invalid_enum:${fieldName}`);
    return null;
  }
  return match;
}

function coerceNumber(rawValue, fieldName, warnings) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? rawValue : null;
  }
  const cleaned = String(rawValue).replace(/[,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    warnings.push(`malformed_number:${fieldName}`);
    return null;
  }
  return n;
}

function coerceBoolean(rawValue) {
  if (typeof rawValue === 'boolean') return rawValue;
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  const text = normalizeText(rawValue);
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  return null;
}

function coerceString(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  const text = String(rawValue).trim();
  return text.length ? text : null;
}

// Four independent classification labels (replacing the old single
// is_request boolean, ADR-017) — mirrors Devi's "AI Leads Filter" category
// shape (buyingIntent/seekInfo/promotion/spam) rather than one collapsed
// yes/no judgment. Each defaults permissively (buying_intent) or
// conservatively (the other three) when the parser omits it, same
// "unknown doesn't penalize" philosophy the old is_request default used.
function coerceClassificationLabel(rawValue, defaultValue, fieldName, warnings) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    warnings.push(`missing:${fieldName}`);
    return defaultValue;
  }
  const coerced = coerceBoolean(rawValue);
  if (coerced === null) {
    warnings.push(`malformed_boolean:${fieldName}`);
    return defaultValue;
  }
  return coerced;
}

// Validates/normalizes the AI parser's raw JSON output into a safe structured
// request. Unsupported enum values and malformed numbers are dropped (set to
// null) rather than trusted, and every drop is recorded in `warnings` so it
// stays diagnosable. Never throws — the parser is untrusted input.
function validateParsedRequest(raw) {
  const errors = [];
  const warnings = [];
  const source = raw && typeof raw === 'object' ? raw : {};

  const buyingIntent = coerceClassificationLabel(source.buying_intent, true, 'buying_intent', warnings);
  const seekingInfo = coerceClassificationLabel(source.seeking_info, false, 'seeking_info', warnings);
  const promotion = coerceClassificationLabel(source.promotion, false, 'promotion', warnings);
  const spam = coerceClassificationLabel(source.spam, false, 'spam', warnings);

  const bedrooms = normalizeBedrooms(source.bedrooms);
  if (source.bedrooms !== null && source.bedrooms !== undefined && bedrooms === null) {
    warnings.push('malformed_number:bedrooms');
  }

  const confidenceRaw = coerceNumber(source.confidence, 'confidence', warnings);
  const confidence =
    confidenceRaw === null ? null : Math.min(1, Math.max(0, confidenceRaw));

  const value = {
    buying_intent: buyingIntent,
    seeking_info: seekingInfo,
    promotion,
    spam,
    transaction_type: coerceEnum(
      source.transaction_type,
      TRANSACTION_TYPES,
      'transaction_type',
      warnings
    ),
    area: coerceString(source.area),
    building: coerceString(source.building),
    bedrooms,
    property_type: coerceString(source.property_type),
    budget_min: coerceNumber(source.budget_min, 'budget_min', warnings),
    budget_max: coerceNumber(source.budget_max, 'budget_max', warnings),
    furnishing: coerceEnum(source.furnishing, FURNISHING_VALUES, 'furnishing', warnings),
    cash_buyer: coerceBoolean(source.cash_buyer),
    confidence,
  };

  if (
    value.budget_min !== null &&
    value.budget_max !== null &&
    value.budget_min > value.budget_max
  ) {
    warnings.push('budget_min_greater_than_budget_max');
    const swap = value.budget_min;
    value.budget_min = value.budget_max;
    value.budget_max = swap;
  }

  // ADR-020 real incident: a "villa plot" request listing 5 named areas
  // (a shape our single `area` field can't hold, so the parser returned
  // area: null) with an unparseable budget ("Market Price") still had
  // property_type: "Villa" — and that alone used to be enough to pass this
  // gate. With every other field null, "unknown doesn't penalize" then
  // gave full credit on all four remaining criteria, scoring 100/100
  // against every villa in the entire stock regardless of location
  // (74 STRONG_MATCH messages for one ambiguous post). property_type alone
  // is deliberately excluded from this check — real signal for *scoring* a
  // candidate, but not enough on its own to decide the request is specific
  // enough to safely match against the whole stock.
  //
  // ADR-027 real incident: budget was briefly added here too (a request
  // stating only a budget seemed like real signal), but the exact same
  // failure mode reproduced with a request that had ONLY a budget of "up
  // to 100,000,000 AED" (effectively unbounded) — no area, no bedrooms, no
  // property type. It matched 74 listings spanning apartments, villas, and
  // offices across every area in the stock, all at 100/100. A budget
  // ceiling narrows nothing about location or property type, so like
  // property_type it is excluded here — it stays real signal for scoring,
  // just never enough alone to call a request specific enough to match.
  // Only area/building/bedrooms — attributes we can compare exactly
  // against a specific stock item — count as real matching criteria.
  const hasAnyCriteria = Boolean(value.area || value.building || value.bedrooms !== null);
  if (!hasAnyCriteria) {
    warnings.push('parser_missing_fields');
  }

  return { value, errors, warnings, valid: errors.length === 0 };
}

module.exports = {
  TRANSACTION_TYPES,
  FURNISHING_VALUES,
  validateParsedRequest,
};
