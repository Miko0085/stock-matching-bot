'use strict';

// Moscow's location hierarchy -- BY ANALOGY with lead-matching-service/
// src/matching/location.js's building>project>area resolution (use the
// MOST specific level stated, never fall back to a broader pool), but
// only TWO tiers: `complex` (ЖК, most specific) > `district` (Округ/
// Район). Unlike UAE, there is no third "citywide" tier here -- every row
// in matching_moscow.stock_inventory is already strict-scoped to the city
// of Москва (ADR-035), so "Москва" itself is a constant, not a real
// distinguishing filter the way UAE's named neighborhoods ("area") are.
// A buyer who names neither a complex nor a district is exactly as
// under-specified as a UAE buyer who names no area at all.
function resolveLocationLevel(structuredRequest, resolution) {
  if (structuredRequest.complex) {
    return {
      level: 'complex',
      value: structuredRequest.complex,
      provided: true,
      resolved: resolution.complexResolved,
    };
  }
  if (structuredRequest.district) {
    return {
      level: 'district',
      value: structuredRequest.district,
      provided: true,
      resolved: resolution.districtResolved,
    };
  }
  return { level: null, value: null, provided: false, resolved: false };
}

// Mirrors UAE's hasMinimumSpecificity: automatic matching requires
// location + at least one of price/rooms/property_type -- location alone
// would otherwise match every active listing in the resolved
// district/complex.
function hasMinimumSpecificity(structuredRequest, locationInfo) {
  if (!locationInfo.provided) return false;
  const hasPrice = structuredRequest.budget_min !== null || structuredRequest.budget_max !== null;
  const hasRooms = structuredRequest.rooms !== null || structuredRequest.rooms_sentinel !== null;
  const hasPropertyType = Boolean(structuredRequest.property_type);
  return hasPrice || hasRooms || hasPropertyType;
}

module.exports = { resolveLocationLevel, hasMinimumSpecificity };
