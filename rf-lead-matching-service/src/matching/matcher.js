'use strict';

const { resolveLocationLevel, hasMinimumSpecificity } = require('./location');
const { buildCandidateQuery, buildLocationExistsQuery } = require('./candidate-query');
const { evaluateHardFilters } = require('./hard-filters');
const { computeRankingScore } = require('./scoring');

// Moscow's matcher -- BY ANALOGY with lead-matching-service/src/matching/
// matcher.js's FILTER FIRST / RANK SECOND orchestration, MATCH/NO_MATCH
// only (no STRONG_MATCH tier, per the user's own decision to mirror UAE's
// real shipped behavior rather than the undocumented-in-code AGENTS.md
// threshold design).
const REASON_PRIORITY = ['dealType', 'propertyType', 'rooms', 'bedrooms', 'area', 'floor', 'price', 'readiness'];
const REASON_CODE_BY_FILTER = {
  dealType: 'transaction_mismatch',
  propertyType: 'property_type_mismatch',
  rooms: 'rooms_mismatch',
  bedrooms: 'bedrooms_mismatch',
  area: 'area_mismatch',
  floor: 'floor_mismatch',
  price: 'all_candidates_over_budget',
  readiness: 'readiness_mismatch',
};
const NO_STOCK_REASON_BY_LEVEL = {
  complex: 'no_stock_in_complex',
  district: 'no_stock_in_district',
};

function sortCandidates(a, b) {
  if (b.score.total !== a.score.total) return b.score.total - a.score.total;
  return Number(a.stock.joker_object_id) - Number(b.stock.joker_object_id);
}

function rankSurvivors(survivors, { structuredRequest, locationLevel }) {
  return survivors
    .map(({ stock, filters }) => ({
      stock,
      score: computeRankingScore({ request: structuredRequest, stock, filters, locationLevel }),
    }))
    .sort(sortCandidates)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function diagnoseNoMatchReason(locationCandidates, ctx) {
  const failureCounts = {};
  for (const filterKey of REASON_PRIORITY) failureCounts[filterKey] = 0;

  for (const stock of locationCandidates) {
    const { filters } = evaluateHardFilters(ctx.structuredRequest, stock, ctx);
    for (const filterKey of REASON_PRIORITY) {
      if (filters[filterKey].active && !filters[filterKey].passes) failureCounts[filterKey] += 1;
    }
  }

  let winner = null;
  for (const filterKey of REASON_PRIORITY) {
    if (failureCounts[filterKey] > 0 && (!winner || failureCounts[filterKey] > failureCounts[winner])) {
      winner = filterKey;
    }
  }

  return winner ? REASON_CODE_BY_FILTER[winner] : 'no_candidates';
}

// `fetchCandidates`/`checkLocationExists` are injected async functions
// (same DI convention as UAE's matcher.js) so this module never imports
// `pg` directly.
async function matchRequest({ structuredRequest, resolution, settings, fetchCandidates, checkLocationExists }) {
  const locationInfo = resolveLocationLevel(structuredRequest, resolution);

  if (!locationInfo.provided) {
    return { status: 'INSUFFICIENT_CRITERIA', noMatchReason: 'location_unspecified', matches: [], candidatesCount: 0 };
  }
  if (!hasMinimumSpecificity(structuredRequest, locationInfo)) {
    return { status: 'INSUFFICIENT_CRITERIA', noMatchReason: 'insufficient_criteria', matches: [], candidatesCount: 0 };
  }

  if (!locationInfo.resolved) {
    const existsQuery = buildLocationExistsQuery({ level: locationInfo.level, value: locationInfo.value });
    const exists = await checkLocationExists(existsQuery.sql, existsQuery.params);
    if (!exists) {
      return { status: 'NO_MATCH', noMatchReason: 'location_not_found', matches: [], candidatesCount: 0 };
    }
  }

  const fullQuery = buildCandidateQuery({
    structuredRequest,
    locationLevel: locationInfo.level,
    locationValue: locationInfo.value,
    settings,
  });
  const fullCandidates = await fetchCandidates(fullQuery.sql, fullQuery.params);

  // Defense-in-depth: re-validate every SQL-returned row against the exact
  // same pure predicates before ranking (mirrors UAE's matcher.js).
  const validated = fullCandidates
    .map((stock) => ({ stock, ...evaluateHardFilters(structuredRequest, stock, { locationLevel: locationInfo.level, locationValue: locationInfo.value, settings }) }))
    .filter((entry) => entry.passed);

  if (validated.length > 0) {
    return {
      status: 'MATCH',
      noMatchReason: null,
      matches: rankSurvivors(validated, { structuredRequest, locationLevel: locationInfo.level }),
      candidatesCount: fullCandidates.length,
    };
  }

  // Nothing survived the fully-filtered query -- find out why, scoped to
  // the SAME resolved location only (never a broader/citywide pool).
  const locationOnlyQuery = buildCandidateQuery({
    structuredRequest: {
      transaction_type: null, property_type: null, rooms: null, rooms_sentinel: null,
      bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: null,
      area_sqm_min: null, area_sqm_max: null, floor_min: null, floor_max: null,
      readiness_year: null,
    },
    locationLevel: locationInfo.level,
    locationValue: locationInfo.value,
    settings,
  });
  const locationCandidates = await fetchCandidates(locationOnlyQuery.sql, locationOnlyQuery.params);

  if (locationCandidates.length === 0) {
    return { status: 'NO_MATCH', noMatchReason: NO_STOCK_REASON_BY_LEVEL[locationInfo.level], matches: [], candidatesCount: 0 };
  }

  const noMatchReason = diagnoseNoMatchReason(locationCandidates, { structuredRequest, locationLevel: locationInfo.level, locationValue: locationInfo.value, settings });
  return { status: 'NO_MATCH', noMatchReason, matches: [], candidatesCount: locationCandidates.length };
}

module.exports = { matchRequest, diagnoseNoMatchReason };
