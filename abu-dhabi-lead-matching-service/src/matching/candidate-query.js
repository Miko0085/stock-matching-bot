'use strict';

const { compatibleStockTransactionTypes, priceFieldForRequest } = require('./transaction-semantics');

// Builds the parameterized SQL WHERE clause that pushes hard filters down
// into PostgreSQL (TZ 11, 35, 100) instead of the old anti-pattern of
// loading the entire ACTIVE stock table and filtering it in Node on every
// request. Pure function -- returns {sql, params}, executes nothing --
// so it stays unit-testable without a database (TZ 11's "testable as pure
// logic" requirement applies to the query SHAPE, not just the filters).
//
// Only the resolved location LEVEL is filtered here (building XOR project
// XOR area, never more than one) -- this is the SQL-level guarantee behind
// the "wrong building must never enter the candidate pool" regression
// (TZ 43, 96): a stock row in a different building/area is excluded by the
// query itself, before any scoring code ever sees it.
//
// This SQL narrowing is a performance optimization, not the source of
// truth -- every row it returns is still re-validated against the exact
// same rules by hard-filters.js (pure JS) before ranking, as a
// defense-in-depth safety net against any SQL/JS normalization mismatch.
function buildCandidateQuery({ structuredRequest, locationLevel, locationValue, locationValues, config }) {
  const conditions = [`status = 'ACTIVE'`];
  const params = [];

  function addParam(value) {
    params.push(value);
    return `$${params.length}`;
  }

  // P0 release blocker: stock stores rentals as `transaction_type =
  // 'RENT_YEARLY'`, not the request's own 'RENT' value -- a bare equality
  // here excluded every RENT_YEARLY row from a RENT request's candidate
  // pool before hard-filters.js ever saw it. Same shared helper as the JS
  // defense-in-depth layer so SQL and JS can never disagree.
  if (structuredRequest.transaction_type) {
    const compatible = compatibleStockTransactionTypes(structuredRequest.transaction_type);
    if (!compatible || compatible.length === 0) {
      conditions.push('1 = 0'); // unrecognized request value -> no candidates can be confirmed compatible
    } else if (compatible.length === 1) {
      conditions.push(`transaction_type = ${addParam(compatible[0])}`);
    } else {
      const placeholders = compatible.map((value) => addParam(value));
      conditions.push(`transaction_type IN (${placeholders.join(', ')})`);
    }
  }

  if (locationLevel === 'building') {
    conditions.push(`lower(building) = lower(${addParam(locationValue)})`);
  } else if (locationLevel === 'project') {
    conditions.push(`lower(project_community) = lower(${addParam(locationValue)})`);
  } else if (locationLevel === 'area') {
    // Multi-area OR semantics (spec sections 10-17): several acceptable
    // areas are OR'd against each other, still AND'd with every other
    // condition. Single-area callers (locationValues absent/length 1) get
    // the exact same `lower(area) = lower($n)` shape as before.
    const areaValues = Array.isArray(locationValues) && locationValues.length > 0 ? locationValues : [locationValue];
    if (areaValues.length === 1) {
      conditions.push(`lower(area) = lower(${addParam(areaValues[0])})`);
    } else {
      const placeholders = areaValues.map((value) => `lower(${addParam(value)})`);
      conditions.push(`lower(area) = ANY(ARRAY[${placeholders.join(', ')}])`);
    }
  }

  if (structuredRequest.property_type) {
    conditions.push(`lower(property_type) = lower(${addParam(structuredRequest.property_type)})`);
  }

  // P0 release blocker: RENT stock prices through `annual_rent`, not
  // `selling_price` (NULL on every RENT_YEARLY row) -- same shared helper
  // as hard-filters.js. `priceField` is a fixed column name from a
  // hardcoded map (never request input), so interpolating it is safe.
  const priceField = priceFieldForRequest(structuredRequest.transaction_type);
  const tolerance = config.matchPriceTolerancePct / 100;
  if (structuredRequest.budget_max !== null && structuredRequest.budget_max !== undefined) {
    conditions.push(`${priceField} <= ${addParam(structuredRequest.budget_max * (1 + tolerance))}`);
  }
  if (structuredRequest.budget_min !== null && structuredRequest.budget_min !== undefined) {
    // No tolerance discount on the floor (TZ 50-51) -- strict >=.
    conditions.push(`${priceField} >= ${addParam(structuredRequest.budget_min)}`);
  }

  if (structuredRequest.bedrooms_min !== null && structuredRequest.bedrooms_min !== undefined) {
    conditions.push(`bedrooms >= ${addParam(structuredRequest.bedrooms_min)}`);
  }
  if (structuredRequest.bedrooms_max !== null && structuredRequest.bedrooms_max !== undefined) {
    conditions.push(`bedrooms <= ${addParam(structuredRequest.bedrooms_max)}`);
  }

  if (structuredRequest.bathrooms_min !== null && structuredRequest.bathrooms_min !== undefined) {
    conditions.push(`bathrooms >= ${addParam(structuredRequest.bathrooms_min)}`);
  }
  if (structuredRequest.bathrooms_max !== null && structuredRequest.bathrooms_max !== undefined) {
    conditions.push(`bathrooms <= ${addParam(structuredRequest.bathrooms_max)}`);
  }

  if (structuredRequest.size_sqft_min !== null && structuredRequest.size_sqft_min !== undefined) {
    conditions.push(`size_sqft >= ${addParam(structuredRequest.size_sqft_min)}`);
  }
  if (structuredRequest.size_sqft_max !== null && structuredRequest.size_sqft_max !== undefined) {
    conditions.push(`size_sqft <= ${addParam(structuredRequest.size_sqft_max)}`);
  }

  if (structuredRequest.plot_size_sqft_min !== null && structuredRequest.plot_size_sqft_min !== undefined) {
    conditions.push(`plot_size_sqft >= ${addParam(structuredRequest.plot_size_sqft_min)}`);
  }
  if (structuredRequest.plot_size_sqft_max !== null && structuredRequest.plot_size_sqft_max !== undefined) {
    conditions.push(`plot_size_sqft <= ${addParam(structuredRequest.plot_size_sqft_max)}`);
  }

  if (structuredRequest.furnishing) {
    conditions.push(`lower(furnishing) = lower(${addParam(structuredRequest.furnishing)})`);
  }

  const sql = `SELECT * FROM matching_abu_dhabi.stock_inventory WHERE ${conditions.join(' AND ')}`;
  return { sql, params };
}

// A separate, minimal existence check (TZ 46-47) -- used only when the
// alias table did not resolve a stated building/project/area name, to
// distinguish "we don't recognize this name at all" (location_not_found)
// from "recognized, but nothing currently active matches" (no_stock_in_*).
// Deliberately ignores status/transaction_type/price/bedrooms -- it only
// asks "does this name exist anywhere in our stock data at all."
function buildLocationExistsQuery({ level, value, values }) {
  const column = level === 'project' ? 'project_community' : level;
  const list = Array.isArray(values) && values.length > 0 ? values : [value];
  if (list.length === 1) {
    return { sql: `SELECT 1 FROM matching_abu_dhabi.stock_inventory WHERE lower(${column}) = lower($1) LIMIT 1`, params: list };
  }
  const placeholders = list.map((_, index) => `lower($${index + 1})`).join(', ');
  return { sql: `SELECT 1 FROM matching_abu_dhabi.stock_inventory WHERE lower(${column}) = ANY(ARRAY[${placeholders}]) LIMIT 1`, params: list };
}

module.exports = { buildCandidateQuery, buildLocationExistsQuery };
