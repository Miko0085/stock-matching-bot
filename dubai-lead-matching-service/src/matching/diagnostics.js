'use strict';

const { compatibleStockTransactionTypes, priceFieldForRequest } = require('./transaction-semantics');

// match_diagnostics (spec sections 20-27): a nullable, additive JSONB
// column on matching_dubai.match_runs, populated ONLY for genuine buyer-path
// requests that reach the matcher (pipeline.js only calls this from
// runMatchAndPersist, which itself only runs after the eligibility check --
// REJECT/DUPLICATE/PARSER_ERROR/INSUFFICIENT_CRITERIA-without-a-location
// never pay for this). The hard-filter funnel is computed via ONE
// aggregate query (conditional COUNT(*) FILTER (WHERE ...)), never N
// separate SELECT count(*) calls -- required given real traffic volume
// (>2000 msgs/few hours per the live forensic audit).

const FUNNEL_STAGES = ['transaction', 'property_type', 'bedrooms', 'budget', 'bathrooms', 'size', 'plot_size', 'furnishing'];
const STAGE_COLUMN = {
  transaction: 'after_transaction',
  property_type: 'after_property_type',
  bedrooms: 'after_bedrooms',
  budget: 'after_budget',
  bathrooms: 'after_bathrooms',
  size: 'after_size',
  plot_size: 'after_plot_size',
  furnishing: 'after_furnishing',
};
// Fields where "stock value is NULL" and "stock value is present but
// doesn't satisfy the request" are materially different claims (spec
// sections 23-27) -- distinguished via extra FILTER aggregates in the SAME
// query, never a second round-trip.
const DATA_GAP_FIELDS = ['bedrooms', 'budget', 'bathrooms', 'size', 'plot_size', 'furnishing'];

// Builds { sql: <fragment or null>, valueColumn } for one funnel stage.
// `sql` is null when the request doesn't state that criterion at all (the
// stage is then a no-op -- its cumulative count equals the previous
// stage's, exactly mirroring hard-filters.js's `active: false` = "never
// filters").
function buildStageFragment(stage, structuredRequest, config, addParam) {
  switch (stage) {
    case 'transaction': {
      if (!structuredRequest.transaction_type) return null;
      const compatible = compatibleStockTransactionTypes(structuredRequest.transaction_type);
      if (!compatible || compatible.length === 0) return { sql: '1=0', valueColumn: null };
      if (compatible.length === 1) return { sql: `transaction_type = ${addParam(compatible[0])}`, valueColumn: 'transaction_type' };
      return { sql: `transaction_type = ANY(ARRAY[${compatible.map((v) => addParam(v)).join(', ')}])`, valueColumn: 'transaction_type' };
    }
    case 'property_type': {
      if (!structuredRequest.property_type) return null;
      return { sql: `lower(property_type) = lower(${addParam(structuredRequest.property_type)})`, valueColumn: 'property_type' };
    }
    case 'bedrooms': {
      const { bedrooms_min: min, bedrooms_max: max } = structuredRequest;
      if (min === null && max === null) return null;
      const parts = [];
      if (min !== null) parts.push(`bedrooms >= ${addParam(min)}`);
      if (max !== null) parts.push(`bedrooms <= ${addParam(max)}`);
      return { sql: parts.join(' AND '), valueColumn: 'bedrooms' };
    }
    case 'budget': {
      const { budget_min: min, budget_max: max } = structuredRequest;
      if (min === null && max === null) return null;
      const priceField = priceFieldForRequest(structuredRequest.transaction_type);
      const tolerance = config.matchPriceTolerancePct / 100;
      const parts = [];
      if (max !== null) parts.push(`${priceField} <= ${addParam(max * (1 + tolerance))}`);
      if (min !== null) parts.push(`${priceField} >= ${addParam(min)}`);
      return { sql: parts.join(' AND '), valueColumn: priceField };
    }
    case 'bathrooms': {
      const { bathrooms_min: min, bathrooms_max: max } = structuredRequest;
      if (min === null && max === null) return null;
      const parts = [];
      if (min !== null) parts.push(`bathrooms >= ${addParam(min)}`);
      if (max !== null) parts.push(`bathrooms <= ${addParam(max)}`);
      return { sql: parts.join(' AND '), valueColumn: 'bathrooms' };
    }
    case 'size': {
      const { size_sqft_min: min, size_sqft_max: max } = structuredRequest;
      if (min === null && max === null) return null;
      const parts = [];
      if (min !== null) parts.push(`size_sqft >= ${addParam(min)}`);
      if (max !== null) parts.push(`size_sqft <= ${addParam(max)}`);
      return { sql: parts.join(' AND '), valueColumn: 'size_sqft' };
    }
    case 'plot_size': {
      const { plot_size_sqft_min: min, plot_size_sqft_max: max } = structuredRequest;
      if (min === null && max === null) return null;
      const parts = [];
      if (min !== null) parts.push(`plot_size_sqft >= ${addParam(min)}`);
      if (max !== null) parts.push(`plot_size_sqft <= ${addParam(max)}`);
      return { sql: parts.join(' AND '), valueColumn: 'plot_size_sqft' };
    }
    case 'furnishing': {
      if (!structuredRequest.furnishing) return null;
      return { sql: `lower(furnishing) = lower(${addParam(structuredRequest.furnishing)})`, valueColumn: 'furnishing' };
    }
    default:
      return null;
  }
}

// Builds the location WHERE fragment (mirrors candidate-query.js exactly --
// duplicated here rather than imported because candidate-query.js's
// function also owns non-location conditions this module computes
// differently for the funnel; the location shape itself is simple enough
// that keeping it inline is clearer than threading an extra parameter
// through the shared builder).
function buildLocationFragment(locationLevel, locationValues, addParam) {
  if (!locationLevel) return null;
  const column = locationLevel === 'project' ? 'project_community' : locationLevel;
  const values = locationValues || [];
  if (values.length === 0) return null;
  if (values.length === 1) return `lower(${column}) = lower(${addParam(values[0])})`;
  return `lower(${column}) = ANY(ARRAY[${values.map((v) => `lower(${addParam(v)})`).join(', ')}])`;
}

// Builds the single funnel aggregate query. `locationLevel`/`locationValues`
// must already be the RESOLVED location (never an unresolved raw name --
// this is only ever called once matchRequest has confirmed a real,
// resolved location to scope the funnel against, never a broader pool).
function buildDiagnosticsFunnelQuery({ structuredRequest, locationLevel, locationValues, config }) {
  const params = [];
  function addParam(value) {
    params.push(value);
    return `$${params.length}`;
  }

  const locationFragment = buildLocationFragment(locationLevel, locationValues, addParam);
  const cumulative = locationFragment ? [locationFragment] : [];

  const selects = ['count(*)::int AS after_location'];
  const stageFragments = {};

  for (const stage of FUNNEL_STAGES) {
    const fragment = buildStageFragment(stage, structuredRequest, config, addParam);
    stageFragments[stage] = fragment;
    if (fragment) cumulative.push(fragment.sql);
    const whereClause = cumulative.length ? cumulative.join(' AND ') : 'true';
    selects.push(`count(*) FILTER (WHERE ${whereClause})::int AS ${STAGE_COLUMN[stage]}`);

    // Data-gap columns (spec sections 23-27): computed against the
    // candidate pool BEFORE this stage's own condition is applied, so
    // "missing" and "mismatch" are measured against the same denominator.
    if (fragment && DATA_GAP_FIELDS.includes(stage)) {
      const before = cumulative.slice(0, cumulative.length - 1);
      const beforeClause = before.length ? before.join(' AND ') : 'true';
      selects.push(`count(*) FILTER (WHERE ${beforeClause})::int AS ${stage}_candidates_before`);
      selects.push(`count(*) FILTER (WHERE ${beforeClause} AND ${fragment.valueColumn} IS NULL)::int AS ${stage}_missing_value`);
      selects.push(`count(*) FILTER (WHERE ${beforeClause} AND ${fragment.valueColumn} IS NOT NULL AND NOT (${fragment.sql}))::int AS ${stage}_explicit_mismatch`);
    }
  }

  const whereActive = locationFragment ? `status = 'ACTIVE' AND ${locationFragment}` : `status = 'ACTIVE'`;
  const sql = `SELECT ${selects.join(', ')} FROM matching_dubai.stock_inventory WHERE ${whereActive}`;
  return { sql, params, stageFragments };
}

// Turns the single aggregate row into the documented match_diagnostics
// `stock` + `missing_stock_data` shape. `active` is the CITYWIDE ACTIVE
// stock count (passed in separately, already fetched once elsewhere in the
// pipeline for match_runs.active_stock_count -- never re-queried here);
// `after_location` is its own explicit funnel stage, distinct from
// `active`, exactly matching the documented shape (spec section 20-22).
function buildStockDiagnostics(row, stageFragments, activeStockCount) {
  const stock = { active: activeStockCount, after_location: row.after_location };
  let previous = row.after_location;
  let firstZeroStage = null;
  const missingStockData = {};
  let firstDataGapStage = null;

  for (const stage of FUNNEL_STAGES) {
    const column = STAGE_COLUMN[stage];
    const value = row[column];
    stock[column] = value;
    if (firstZeroStage === null && previous > 0 && value === 0) firstZeroStage = stage;
    previous = value;

    if (stageFragments[stage] && DATA_GAP_FIELDS.includes(stage)) {
      const candidatesBefore = row[`${stage}_candidates_before`];
      const missingValue = row[`${stage}_missing_value`];
      const explicitMismatch = row[`${stage}_explicit_mismatch`];
      missingStockData[stage] = {
        field: stageFragments[stage].valueColumn,
        candidate_rows_before: candidatesBefore,
        missing_value_rows: missingValue,
        explicit_mismatch_rows: explicitMismatch,
      };
      if (firstDataGapStage === null && candidatesBefore > 0 && missingValue > 0) firstDataGapStage = stage;
    }
  }

  return { stock, missingStockData, firstZeroStage, firstDataGapStage };
}

// Provided/missing criteria for the GENUINE BUYER vs MATCH-ELIGIBLE split
// (spec sections 18-19): a buyer who named no criteria beyond location is
// still a real buyer, just one the matcher can't act on automatically yet.
function buildRequestDiagnostics(structuredRequest) {
  const hasBedrooms = structuredRequest.bedrooms_min !== null || structuredRequest.bedrooms_max !== null;
  const hasBudget = structuredRequest.budget_min !== null || structuredRequest.budget_max !== null;
  const hasBathrooms = structuredRequest.bathrooms_min !== null || structuredRequest.bathrooms_max !== null;
  const hasSize = structuredRequest.size_sqft_min !== null || structuredRequest.size_sqft_max !== null;
  const hasPlotSize = structuredRequest.plot_size_sqft_min !== null || structuredRequest.plot_size_sqft_max !== null;
  const hasArea = Array.isArray(structuredRequest.areas) && structuredRequest.areas.length > 0;

  const presence = {
    transaction_type: Boolean(structuredRequest.transaction_type),
    area: hasArea,
    project: Boolean(structuredRequest.project),
    building: Boolean(structuredRequest.building),
    property_type: Boolean(structuredRequest.property_type),
    bedrooms: hasBedrooms,
    budget: hasBudget,
    furnishing: Boolean(structuredRequest.furnishing),
    bathrooms: hasBathrooms,
    size_sqft: hasSize,
    plot_size_sqft: hasPlotSize,
  };

  const providedFields = Object.keys(presence).filter((key) => presence[key]);
  // Matches location.js's hasMinimumSpecificity() bar exactly: location +
  // at least one of budget/bedrooms/property_type.
  const missingForMatching = ['budget', 'bedrooms', 'property_type'].filter((key) => !presence[key]);

  return { provided_fields: providedFields, missing_required_fields: missingForMatching };
}

// Top-level assembly. `matchOutcome` is matchRequest()'s return value
// (matching/matcher.js) -- carries locationDiagnostics regardless of
// status. `runFunnelQuery(sql, params)` is the injected DB call (reuses
// the same stockRepo.fetchCandidates the matcher already uses -- this is
// still just a parameterized SELECT, no new DB access pattern).
async function buildMatchDiagnostics({ structuredRequest, matchOutcome, activeStockCount, config, runFunnelQuery }) {
  const request = buildRequestDiagnostics(structuredRequest);
  const location = {
    requested: matchOutcome.locationDiagnostics?.requested || [],
    resolved: matchOutcome.locationDiagnostics?.resolved || [],
    unresolved: matchOutcome.locationDiagnostics?.unresolved || [],
    resolution_sources: [],
    partial_resolution: Boolean(matchOutcome.locationDiagnostics?.partial),
  };

  const canRunFunnel = Boolean(matchOutcome.locationDiagnostics?.level) && location.resolved.length > 0;

  if (!canRunFunnel) {
    return {
      version: '1',
      request,
      location,
      stock: { active: activeStockCount, after_location: null, after_transaction: null, after_property_type: null, after_bedrooms: null, after_budget: null, after_bathrooms: null, after_size: null, after_plot_size: null, after_furnishing: null },
      missing_stock_data: {},
      first_zero_stage: null,
      first_data_gap_stage: null,
    };
  }

  const funnelQuery = buildDiagnosticsFunnelQuery({
    structuredRequest,
    locationLevel: matchOutcome.locationDiagnostics.level,
    locationValues: location.resolved,
    config,
  });
  const rows = await runFunnelQuery(funnelQuery.sql, funnelQuery.params);
  const row = rows[0] || {};
  const { stock, missingStockData, firstZeroStage, firstDataGapStage } = buildStockDiagnostics(row, funnelQuery.stageFragments, activeStockCount);

  return {
    version: '1',
    request,
    location,
    stock,
    missing_stock_data: missingStockData,
    first_zero_stage: firstZeroStage,
    first_data_gap_stage: firstDataGapStage,
  };
}

module.exports = {
  buildDiagnosticsFunnelQuery,
  buildRequestDiagnostics,
  buildMatchDiagnostics,
};
