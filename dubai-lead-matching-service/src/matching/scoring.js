'use strict';

// Ranking-only scoring (TZ 34, 56-63). By the time this runs, `filters` has
// already been evaluated by hard-filters.js and the candidate has SURVIVED
// every active filter -- score here can only ever choose an ORDER among
// already-admissible candidates, never decide admissibility. A criterion
// the request never stated is excluded from the weighted average entirely
// (TZ 58-59), not scored as full or zero.
const WEIGHTS = {
  location: 50,
  budget: 30,
  bedrooms: 15,
  propertyType: 5,
};

function locationScore(locationLevel) {
  if (locationLevel === 'building') return 100;
  if (locationLevel === 'project') return 95;
  if (locationLevel === 'area') return 80;
  return null;
}

function budgetScore(request, stock) {
  const { budget_max: max } = request;
  const price = Number(stock.selling_price);
  if (max === null || max === undefined) return 100; // floor-only already passed the hard filter
  if (price <= max) return 100;
  const overPct = ((price - max) / max) * 100;
  if (overPct <= 5) return 75;
  return 50; // 5-10%; >10% was already hard-filtered out
}

// `filters` is the per-criterion { active, passes } map from
// evaluateHardFilters -- this function assumes the candidate already
// passed all of them (only survivors are ever scored).
function computeRankingScore({ request, stock, filters, locationLevel }) {
  const components = {};

  if (filters.location.active) components.location = { weight: WEIGHTS.location, score: locationScore(locationLevel) };
  if (filters.budget.active) components.budget = { weight: WEIGHTS.budget, score: budgetScore(request, stock) };
  if (filters.bedrooms.active) components.bedrooms = { weight: WEIGHTS.bedrooms, score: 100 };
  if (filters.propertyType.active) components.propertyType = { weight: WEIGHTS.propertyType, score: 100 };

  const totalWeight = Object.values(components).reduce((sum, c) => sum + c.weight, 0);
  const weightedSum = Object.values(components).reduce((sum, c) => sum + c.weight * c.score, 0);

  // Location is always active (matching never runs without it -- TZ 48),
  // so totalWeight is never 0 in practice; guarded anyway for safety.
  const total = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  return { total, components };
}

module.exports = { WEIGHTS, locationScore, budgetScore, computeRankingScore };
