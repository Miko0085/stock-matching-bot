'use strict';

// Moscow's ranking score -- BY ANALOGY with dubai-lead-matching-service/src/
// matching/scoring.js's exact total (100) and "only ACTIVE criteria count
// toward the weighted average" mechanism, re-expressed over Moscow's own
// 4 scored dimensions (location/price/rooms/property_type, mirroring
// Dubai's location/budget/bedrooms/propertyType 1:1). DECIDED and LIVE
// since ADR-038 (2026-09-29, see docs/DECISIONS.md) -- this weight model
// is no longer provisional, despite docs/PER_MARKET_SERVICE_INDEPENDENCE_
// PLAN.md section 5.2 (an explicitly historical snapshot, never rewritten)
// still describing it as undecided. Unlike Dubai's hardcoded-always-active
// literals, "active" here also depends on the operator's own
// `joker_*_enabled` toggle (evaluated by hard-filters.js and passed in via
// `filters`), so /settings?market=moscow's criteria toggles are genuinely
// load-bearing, not decorative.
const WEIGHTS = {
  location: 50,
  price: 30,
  rooms: 15,
  propertyType: 5,
};

function locationScore(locationLevel) {
  if (locationLevel === 'complex') return 100;
  if (locationLevel === 'district') return 85;
  return null;
}

function priceScore(request, stock) {
  const { budget_max: max } = request;
  const price = Number(stock.price);
  if (max === null || max === undefined) return 100; // floor-only already passed the hard filter
  if (price <= max) return 100;
  const overPct = ((price - max) / max) * 100;
  if (overPct <= 5) return 75;
  return 50; // 5-10%; >10% was already hard-filtered out
}

// `filters` is the per-criterion { active, passes } map from
// evaluateHardFilters -- only survivors are ever scored, so `rooms`/
// `propertyType` being active here always means "already matched exactly."
function computeRankingScore({ request, stock, filters, locationLevel }) {
  const components = {};

  if (filters.location.active) components.location = { weight: WEIGHTS.location, score: locationScore(locationLevel) };
  if (filters.price.active) components.price = { weight: WEIGHTS.price, score: priceScore(request, stock) };
  if (filters.rooms.active) components.rooms = { weight: WEIGHTS.rooms, score: 100 };
  if (filters.propertyType.active) components.propertyType = { weight: WEIGHTS.propertyType, score: 100 };

  const totalWeight = Object.values(components).reduce((sum, c) => sum + c.weight, 0);
  const weightedSum = Object.values(components).reduce((sum, c) => sum + c.weight * c.score, 0);

  // Location is always active (matching never runs without it, same as
  // UAE), so totalWeight is never 0 in practice; guarded anyway.
  const total = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  return { total, components };
}

module.exports = { WEIGHTS, locationScore, priceScore, computeRankingScore };
