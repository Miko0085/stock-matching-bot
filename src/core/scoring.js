'use strict';

const { normalizeAliasKey, normalizeText } = require('./normalize');

// A stock item in the same area as a requested building, but not that exact
// building, still gets partial location credit instead of zero.
const AREA_ONLY_WHEN_BUILDING_REQUESTED_RATIO = 0.6;

function sameKey(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return normalizeAliasKey(a) === normalizeAliasKey(b);
}

function locationScore(request, stock, weight) {
  const wantsBuilding = Boolean(request.building);
  const wantsArea = Boolean(request.area);

  if (!wantsBuilding && !wantsArea) return weight; // nothing to compare against — do not penalize

  if (wantsBuilding) {
    if (sameKey(request.building, stock.building)) return weight;
    if (wantsArea && sameKey(request.area, stock.area)) {
      return Math.round(weight * AREA_ONLY_WHEN_BUILDING_REQUESTED_RATIO);
    }
    return 0;
  }

  return sameKey(request.area, stock.area) ? weight : 0;
}

function bedroomsScore(request, stock, weight) {
  if (request.bedrooms === null || request.bedrooms === undefined) return weight;
  if (stock.bedrooms === null || stock.bedrooms === undefined) return 0;
  return Number(request.bedrooms) === Number(stock.bedrooms) ? weight : 0;
}

// Hard bedroom gate (ADR-019) — same problem class as budget (ADR-018):
// bedrooms is only 25 of 100 weighted points, so a real bedroom mismatch
// (bedroomsScore correctly scoring 0) could still clear the 70-point MATCH
// threshold on location+propertyType+budget+furnishing alone (up to 75/100
// — exactly the real production incident this fixes: a 5-bedroom request
// shown a 4-bedroom and a 3-bedroom villa, both at 75/100). Unlike budget
// there is no percentage tolerance here — a stated bedroom count is exact
// or it is not a match; "1 bedroom off" is exactly the case this must
// reject. "Unknown doesn't penalize" still holds for the request side: no
// stated bedroom count never blocks. Unlike furnishing, a stock row with
// no bedroom count on record is treated as unverifiable and blocks (same
// asymmetry bedroomsScore's 0-credit-if-stock-unknown already encoded).
function isBedroomsAcceptable(request, stock) {
  if (request.bedrooms === null || request.bedrooms === undefined) return true;
  if (stock.bedrooms === null || stock.bedrooms === undefined) return false;
  return Number(request.bedrooms) === Number(stock.bedrooms);
}

function propertyTypeScore(request, stock, weight) {
  if (!request.propertyType) return weight;
  if (!stock.property_type) return 0;
  return sameKey(request.propertyType, stock.property_type) ? weight : 0;
}

// Hard property-type gate (ADR-025) — same problem class as bedrooms
// (ADR-019) and budget (ADR-018): propertyType is only 15 of 100 weighted
// points, so a genuine category mismatch (a Villa/Townhouse request shown
// Apartment stock) could still clear the STRONG_MATCH threshold on
// location+bedrooms+budget+furnishing alone (up to 85/100 — exactly the
// real production incident this fixes: Townhouse/Villa requests fanned out
// across dozens of unrelated Apartment listings, all at 85/100). Alias
// resolution (aliases.js) already collapses true spelling synonyms
// ("Flat" -> "Apartment") to the same canonical value before this runs, so
// a real alias match is never blocked here — only a genuine category
// mismatch is. "Unknown doesn't penalize" still holds for the request
// side; a stock row with no property_type on record is treated as
// unverifiable and blocks (same asymmetry bedrooms/budget already encode).
function isPropertyTypeAcceptable(request, stock) {
  if (!request.propertyType) return true;
  if (!stock.property_type) return false;
  return sameKey(request.propertyType, stock.property_type);
}

function budgetScore(request, stock, weight, config) {
  const price = Number(stock.selling_price);
  const hasPrice = Number.isFinite(price);
  const { budgetMax, budgetMin } = request;
  const bands = config.budgetBands;
  const tolerancePct = config.matchPriceTolerancePct;

  if (!hasPrice) return 0;

  if (budgetMax === null || budgetMax === undefined) {
    if (budgetMin === null || budgetMin === undefined) return weight;
    return price >= budgetMin ? weight : 0;
  }

  if (price <= budgetMax) return scaleBand(bands.within, weight);

  const overPct = ((price - budgetMax) / budgetMax) * 100;
  if (overPct <= 5) return scaleBand(bands.over0to5, weight);
  if (overPct <= tolerancePct) return scaleBand(bands.over5to10, weight);
  return scaleBand(bands.over10, weight);
}

// Budget bands in config are expressed against the default weight (20). If a
// deployment configures a different budget weight, scale proportionally.
function scaleBand(bandValue, weight) {
  const defaultWeight = 20;
  return Math.round((bandValue / defaultWeight) * weight);
}

// Hard price gate (ADR-018) — separate from budgetScore's graduated
// points. Budget alone is only 20 of 100 weighted points, so a listing
// wildly over budget could previously still clear the MATCH threshold on
// location+bedrooms+propertyType+furnishing alone (up to 80/100) even
// though budgetScore correctly gave it 0. This mirrors the same "hard
// gate, not just a scored criterion" treatment area (ADR-006) and
// transaction_type (ADR-012) already get. "Unknown doesn't penalize"
// still holds: no stated budget, or no stock price, never blocks.
function isBudgetWithinTolerance(request, stock, config) {
  // AUDIT item #7 (Number(null) === 0 trap, same bug class as P1.7 in the
  // standalone lead-matching-service's hard-filters.js): stock.selling_
  // price === null must be treated as "we don't know the price" -- this
  // function's own documented contract (ADR-018: "no stock price... never
  // blocks") -- not coerced to a literal 0 AED. `Number(null)` is `0`,
  // and `0` DOES pass `Number.isFinite`, so the guard below alone never
  // actually caught a null price: a null-priced candidate could still be
  // wrongly hard-blocked by a stated budget_min alone (0 < budget_min *
  // (1 - tolerance) is true), the exact opposite of this function's own
  // "unknown never blocks" rule. This check restores that documented
  // behavior; it does not change it.
  if (stock.selling_price === null || stock.selling_price === undefined || stock.selling_price === '') return true;
  const price = Number(stock.selling_price);
  if (!Number.isFinite(price)) return true;

  const { budgetMax, budgetMin } = request;
  const tolerance = config.matchPriceTolerancePct / 100;

  // ADR-025 follow-up: real incident had budgetMin=5,000,000 AND
  // budgetMax=5,500,000 stated together (a range, not just a ceiling) —
  // the previous if/else-if only ever checked ONE bound when both were
  // present (whichever branch matched first), silently ignoring budgetMin
  // whenever budgetMax existed. That let stock priced at 1/5th of the
  // stated range (890,000 against a 3,000,000-7,000,000 request) pass
  // clean through. Both bounds are now checked independently whenever
  // stated, matching the original "иногда цена сильно отличается от
  // запроса и стока" intent (too far in EITHER direction, not just over).
  if (budgetMax !== null && budgetMax !== undefined && price > budgetMax * (1 + tolerance)) {
    return false;
  }
  if (budgetMin !== null && budgetMin !== undefined && price < budgetMin * (1 - tolerance)) {
    return false;
  }
  return true; // no stated budget bound at all — nothing to gate against
}

function furnishingScore(request, stock, weight) {
  if (!request.furnishing) return weight; // unknown request furnishing never penalizes
  if (!stock.furnishing) return weight; // missing stock data — nothing to contradict
  return normalizeText(request.furnishing) === normalizeText(stock.furnishing) ? weight : 0;
}

function computeScore(request, stock, config) {
  const w = config.weights;
  const location = locationScore(request, stock, w.location);
  const bedrooms = bedroomsScore(request, stock, w.bedrooms);
  const propertyType = propertyTypeScore(request, stock, w.propertyType);
  const budget = budgetScore(request, stock, w.budget, config);
  const furnishing = furnishingScore(request, stock, w.furnishing);
  const total = location + bedrooms + propertyType + budget + furnishing;

  return {
    location,
    bedrooms,
    propertyType,
    budget,
    furnishing,
    total: Math.min(100, Math.max(0, total)),
  };
}

function classifyScore(total, config) {
  if (total >= config.matchStrongScore) return 'STRONG_MATCH';
  if (total >= config.matchMinScore) return 'MATCH';
  return 'NO_MATCH';
}

module.exports = {
  computeScore,
  classifyScore,
  sameKey,
  isBudgetWithinTolerance,
  isBedroomsAcceptable,
  isPropertyTypeAcceptable,
};
