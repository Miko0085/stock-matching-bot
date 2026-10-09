'use strict';

// Moscow's candidate query -- BY ANALOGY with lead-matching-service/src/
// matching/candidate-query.js's "push filters down into SQL" discipline
// (pure function, {sql, params} out, no DB access), pushed against
// matching_moscow.stock_inventory's real columns instead of UAE's. Every
// condition is ALSO gated by its `joker_*_enabled` setting (matches
// hard-filters.js exactly, so SQL and JS can never disagree on what's
// "active") -- an operator-disabled criterion is never pushed into the
// WHERE clause. `available = true` replaces UAE's `status = 'ACTIVE'`
// (this schema's own availability flag, set by joker-stock-sync.js's
// safe-deactivation).
function isCriterionEnabled(settings, key) {
  return settings[key]?.value === true;
}

function buildCandidateQuery({ structuredRequest, locationLevel, locationValue, settings }) {
  const conditions = [`available = true`, `property_type_excluded = false`];
  const params = [];

  function addParam(value) {
    params.push(value);
    return `$${params.length}`;
  }

  // Deal type (buy/rent) is structural, never gated by a toggle -- same as
  // hard-filters.js's dealTypeFilter.
  if (structuredRequest.transaction_type) {
    const wantsSale = structuredRequest.transaction_type === 'SALE';
    conditions.push(`lower(deal_type) = ${addParam(wantsSale ? 'sale' : 'rent')}`);
  }

  if (locationLevel === 'complex') {
    conditions.push(`lower(complex) = lower(${addParam(locationValue)})`);
  } else if (locationLevel === 'district') {
    conditions.push(`lower(district) = lower(${addParam(locationValue)})`);
  }

  if (isCriterionEnabled(settings, 'joker_property_type_enabled') && structuredRequest.property_type) {
    conditions.push(`lower(property_type) = lower(${addParam(structuredRequest.property_type)})`);
  }

  if (isCriterionEnabled(settings, 'joker_rooms_enabled')) {
    if (structuredRequest.rooms_sentinel) {
      conditions.push(`rooms_sentinel = ${addParam(structuredRequest.rooms_sentinel)}`);
    } else if (structuredRequest.rooms !== null && structuredRequest.rooms !== undefined) {
      conditions.push(`rooms = ${addParam(structuredRequest.rooms)}`);
    }
  }

  // Bedrooms is NOT pushed into SQL as a blocking condition -- see
  // hard-filters.js's bedroomsFilter comment: ~96% of real stock has no
  // bedrooms value, so a SQL `bedrooms >= n` would silently exclude almost
  // everything. It stays a JS-only, graceful-skip-on-null check instead.

  if (isCriterionEnabled(settings, 'joker_area_enabled')) {
    if (structuredRequest.area_sqm_min !== null && structuredRequest.area_sqm_min !== undefined) {
      conditions.push(`area_sqm >= ${addParam(structuredRequest.area_sqm_min)}`);
    }
    if (structuredRequest.area_sqm_max !== null && structuredRequest.area_sqm_max !== undefined) {
      conditions.push(`area_sqm <= ${addParam(structuredRequest.area_sqm_max)}`);
    }
  }

  if (isCriterionEnabled(settings, 'joker_floor_enabled')) {
    if (structuredRequest.floor_min !== null && structuredRequest.floor_min !== undefined) {
      conditions.push(`floor >= ${addParam(structuredRequest.floor_min)}`);
    }
    if (structuredRequest.floor_max !== null && structuredRequest.floor_max !== undefined) {
      conditions.push(`floor <= ${addParam(structuredRequest.floor_max)}`);
    }
  }

  if (isCriterionEnabled(settings, 'joker_price_enabled')) {
    const tolerance = (settings.joker_price_tolerance_pct?.value ?? 10) / 100;
    if (structuredRequest.budget_max !== null && structuredRequest.budget_max !== undefined) {
      conditions.push(`price <= ${addParam(structuredRequest.budget_max * (1 + tolerance))}`);
    }
    if (structuredRequest.budget_min !== null && structuredRequest.budget_min !== undefined) {
      conditions.push(`price >= ${addParam(structuredRequest.budget_min)}`);
    }
  }

  if (isCriterionEnabled(settings, 'joker_readiness_enabled') && structuredRequest.readiness_year !== null && structuredRequest.readiness_year !== undefined) {
    conditions.push(`readiness_year <= ${addParam(structuredRequest.readiness_year)}`);
  }

  const sql = `SELECT * FROM matching_moscow.stock_inventory WHERE ${conditions.join(' AND ')}`;
  return { sql, params };
}

// Existence check (mirrors UAE's buildLocationExistsQuery) -- used only
// when the alias table did not resolve a stated district/complex name, to
// distinguish "unrecognized name" from "recognized, but nothing currently
// active matches."
function buildLocationExistsQuery({ level, value }) {
  return {
    sql: `SELECT 1 FROM matching_moscow.stock_inventory WHERE available = true AND lower(${level}) = lower($1) LIMIT 1`,
    params: [value],
  };
}

module.exports = { buildCandidateQuery, buildLocationExistsQuery };
