'use strict';

const { resolveLocationLevel, hasMinimumSpecificity } = require('./location');
const { buildCandidateQuery, buildLocationExistsQuery } = require('./candidate-query');
const { evaluateHardFilters } = require('./hard-filters');
const { computeRankingScore } = require('./scoring');
const { detectUnresolvedSpecificLocationHint } = require('./unresolved-location');

const REASON_PRIORITY = ['transactionType', 'propertyType', 'bedrooms', 'budget', 'bathrooms', 'sizeSqft', 'plotSizeSqft', 'furnishing'];
const REASON_CODE_BY_FILTER = {
  transactionType: 'transaction_mismatch',
  propertyType: 'property_type_mismatch',
  bedrooms: 'bedrooms_mismatch',
  budget: 'over_budget',
  bathrooms: 'bathrooms_mismatch',
  sizeSqft: 'size_mismatch',
  plotSizeSqft: 'plot_size_mismatch',
  furnishing: 'furnishing_mismatch',
};
const NO_STOCK_REASON_BY_LEVEL = {
  building: 'no_stock_in_building',
  project: 'no_stock_in_project',
  area: 'no_stock_in_area',
};

function sortCandidates(a, b) {
  if (b.score.total !== a.score.total) return b.score.total - a.score.total;
  return String(a.stock.stock_id).localeCompare(String(b.stock.stock_id));
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

// Picks the single most-explanatory no_match_reason when a location has
// stock but nothing survives every hard filter -- the filter blocking the
// most location-scoped candidates, in a fixed priority order on ties.
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

// Orchestrates the deterministic FILTER FIRST / RANK SECOND pipeline
// (TZ 34) against a validated StructuredRequest. `fetchCandidates(sql,
// params)` and `checkLocationExists(sql, params)` are injected async
// functions so this module never imports `pg` directly -- unit tests pass
// in-memory fakes, the real service wires them to stockRepository (TZ 32:
// "Core не знает про OpenAI, Telegram, WhatsApp, n8n, Joker" -- extended
// here to "doesn't know about Postgres either," it only knows how to ask
// for rows and be handed them).
async function matchRequest({ structuredRequest, resolution, config, fetchCandidates, checkLocationExists, originalText = null }) {
  const locationInfo = resolveLocationLevel(structuredRequest, resolution);
  // Diagnostics carried on every return below regardless of outcome (spec
  // sections 10-27): which location option(s) were named, which resolved,
  // which didn't -- never silently dropped, even when matching proceeds on
  // a resolved subset (final principle 5: multiple areas are OR conditions,
  // not a reason to discard the lead).
  const locationDiagnostics = {
    level: locationInfo.level,
    requested: locationInfo.values || [],
    resolved: locationInfo.resolved ? (locationInfo.values || []) : [],
    unresolved: locationInfo.unresolvedOptions || [],
    partial: Boolean(locationInfo.partial),
  };

  if (!locationInfo.provided) {
    // Genuinely no location named at all -- a real buyer with insufficient
    // criteria, NOT the same as a named-but-unrecognized location (spec
    // section 17-18: must not conflate "no location stated" with
    // "location stated but not found").
    return { status: 'INSUFFICIENT_CRITERIA', noMatchReason: 'location_unspecified', matches: [], candidatesCount: 0, locationDiagnostics };
  }
  if (!hasMinimumSpecificity(structuredRequest, locationInfo)) {
    return { status: 'INSUFFICIENT_CRITERIA', noMatchReason: 'insufficient_criteria', matches: [], candidatesCount: 0 };
  }

  // P0.2 release blocker: a more-specific project/building explicitly
  // present in the text but never resolved must NEVER silently broaden
  // into an area-wide match. Only applies when location resolved down to
  // 'area' (a resolved/attempted building or project is already the most
  // specific level there is, nothing to have lost) and only when the raw
  // text is available (the /v1/match direct-StructuredRequest path has no
  // original_text to scan and is unaffected).
  if (locationInfo.level === 'area' && originalText && detectUnresolvedSpecificLocationHint(originalText, locationInfo.value)) {
    return { status: 'NO_MATCH', noMatchReason: 'unresolved_specific_location', matches: [], candidatesCount: 0 };
  }

  // TZ 46-47: an unresolved specific name never falls back to a broader
  // pool. It either textually exists in our stock data (proceed) or it
  // doesn't (NO_MATCH, no candidate query is ever run for it). For
  // multi-area, `locationInfo.values` here is every RAW option (see
  // location.js: this branch only runs when `resolved` is false, which
  // location.js only reports when NONE of the named options resolved) --
  // spec section 17: "if ALL named locations are unresolved, the reason is
  // location_not_found", checked across every one of them, not just one.
  if (!locationInfo.resolved) {
    const existsQuery = buildLocationExistsQuery({ level: locationInfo.level, value: locationInfo.value, values: locationInfo.values });
    const exists = await checkLocationExists(existsQuery.sql, existsQuery.params);
    if (!exists) {
      return { status: 'NO_MATCH', noMatchReason: 'location_not_found', matches: [], candidatesCount: 0, locationDiagnostics };
    }
  }

  const fullQuery = buildCandidateQuery({
    structuredRequest,
    locationLevel: locationInfo.level,
    locationValue: locationInfo.value,
    locationValues: locationInfo.values,
    config,
  });
  const fullCandidates = await fetchCandidates(fullQuery.sql, fullQuery.params);

  // Defense-in-depth: re-validate every SQL-returned row against the exact
  // same pure predicates before ranking (TZ 11) -- guards against any
  // SQL/JS normalization mismatch rather than trusting the query blindly.
  const validated = fullCandidates
    .map((stock) => ({ stock, ...evaluateHardFilters(structuredRequest, stock, { locationLevel: locationInfo.level, locationValue: locationInfo.value, locationValues: locationInfo.values, config }) }))
    .filter((entry) => entry.passed);

  if (validated.length > 0) {
    return {
      status: 'MATCH',
      noMatchReason: null,
      matches: rankSurvivors(validated, { structuredRequest, locationLevel: locationInfo.level }),
      candidatesCount: fullCandidates.length,
      locationDiagnostics,
    };
  }

  // Nothing survived the fully-filtered query -- find out why, scoped to
  // the SAME resolved location(s) only (never a broader area/citywide pool
  // -- this is the guarantee behind TZ 43/96, extended to "never the
  // unresolved options either" for multi-area).
  const locationOnlyQuery = buildCandidateQuery({
    structuredRequest: {
      transaction_type: null, property_type: null, budget_min: null, budget_max: null,
      bedrooms_min: null, bedrooms_max: null, bathrooms_min: null, bathrooms_max: null,
      size_sqft_min: null, size_sqft_max: null, plot_size_sqft_min: null, plot_size_sqft_max: null,
      furnishing: null,
    },
    locationLevel: locationInfo.level,
    locationValue: locationInfo.value,
    locationValues: locationInfo.values,
    config,
  });
  const locationCandidates = await fetchCandidates(locationOnlyQuery.sql, locationOnlyQuery.params);

  if (locationCandidates.length === 0) {
    // Spec sections 10-17: when some named areas resolved and some didn't,
    // a zero-stock result on the resolved subset is a materially different
    // (weaker) claim than "we checked the full picture and there's no
    // stock" -- part of the buyer's named locations were never checked at
    // all. Only label it the plain no-stock reason when every named option
    // was actually resolved and checked.
    const reason = locationInfo.partial ? 'partial_location_resolution_no_match' : NO_STOCK_REASON_BY_LEVEL[locationInfo.level];
    return { status: 'NO_MATCH', noMatchReason: reason, matches: [], candidatesCount: 0, locationDiagnostics };
  }

  const noMatchReason = diagnoseNoMatchReason(locationCandidates, { structuredRequest, locationLevel: locationInfo.level, locationValue: locationInfo.value, locationValues: locationInfo.values, config });
  return { status: 'NO_MATCH', noMatchReason, matches: [], candidatesCount: locationCandidates.length, locationDiagnostics };
}

module.exports = { matchRequest, diagnoseNoMatchReason };
