'use strict';

const { sameKey } = require('../../../src/core/scoring');
const { compatibleStockTransactionTypes, priceFieldForRequest } = require('./transaction-semantics');

// P1.7 release blocker: `Number(null) === 0` and `Number('') === 0` are
// both finite -- a stock row with a genuinely missing numeric value
// (selling_price/bathrooms/size_sqft/plot_size_sqft stored as SQL NULL,
// which the pg driver hands back as JS `null`) must never be silently
// treated as the number zero. Every numeric hard filter below converts
// through this helper FIRST and branches on `=== null` for "unknown /
// unverifiable", never through a bare `Number(x)` + `isFinite` check.
function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Pure, side-effect-free hard-filter predicates (TZ 34: "FILTER FIRST, RANK
// SECOND" -- score never decides admissibility). Each predicate returns
// `{ active, passes }`: `active=false` means the criterion was not stated
// and therefore excluded entirely -- not "passed with full credit" (TZ 58).
// These are the single source of truth for filtering: candidate-query.js
// pushes the SAME rules into SQL for performance (TZ 100), and every
// candidate the SQL query returns is re-checked here before ranking as a
// defense-in-depth safety net (TZ 11).

// P0 release blocker: stock stores rentals as `transaction_type =
// 'RENT_YEARLY'` (confirmed live vocabulary: only SALE/RENT_YEARLY exist),
// while a request's transaction_type is 'SALE' | 'RENT' (parser/schema.js).
// A bare `===` here made every RENT request fail this filter unconditionally
// -- delegates to the shared transaction-semantics helper so this and
// candidate-query.js's SQL can never disagree on compatibility.
function transactionTypeFilter(request, stock) {
  if (!request.transaction_type) return { active: false, passes: true };
  const compatible = compatibleStockTransactionTypes(request.transaction_type);
  if (!compatible) return { active: true, passes: false }; // unrecognized request value -> can't confirm compatibility
  return { active: true, passes: compatible.includes(stock.transaction_type) };
}

function propertyTypeFilter(request, stock) {
  if (!request.property_type) return { active: false, passes: true };
  if (!stock.property_type) return { active: true, passes: false }; // unverifiable -> blocks
  return { active: true, passes: sameKey(request.property_type, stock.property_type) };
}

// Location is resolved to exactly one active level (building > project >
// area) before this runs -- see matching/location.js. `locationLevel` is
// 'building' | 'project' | 'area' | null; `locationValue` is the canonical
// (or raw, if unresolved-but-textually-known) value to compare against.
// `locationValues` (spec sections 10-17): when multiple acceptable areas
// were named, ANY of them matching is a pass (OR semantics) -- mirrors
// candidate-query.js's `area = ANY(...)` SQL exactly, so this defense-in-
// depth layer can never diverge from what the SQL already admitted.
// Building/project stay single-value; `locationValues` is only ever >1 long
// for the 'area' level.
function locationFilter(locationLevel, locationValue, stock, locationValues) {
  if (!locationLevel) return { active: false, passes: true };
  const stockField = locationLevel === 'project' ? stock.project_community : stock[locationLevel];
  const values = Array.isArray(locationValues) && locationValues.length > 0 ? locationValues : [locationValue];
  return { active: true, passes: values.some((value) => sameKey(value, stockField)) };
}

// TZ 50-51 -- tolerance applies ONLY to the ceiling. A stated floor is a
// strict `price >= min`, never discounted. This is a deliberate literal-TZ
// choice, NOT the same as the old pipeline's symmetric ±tolerance.
function budgetFilter(request, stock, config) {
  const { budget_min: min, budget_max: max } = request;
  if (min === null && max === null) return { active: false, passes: true };

  // P0 release blocker: RENT stock prices through `annual_rent`, not
  // `selling_price` (which is NULL on every RENT_YEARLY row) -- comparing
  // a RENT request's budget against selling_price always failed, on top of
  // the transaction_type mismatch above. Same shared helper as SQL.
  const priceField = priceFieldForRequest(request.transaction_type);
  const price = toFiniteNumberOrNull(stock[priceField]);
  if (price === null) return { active: true, passes: false }; // unverifiable -> blocks

  const tolerance = config.matchPriceTolerancePct / 100;
  if (max !== null && price > max * (1 + tolerance)) return { active: true, passes: false };
  if (min !== null && price < min) return { active: true, passes: false };
  return { active: true, passes: true };
}

// TZ 52-54 -- an inclusive [min, max] range (a single stated count sets
// both ends the same, "3BR+" leaves max null/open-ended). Neighboring
// bedroom counts are never accepted automatically.
function bedroomsFilter(request, stock) {
  const { bedrooms_min: min, bedrooms_max: max } = request;
  if (min === null && max === null) return { active: false, passes: true };

  if (stock.bedrooms === null || stock.bedrooms === undefined) {
    return { active: true, passes: false }; // unverifiable -> blocks
  }
  if (min !== null && stock.bedrooms < min) return { active: true, passes: false };
  if (max !== null && stock.bedrooms > max) return { active: true, passes: false };
  return { active: true, passes: true };
}

// Generic inclusive-range hard filter for a numeric stock field (TZ-plan
// item A.7: bathrooms/size_sqft/plot_size_sqft). Same "unverifiable ->
// blocks" convention as bedroomsFilter -- a stated requirement against a
// stock row with no value on record cannot be confirmed, so it is treated
// as a mismatch rather than silently passed.
function numericRangeFilter(min, max, stockValue) {
  if (min === null && max === null) return { active: false, passes: true };
  if (min === undefined && max === undefined) return { active: false, passes: true };
  const value = toFiniteNumberOrNull(stockValue);
  if (value === null) return { active: true, passes: false };
  if (min !== null && min !== undefined && value < min) return { active: true, passes: false };
  if (max !== null && max !== undefined && value > max) return { active: true, passes: false };
  return { active: true, passes: true };
}

function bathroomsFilter(request, stock) {
  return numericRangeFilter(request.bathrooms_min, request.bathrooms_max, stock.bathrooms);
}

function sizeSqftFilter(request, stock) {
  return numericRangeFilter(request.size_sqft_min, request.size_sqft_max, stock.size_sqft);
}

function plotSizeSqftFilter(request, stock) {
  return numericRangeFilter(request.plot_size_sqft_min, request.plot_size_sqft_max, stock.plot_size_sqft);
}

// Furnishing (TZ-plan item A.7): only ever a HARD filter, never a soft
// "closest match" score -- an explicit Furnished request must not match
// Unfurnished stock. Deliberately does NOT invent compatibility between
// Semi-Furnished and either extreme (exact match only), and a stock row
// with no furnishing on record is treated as unverifiable and blocks,
// same conservative posture as budget/bedrooms/property_type above. This
// is a documented, deliberately narrow v1: no attempt is made to treat
// "Semi-Furnished" as partially satisfying a "Furnished" request.
function furnishingFilter(request, stock) {
  if (!request.furnishing) return { active: false, passes: true };
  if (!stock.furnishing) return { active: true, passes: false };
  return { active: true, passes: sameKey(request.furnishing, stock.furnishing) };
}

// Runs every filter and returns the first failure (if any) plus each
// filter's raw result, so callers can both gate (any failure -> excluded)
// and rank (only active filters count toward the score denominator).
function evaluateHardFilters(request, stock, { locationLevel, locationValue, locationValues, config }) {
  const filters = {
    location: locationFilter(locationLevel, locationValue, stock, locationValues),
    transactionType: transactionTypeFilter(request, stock),
    propertyType: propertyTypeFilter(request, stock),
    budget: budgetFilter(request, stock, config),
    bedrooms: bedroomsFilter(request, stock),
    bathrooms: bathroomsFilter(request, stock),
    sizeSqft: sizeSqftFilter(request, stock),
    plotSizeSqft: plotSizeSqftFilter(request, stock),
    furnishing: furnishingFilter(request, stock),
  };

  const failedKey = Object.keys(filters).find((key) => filters[key].active && !filters[key].passes);

  return { filters, passed: !failedKey, failedFilter: failedKey || null };
}

module.exports = {
  transactionTypeFilter,
  propertyTypeFilter,
  locationFilter,
  budgetFilter,
  bedroomsFilter,
  bathroomsFilter,
  sizeSqftFilter,
  plotSizeSqftFilter,
  furnishingFilter,
  evaluateHardFilters,
};
