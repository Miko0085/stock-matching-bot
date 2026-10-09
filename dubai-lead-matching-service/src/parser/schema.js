'use strict';

// Validates/coerces the AI parser's raw JSON output (TZ 25) into a safe
// value. Mirrors the defensive-coercion pattern of the old pipeline's
// request-schema.js: untrusted input never throws, unsupported values are
// dropped to null/'unknown' with a warning recorded, never trusted as-is.

const MESSAGE_CLASSES = [
  'buyer_request',
  'seller_request',
  'inventory_ad',
  'broker_solicitation',
  'general_advertisement',
  'other',
  'unknown',
];
const DEMAND_OWNERS = ['sender', 'recipient', 'unknown'];
const TRANSACTION_TYPES = ['SALE', 'RENT'];
const FURNISHING_VALUES = ['Furnished', 'Unfurnished', 'Semi-Furnished'];

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function coerceEnum(rawValue, allowed, fallback, fieldName, warnings) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return fallback;
  const match = allowed.find((v) => normalizeText(v) === normalizeText(rawValue));
  if (!match) {
    warnings.push(`invalid_enum:${fieldName}`);
    return fallback;
  }
  return match;
}

function coerceString(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  const text = String(rawValue).trim();
  return text.length ? text : null;
}

// Multi-area support (spec sections 10-17): the AI prompt asks for EVERY
// acceptable area a buyer names ("A/B/C", "A or B") in `areas`, not just
// one. Accepts an array, a bare string (defensive -- some AI responses coerce
// a single-element array into a scalar), or nothing. Order-preserving,
// case-insensitive de-duplication only (no fuzzy work here -- that's the
// location dictionary's job downstream).
function coerceStringArray(rawValue) {
  if (rawValue === null || rawValue === undefined) return [];
  const items = Array.isArray(rawValue) ? rawValue : [rawValue];
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const text = coerceString(item);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function coerceNumber(rawValue, fieldName, warnings) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : null;
  const cleaned = String(rawValue).replace(/[,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    warnings.push(`malformed_number:${fieldName}`);
    return null;
  }
  return n;
}

function coerceInteger(rawValue, fieldName, warnings) {
  const n = coerceNumber(rawValue, fieldName, warnings);
  return n === null ? null : Math.round(n);
}

function coerceBoolean(rawValue, fallback = null) {
  if (typeof rawValue === 'boolean') return rawValue;
  if (rawValue === null || rawValue === undefined || rawValue === '') return fallback;
  const text = normalizeText(rawValue);
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  return fallback;
}

// bedrooms_min/max: normalize "studio" text into 0 if the AI ever puts it
// in a numeric field as a string (defensive; the schema asks for numbers).
function coerceBedroomBound(rawValue, fieldName, warnings) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : null;
  const text = normalizeText(rawValue);
  if (text === 'studio' || text === '0') return 0;
  return coerceInteger(rawValue, fieldName, warnings);
}

function parseAiOutput(raw) {
  const warnings = [];
  const source = raw && typeof raw === 'object' ? raw : {};

  const messageClass = coerceEnum(source.message_class, MESSAGE_CLASSES, 'unknown', 'message_class', warnings);
  const demandOwner = coerceEnum(source.demand_owner, DEMAND_OWNERS, 'unknown', 'demand_owner', warnings);

  let bedroomsMin = coerceBedroomBound(source.bedrooms_min, 'bedrooms_min', warnings);
  let bedroomsMax = coerceBedroomBound(source.bedrooms_max, 'bedrooms_max', warnings);
  if (bedroomsMin !== null && bedroomsMax !== null && bedroomsMin > bedroomsMax) {
    warnings.push('bedrooms_min_greater_than_bedrooms_max');
    [bedroomsMin, bedroomsMax] = [bedroomsMax, bedroomsMin];
  }

  let budgetMin = coerceNumber(source.budget_min, 'budget_min', warnings);
  let budgetMax = coerceNumber(source.budget_max, 'budget_max', warnings);
  if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) {
    warnings.push('budget_min_greater_than_budget_max');
    [budgetMin, budgetMax] = [budgetMax, budgetMin];
  }

  let bathroomsMin = coerceNumber(source.bathrooms_min, 'bathrooms_min', warnings);
  let bathroomsMax = coerceNumber(source.bathrooms_max, 'bathrooms_max', warnings);
  if (bathroomsMin !== null && bathroomsMax !== null && bathroomsMin > bathroomsMax) {
    [bathroomsMin, bathroomsMax] = [bathroomsMax, bathroomsMin];
  }

  let sizeSqftMin = coerceNumber(source.size_sqft_min, 'size_sqft_min', warnings);
  let sizeSqftMax = coerceNumber(source.size_sqft_max, 'size_sqft_max', warnings);
  if (sizeSqftMin !== null && sizeSqftMax !== null && sizeSqftMin > sizeSqftMax) {
    [sizeSqftMin, sizeSqftMax] = [sizeSqftMax, sizeSqftMin];
  }

  let plotSizeSqftMin = coerceNumber(source.plot_size_sqft_min, 'plot_size_sqft_min', warnings);
  let plotSizeSqftMax = coerceNumber(source.plot_size_sqft_max, 'plot_size_sqft_max', warnings);
  if (plotSizeSqftMin !== null && plotSizeSqftMax !== null && plotSizeSqftMin > plotSizeSqftMax) {
    [plotSizeSqftMin, plotSizeSqftMax] = [plotSizeSqftMax, plotSizeSqftMin];
  }

  const value = {
    message_class: messageClass,
    demand_owner: demandOwner,
    promotion: coerceBoolean(source.promotion, false),
    spam: coerceBoolean(source.spam, false),
    transaction_type: coerceEnum(source.transaction_type, TRANSACTION_TYPES, null, 'transaction_type', warnings),
    area: coerceString(source.area),
    // `areas`: every acceptable area, independently. Falls back to a
    // single-element array built from `area` when the caller (an older
    // cached AI response, the local parser, or a manual /v1/match input)
    // only ever populated the singular field -- keeps buildStructuredRequest
    // able to always iterate `areas` uniformly (spec section 10).
    areas: (() => {
      const list = coerceStringArray(source.areas);
      if (list.length > 0) return list;
      const single = coerceString(source.area);
      return single ? [single] : [];
    })(),
    project: coerceString(source.project),
    building: coerceString(source.building),
    property_type: coerceString(source.property_type),
    bedrooms_min: bedroomsMin,
    bedrooms_max: bedroomsMax,
    budget_min: budgetMin,
    budget_max: budgetMax,
    furnishing: coerceEnum(source.furnishing, FURNISHING_VALUES, null, 'furnishing', warnings),
    cash_buyer: coerceBoolean(source.cash_buyer, null),
    bathrooms_min: bathroomsMin,
    bathrooms_max: bathroomsMax,
    size_sqft_min: sizeSqftMin,
    size_sqft_max: sizeSqftMax,
    plot_size_sqft_min: plotSizeSqftMin,
    plot_size_sqft_max: plotSizeSqftMax,
    // P1.3: `view` is deliberately NOT requested in the AI prompt and
    // never extracted by the local parser -- it is accepted here only as
    // passive metadata (harmless if some future caller sets it) and is
    // never used by any hard filter or score. Wiring it end-to-end would
    // require a real view-compatibility rule this codebase doesn't have
    // yet; claiming support without one would be a false precision claim.
    view: coerceString(source.view),
    confidence:
      source.confidence === null || source.confidence === undefined
        ? null
        : Math.min(1, Math.max(0, coerceNumber(source.confidence, 'confidence', warnings) ?? 0)),
  };

  return { value, warnings };
}

module.exports = {
  MESSAGE_CLASSES,
  DEMAND_OWNERS,
  TRANSACTION_TYPES,
  FURNISHING_VALUES,
  parseAiOutput,
};
