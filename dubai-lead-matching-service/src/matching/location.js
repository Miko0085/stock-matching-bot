'use strict';

// Location hierarchy resolution (TZ 39-43): use the MOST specific level
// stated, and only that level -- never fall back to a broader pool. This
// is what makes the "The Edge" regression structurally impossible: if
// building is stated, the candidate pool is restricted to that exact
// building at the SQL level (candidate-query.js) -- a different building
// in a different area can never enter the pool at all, regardless of how
// well it scores on price/bedrooms/type (TZ 43, 96).
// Multi-area support (spec sections 10-17): a buyer may name several
// acceptable areas ("A/B/C", "A or B") -- these are OR conditions, never a
// reason to discard the lead (final principle 5). `resolution.areaOptions`,
// when present, is the new canonical per-option resolution list built by
// buildStructuredRequest() -- `[{ raw, canonical, resolved, ... }]`, one
// entry per named area, each resolved INDEPENDENTLY through the location
// dictionary. Building/project stay single-value (a buyer naming several
// specific buildings is not a case this pass handles -- area is the level
// where "several acceptable options" is a real, observed pattern).
//
// `values` is always an array (the new internal shape); `value` is kept as
// the single first value for every existing single-location caller (a
// direct /v1/match StructuredRequest input that never populates
// `areaOptions`, and every pre-existing test in this file/matcher.test.js).
function resolveAreaLevel(structuredRequest, resolution) {
  const areaOptions = resolution.areaOptions;
  if (Array.isArray(areaOptions) && areaOptions.length > 0) {
    const resolved = areaOptions.filter((o) => o.resolved);
    const unresolved = areaOptions.filter((o) => !o.resolved);

    if (resolved.length > 0) {
      return {
        level: 'area',
        value: resolved[0].canonical,
        values: resolved.map((o) => o.canonical),
        provided: true,
        resolved: true,
        partial: unresolved.length > 0,
        unresolvedOptions: unresolved.map((o) => o.raw),
      };
    }

    // No named area resolved at all -- still "provided" (the buyer DID name
    // location(s)), just not recognized. The existence check downstream
    // must consider every raw option, not only the first (spec section 17:
    // "if ALL named locations are unresolved, the reason is
    // location_not_found", covering every option, not a subset).
    return {
      level: 'area',
      value: areaOptions[0].raw,
      values: areaOptions.map((o) => o.raw),
      provided: true,
      resolved: false,
      partial: false,
      unresolvedOptions: areaOptions.map((o) => o.raw),
    };
  }

  // Legacy single-area shape (no areaOptions provided at all) -- unchanged
  // behavior for the manual /v1/match StructuredRequest path and every
  // pre-existing caller of this module.
  if (structuredRequest.area) {
    return {
      level: 'area',
      value: structuredRequest.area,
      values: [structuredRequest.area],
      provided: true,
      resolved: resolution.areaResolved,
      partial: false,
      unresolvedOptions: [],
    };
  }

  return null;
}

function resolveLocationLevel(structuredRequest, resolution) {
  if (structuredRequest.building) {
    return {
      level: 'building',
      value: structuredRequest.building,
      values: [structuredRequest.building],
      provided: true,
      resolved: resolution.buildingResolved,
      partial: false,
      unresolvedOptions: [],
    };
  }
  if (structuredRequest.project) {
    return {
      level: 'project',
      value: structuredRequest.project,
      values: [structuredRequest.project],
      provided: true,
      resolved: resolution.projectResolved,
      partial: false,
      unresolvedOptions: [],
    };
  }
  const areaLevel = resolveAreaLevel(structuredRequest, resolution);
  if (areaLevel) return areaLevel;

  return { level: null, value: null, values: [], provided: false, resolved: false, partial: false, unresolvedOptions: [] };
}

// TZ 48-49: automatic matching requires Location + at least one of
// budget/bedrooms/property_type. Location alone is never enough (an
// area-only request would otherwise match the entire area's stock).
function hasMinimumSpecificity(structuredRequest, locationInfo) {
  if (!locationInfo.provided) return false;
  const hasBudget = structuredRequest.budget_min !== null || structuredRequest.budget_max !== null;
  const hasBedrooms = structuredRequest.bedrooms_min !== null || structuredRequest.bedrooms_max !== null;
  const hasPropertyType = Boolean(structuredRequest.property_type);
  return hasBudget || hasBedrooms || hasPropertyType;
}

module.exports = { resolveLocationLevel, hasMinimumSpecificity };
