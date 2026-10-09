'use strict';

const { sameKey } = require('../../../src/core/scoring');

// Moscow's hard filters -- BY ANALOGY with lead-matching-service/src/
// matching/hard-filters.js's "FILTER FIRST, RANK SECOND" discipline
// (`{active, passes}` per predicate; `active=false` excludes a criterion
// from scoring entirely, never "passed with full credit"), with ONE
// deliberate addition UAE doesn't have: every criterion here is ALSO
// gated by its own `joker_*_enabled` runtime setting (migration 0031) --
// an operator-disabled criterion is never hard-filtered, exactly the same
// "not active" semantics as "buyer never stated it."
//
// `settings` is the shape getActiveRuntimeSettings() returns:
// { [key]: { value, enabled } }.
function isCriterionEnabled(settings, key) {
  return settings[key]?.value === true;
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Structural, not gated by any toggle -- same as UAE's transactionTypeFilter
// (never behind a setting). A buyer wanting to BUY must never be shown
// rental stock, regardless of any per-criterion configuration.
function dealTypeFilter(request, stock) {
  if (!request.transaction_type) return { active: false, passes: true };
  const wantsSale = request.transaction_type === 'SALE';
  const wantsRent = request.transaction_type === 'RENT';
  if (!stock.deal_type) return { active: true, passes: false }; // unverifiable -> blocks
  const stockIsSale = normalizeDealType(stock.deal_type) === 'sale';
  const stockIsRent = normalizeDealType(stock.deal_type) === 'rent';
  if (wantsSale) return { active: true, passes: stockIsSale };
  if (wantsRent) return { active: true, passes: stockIsRent };
  return { active: true, passes: false };
}

function normalizeDealType(value) {
  return String(value || '').trim().toLowerCase();
}

// Commercial real estate is always excluded from buyer-facing matching
// (business rule, independent of joker_property_type_enabled -- same
// principle as UAE's promotion/is_request filtering, and matches
// dashboard/joker-criteria-reference.js's own documented note).
function propertyTypeFilter(request, stock, settings) {
  if (stock.property_type_excluded) return { active: true, passes: false };
  if (!isCriterionEnabled(settings, 'joker_property_type_enabled')) return { active: false, passes: true };
  if (!request.property_type) return { active: false, passes: true };
  if (!stock.property_type) return { active: true, passes: false };
  return { active: true, passes: sameKey(request.property_type, stock.property_type) };
}

// `locationLevel` is 'complex' | 'district' | null, resolved by location.js.
// Not gated by a toggle -- location is structurally mandatory (matches the
// `location_*` CHECK convention), same as UAE.
function locationFilter(locationLevel, locationValue, stock) {
  if (!locationLevel) return { active: false, passes: true };
  const stockField = stock[locationLevel];
  return { active: true, passes: sameKey(locationValue, stockField) };
}

// Комнаты (rooms) -- the PRIMARY, reliably-populated Moscow criterion
// (~40% coverage across all property types, much higher for apartments).
// STUDIO/FREE_PLAN sentinels (real Joker data quirks, docs/PER_MARKET_
// SERVICE_INDEPENDENCE_PLAN.md 5.1.2) are handled explicitly: a buyer
// asking for a studio must match a stock STUDIO sentinel row, not rooms=0
// on an unrelated listing.
function roomsFilter(request, stock, settings) {
  if (!isCriterionEnabled(settings, 'joker_rooms_enabled')) return { active: false, passes: true };
  if (request.rooms === null && !request.rooms_sentinel) return { active: false, passes: true };

  if (request.rooms_sentinel) {
    if (!stock.rooms_sentinel) return { active: true, passes: false };
    return { active: true, passes: stock.rooms_sentinel === request.rooms_sentinel };
  }
  if (stock.rooms === null || stock.rooms === undefined) return { active: true, passes: false }; // unverifiable -> blocks
  return { active: true, passes: Number(stock.rooms) === Number(request.rooms) };
}

// Спальни (bedrooms) -- a DELIBERATE divergence from UAE's "unknown stock
// value blocks" posture: a live data audit (2026-09-28) found this field
// populated on only ~4% of real Moscow stock rows (507/13,116), unlike
// UAE where bedrooms is a normal, reliably-populated field. Copying UAE's
// conservative "unverifiable -> blocks" rule here would make virtually
// every candidate fail this filter the instant a buyer mentions bedrooms,
// making the matcher non-functional in practice. Missing STOCK data is
// therefore treated as "cannot compare, skip" (active: false) rather than
// a block -- `rooms` above remains the reliable, blocking criterion.
function bedroomsFilter(request, stock, settings) {
  if (!isCriterionEnabled(settings, 'joker_bedrooms_enabled')) return { active: false, passes: true };
  if (request.bedrooms_min === null && request.bedrooms_max === null) return { active: false, passes: true };
  if (stock.bedrooms === null || stock.bedrooms === undefined) return { active: false, passes: true };
  const { bedrooms_min: min, bedrooms_max: max } = request;
  if (min !== null && stock.bedrooms < min) return { active: true, passes: false };
  if (max !== null && stock.bedrooms > max) return { active: true, passes: false };
  return { active: true, passes: true };
}

function numericRangeFilter(min, max, stockValue, settingKey, settings) {
  if (!isCriterionEnabled(settings, settingKey)) return { active: false, passes: true };
  if ((min === null || min === undefined) && (max === null || max === undefined)) return { active: false, passes: true };
  const value = toFiniteNumberOrNull(stockValue);
  if (value === null) return { active: true, passes: false };
  if (min !== null && min !== undefined && value < min) return { active: true, passes: false };
  if (max !== null && max !== undefined && value > max) return { active: true, passes: false };
  return { active: true, passes: true };
}

function areaFilter(request, stock, settings) {
  return numericRangeFilter(request.area_sqm_min, request.area_sqm_max, stock.area_sqm, 'joker_area_enabled', settings);
}

function floorFilter(request, stock, settings) {
  return numericRangeFilter(request.floor_min, request.floor_max, stock.floor, 'joker_floor_enabled', settings);
}

// Price -- tolerance applies only to the ceiling, same as UAE's
// budgetFilter (a stated floor is a strict `price >= min`).
function priceFilter(request, stock, settings) {
  if (!isCriterionEnabled(settings, 'joker_price_enabled')) return { active: false, passes: true };
  const { budget_min: min, budget_max: max } = request;
  if (min === null && max === null) return { active: false, passes: true };
  const price = toFiniteNumberOrNull(stock.price);
  if (price === null) return { active: true, passes: false };
  const tolerance = (settings.joker_price_tolerance_pct?.value ?? 10) / 100;
  if (max !== null && price > max * (1 + tolerance)) return { active: true, passes: false };
  if (min !== null && price < min) return { active: true, passes: false };
  return { active: true, passes: true };
}

function readinessFilter(request, stock, settings) {
  if (!isCriterionEnabled(settings, 'joker_readiness_enabled')) return { active: false, passes: true };
  if (request.readiness_year === null || request.readiness_year === undefined) return { active: false, passes: true };
  if (stock.readiness_year === null || stock.readiness_year === undefined) return { active: true, passes: false };
  // "готов к такому-то году" -- stock must be ready no later than requested.
  return { active: true, passes: Number(stock.readiness_year) <= Number(request.readiness_year) };
}

function evaluateHardFilters(request, stock, { locationLevel, locationValue, settings }) {
  const filters = {
    location: locationFilter(locationLevel, locationValue, stock),
    dealType: dealTypeFilter(request, stock),
    propertyType: propertyTypeFilter(request, stock, settings),
    rooms: roomsFilter(request, stock, settings),
    bedrooms: bedroomsFilter(request, stock, settings),
    area: areaFilter(request, stock, settings),
    floor: floorFilter(request, stock, settings),
    price: priceFilter(request, stock, settings),
    readiness: readinessFilter(request, stock, settings),
  };

  const failedKey = Object.keys(filters).find((key) => filters[key].active && !filters[key].passes);
  return { filters, passed: !failedKey, failedFilter: failedKey || null };
}

module.exports = {
  dealTypeFilter,
  propertyTypeFilter,
  locationFilter,
  roomsFilter,
  bedroomsFilter,
  areaFilter,
  floorFilter,
  priceFilter,
  readinessFilter,
  evaluateHardFilters,
};
