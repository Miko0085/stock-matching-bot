'use strict';

// Moscow's own defensive-coercion layer for the AI parser's raw JSON
// output -- built BY ANALOGY with lead-matching-service/src/parser/
// schema.js's "untrusted input never throws" posture, but its own copy
// (not a shared/parameterized module): the UAE file doesn't export its
// coerce* primitives independently, and the field sets have diverged too
// much (rooms/rooms_sentinel/district/complex vs area/building/project/
// bedrooms) to usefully share beyond copying the same small, generic
// helpers.

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
const ROOMS_SENTINELS = ['STUDIO', 'FREE_PLAN'];

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
  if (['true', 'yes', 'да', '1'].includes(text)) return true;
  if (['false', 'no', 'нет', '0'].includes(text)) return false;
  return fallback;
}

// "студия"/"свободная планировка" mapped in prompt.js's own instructions
// to rooms=0/null + rooms_sentinel -- this just defends against the AI
// putting the Russian word directly in the numeric `rooms` field anyway.
function coerceRooms(rawValue, warnings) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? Math.round(rawValue) : null;
  const text = normalizeText(rawValue);
  if (text.includes('студия')) return 0;
  if (text.includes('своб')) return null;
  return coerceInteger(rawValue, 'rooms', warnings);
}

function parseAiOutput(raw) {
  const warnings = [];
  const source = raw && typeof raw === 'object' ? raw : {};

  const messageClass = coerceEnum(source.message_class, MESSAGE_CLASSES, 'unknown', 'message_class', warnings);
  const demandOwner = coerceEnum(source.demand_owner, DEMAND_OWNERS, 'unknown', 'demand_owner', warnings);

  let bedroomsMin = coerceInteger(source.bedrooms_min, 'bedrooms_min', warnings);
  let bedroomsMax = coerceInteger(source.bedrooms_max, 'bedrooms_max', warnings);
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

  let areaSqmMin = coerceNumber(source.area_sqm_min, 'area_sqm_min', warnings);
  let areaSqmMax = coerceNumber(source.area_sqm_max, 'area_sqm_max', warnings);
  if (areaSqmMin !== null && areaSqmMax !== null && areaSqmMin > areaSqmMax) {
    [areaSqmMin, areaSqmMax] = [areaSqmMax, areaSqmMin];
  }

  let floorMin = coerceInteger(source.floor_min, 'floor_min', warnings);
  let floorMax = coerceInteger(source.floor_max, 'floor_max', warnings);
  if (floorMin !== null && floorMax !== null && floorMin > floorMax) {
    [floorMin, floorMax] = [floorMax, floorMin];
  }

  const value = {
    message_class: messageClass,
    demand_owner: demandOwner,
    promotion: coerceBoolean(source.promotion, false),
    spam: coerceBoolean(source.spam, false),
    transaction_type: coerceEnum(source.transaction_type, TRANSACTION_TYPES, null, 'transaction_type', warnings),
    district: coerceString(source.district),
    complex: coerceString(source.complex),
    property_type: coerceString(source.property_type),
    rooms: coerceRooms(source.rooms, warnings),
    rooms_sentinel: coerceEnum(source.rooms_sentinel, ROOMS_SENTINELS, null, 'rooms_sentinel', warnings),
    bedrooms_min: bedroomsMin,
    bedrooms_max: bedroomsMax,
    budget_min: budgetMin,
    budget_max: budgetMax,
    area_sqm_min: areaSqmMin,
    area_sqm_max: areaSqmMax,
    floor_min: floorMin,
    floor_max: floorMax,
    readiness_year: coerceInteger(source.readiness_year, 'readiness_year', warnings),
    cash_buyer: coerceBoolean(source.cash_buyer, null),
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
  ROOMS_SENTINELS,
  parseAiOutput,
};
