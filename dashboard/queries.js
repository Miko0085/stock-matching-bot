'use strict';

// Read-only queries against the matching schema. Every filter value is bound
// as a parameter — never string-concatenated into SQL.

async function getSummary(pool) {
  const { rows } = await pool.query('SELECT * FROM matching_dubai.v_dashboard_summary');
  return rows[0] || null;
}

// Schema-parameterized (2026-10-06, Abu Dhabi dashboard split) -- same
// allow-list discipline as src/joker/joker-stock-repository.js's
// assertValidSchema: `schema` only ever comes from MARKETS below, never
// directly from request input.
const VALID_MATCH_COUNT_SCHEMAS = new Set(['matching_dubai', 'matching_abu_dhabi']);
function assertValidMatchCountSchema(schema) {
  if (!VALID_MATCH_COUNT_SCHEMAS.has(schema)) {
    throw new Error(`getStockMatchCounts: schema "${schema}" is not in the allow-list`);
  }
}

// `search` (2026-10-08, quick stock_id search on /stock): a plain
// substring match, case-insensitive, never string-concatenated -- always
// bound as a parameter, same discipline as every other filter in this
// file.
async function getStockMatchCounts(pool, { limit, offset, schema = 'matching_dubai', search = null } = {}) {
  assertValidMatchCountSchema(schema);
  const where = search ? 'WHERE stock_id ILIKE $1' : '';
  const params = search ? [`%${search}%`] : [];
  if (limit === undefined) {
    const { rows } = await pool.query(
      `SELECT * FROM ${schema}.v_stock_match_counts ${where} ORDER BY match_count DESC, stock_id ASC`,
      params
    );
    return rows;
  }
  params.push(limit, offset || 0);
  const { rows } = await pool.query(
    `SELECT * FROM ${schema}.v_stock_match_counts ${where} ORDER BY match_count DESC, stock_id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

async function getStockMatchCountsTotal(pool, schema = 'matching_dubai', search = null) {
  assertValidMatchCountSchema(schema);
  const where = search ? 'WHERE stock_id ILIKE $1' : '';
  const params = search ? [`%${search}%`] : [];
  const { rows } = await pool.query(`SELECT count(*)::int AS c FROM ${schema}.v_stock_match_counts ${where}`, params);
  return rows[0].c;
}

// Multi-market /stock (2026-09-28, docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md
// section 8; split further 2026-10-06 to give Abu Dhabi its own entry
// instead of silently falling back to Dubai's -- same thing routing
// already did for ABU_DHABI as a source-routing label). `hasMatchCounts:
// true` markets (Dubai, Abu Dhabi) have a REAL matcher and read their own
// v_stock_match_counts view (schema-parameterized, same view shape). The
// Joker-fed markets (Moscow/Oman/Saudi/Turkey) each live in their OWN
// schema (src/joker/joker-market-router.js's MARKET_SCHEMAS), populated by
// src/joker/joker-stock-sync.js, and have no matching logic at all yet, so
// they read raw stock_inventory instead. `MARKETS` is the single source of
// truth for which market keys/schemas exist -- a market key not in this
// map is never interpolated into a query string.
// `hasMatchRuns` (2026-10-07, channel/route/account filters on /requests
// and /history): distinct from `hasMatchCounts` above -- Moscow has real
// match_runs/match_results (ADR-042 enabled RF rental end-to-end) but no
// v_stock_match_counts view (that's /stock-page-specific). Oman/Saudi/
// Turkey have no matching logic at all yet (stock visibility only, AGENTS.md
// section 0), so they never get a /requests or /history tab.
const MARKETS = {
  uae: { label: 'Дубай', schema: 'matching_dubai', hasMatchCounts: true, hasMatchRuns: true },
  abu_dhabi: { label: 'Абу-Даби', schema: 'matching_abu_dhabi', hasMatchCounts: true, hasMatchRuns: true },
  moscow: { label: 'Москва', schema: 'matching_moscow', hasMatchCounts: false, hasMatchRuns: true },
  oman: { label: 'Оман', schema: 'matching_oman', hasMatchCounts: false, hasMatchRuns: false },
  saudi: { label: 'Саудовская Аравия', schema: 'matching_saudi', hasMatchCounts: false, hasMatchRuns: false },
  turkey: { label: 'Турция', schema: 'matching_turkey', hasMatchCounts: false, hasMatchRuns: false },
};
const DEFAULT_MARKET = 'uae';

function resolveMarketKey(market) {
  return Object.prototype.hasOwnProperty.call(MARKETS, market) ? market : DEFAULT_MARKET;
}

// Same allow-list discipline as resolveMarketKey, narrowed to markets that
// actually have match_runs/match_results (a market key not in MARKETS, or
// one with hasMatchRuns: false, falls back to the default rather than ever
// being interpolated into a query string).
function resolveMatchRunsMarketKey(market) {
  const key = resolveMarketKey(market);
  return MARKETS[key].hasMatchRuns ? key : DEFAULT_MARKET;
}

// UAE keeps its existing view (match_count/strong_match_count -- it's the
// only market with real matching today). The 4 Joker-fed markets show the
// finalized Joker criteria instead (docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md
// section 5.1.1) -- no match counts, since nothing matches against them yet.
//
// Paginated (2026-09-28): a Joker-fed market can genuinely hold 10,000+
// rows (Moscow, after the strict-scope rescope, still has 10,411) -- the
// old hardcoded `LIMIT 500` silently truncated the page to the 500 most
// recently synced rows with no indication anything was cut off. Every
// caller now gets `totalCount`/`totalPages` back so the page can render an
// honest "showing X-Y of Z" and prev/next controls instead.
const DEFAULT_PAGE_SIZE = 200;

async function getStockByMarket(pool, marketInput, { page = 1, pageSize = DEFAULT_PAGE_SIZE, search = null } = {}) {
  const market = resolveMarketKey(marketInput);
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const offset = (safePage - 1) * pageSize;
  const trimmedSearch = search ? String(search).trim() : null;

  const { schema, hasMatchCounts } = MARKETS[market];
  let rows;
  let totalCount;
  if (hasMatchCounts) {
    [rows, totalCount] = await Promise.all([
      getStockMatchCounts(pool, { limit: pageSize, offset, schema, search: trimmedSearch }),
      getStockMatchCountsTotal(pool, schema, trimmedSearch),
    ]);
  } else {
    // joker_object_id is BIGINT -- cast to text so a partial/non-numeric
    // search string never throws a type-conversion error, it just matches
    // nothing.
    const searchClause = trimmedSearch ? 'AND joker_object_id::text ILIKE $3' : '';
    const params = trimmedSearch ? [pageSize, offset, `%${trimmedSearch}%`] : [pageSize, offset];
    const countParams = trimmedSearch ? [`%${trimmedSearch}%`] : [];
    const [rowsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT joker_object_id, joker_url, agent_name, agent_phone,
                property_type_raw, city, district, complex,
                rooms, rooms_sentinel, bedrooms, area_sqm, floor, floors_total,
                price, readiness_year, readiness_quarter,
                include_in_matching, synced_at
         FROM ${schema}.stock_inventory
         WHERE available = true ${searchClause}
         ORDER BY synced_at DESC
         LIMIT $1 OFFSET $2`,
        params
      ),
      pool.query(
        `SELECT count(*)::int AS c FROM ${schema}.stock_inventory WHERE available = true ${trimmedSearch ? 'AND joker_object_id::text ILIKE $1' : ''}`,
        countParams
      ),
    ]);
    rows = rowsResult.rows;
    totalCount = countResult.rows[0].c;
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  return { market, rows, page: safePage, pageSize, totalCount, totalPages, search: trimmedSearch };
}

// Schema-parameterized (2026-10-07, channel/route/account filters): same
// allow-list discipline as assertValidMatchCountSchema -- `schema` only
// ever comes from MARKETS (via resolveMatchRunsMarketKey), never directly
// from request input.
const MATCH_RUNS_SCHEMAS = new Set(['matching_dubai', 'matching_abu_dhabi', 'matching_moscow']);
function assertValidMatchRunsSchema(schema) {
  if (!MATCH_RUNS_SCHEMAS.has(schema)) {
    throw new Error(`getRequestMatches/getMatchHistory: schema "${schema}" is not in the allow-list`);
  }
}

// Request-centric filters (2026-09-28, extended 2026-10-07 for channel/
// route/account): unlike v_match_history (one row per SUCCESSFUL match
// only), v_request_matches is a LEFT JOIN from match_runs, so it also
// includes NO_MATCH requests (with null stock/match columns).
// `resultStatus` filters the REQUEST-level outcome (MATCH/STRONG_MATCH/
// NO_MATCH, run.result_status); area/building/bedrooms/stockId filter the
// MATCHED STOCK's own attributes, same column semantics as getMatchHistory
// -- filtering by one of these naturally excludes NO_MATCH rows (they have
// no stock joined), which matches what an operator filtering by e.g. area
// actually wants to see. `provider`/`accountId`/`chatId` are uniform across
// all three views (migration 0042) so they apply the same way regardless
// of schema. Dubai/Abu Dhabi and Moscow do NOT share stock column names
// (AGENTS.md section 0 -- RF criteria must never be forced into Dubai
// fields or vice versa): area/building/stockId only apply to Dubai/Abu
// Dhabi; Moscow gets its own district/complex/stockId (stock_joker_object_id,
// numeric) filter names.
async function getRequestMatches(pool, filters = {}, schema = 'matching_dubai') {
  assertValidMatchRunsSchema(schema);
  const isMoscow = schema === 'matching_moscow';
  const clauses = [];
  const params = [];

  function addFilter(column, value) {
    if (value === undefined || value === null || value === '') return;
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  }

  addFilter('result_status', filters.resultStatus);
  addFilter('provider', filters.provider);
  addFilter('account_id', filters.accountId);
  addFilter('chat_id', filters.chatId);
  addFilter('bedrooms', filters.bedrooms !== undefined && filters.bedrooms !== '' ? Number(filters.bedrooms) : undefined);

  if (isMoscow) {
    addFilter('district', filters.district);
    addFilter('complex', filters.complex);
    addFilter('stock_joker_object_id', filters.stockId !== undefined && filters.stockId !== '' ? Number(filters.stockId) : undefined);
  } else {
    addFilter('area', filters.area);
    addFilter('building', filters.building);
    addFilter('stock_id', filters.stockId);
  }

  if (filters.sourceMessageId) {
    params.push(`%${filters.sourceMessageId}%`);
    clauses.push(`source_message_id ILIKE $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(filters.limit ? Number(filters.limit) : 200);

  const { rows } = await pool.query(
    `SELECT * FROM ${schema}.v_request_matches ${where} ORDER BY run_created_at DESC, match_rank ASC NULLS LAST LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function getMatchHistory(pool, filters = {}, schema = 'matching_dubai') {
  assertValidMatchRunsSchema(schema);
  const isMoscow = schema === 'matching_moscow';
  const clauses = [];
  const params = [];

  function addFilter(column, value) {
    if (value === undefined || value === null || value === '') return;
    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  }

  addFilter('provider', filters.provider);
  addFilter('account_id', filters.accountId);
  addFilter('chat_id', filters.chatId);
  addFilter('bedrooms', filters.bedrooms !== undefined ? Number(filters.bedrooms) : undefined);
  addFilter('match_status', filters.status);

  if (isMoscow) {
    addFilter('district', filters.district);
    addFilter('complex', filters.complex);
    addFilter('stock_joker_object_id', filters.stockId !== undefined && filters.stockId !== '' ? Number(filters.stockId) : undefined);
  } else {
    addFilter('area', filters.area);
    addFilter('building', filters.building);
    addFilter('stock_id', filters.stockId);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(filters.limit ? Number(filters.limit) : 200);

  const { rows } = await pool.query(
    `SELECT * FROM ${schema}.v_match_history ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function getStockMatchedRequests(pool, stockId, { limit = 200, schema = 'matching_dubai' } = {}) {
  assertValidMatchCountSchema(schema);
  const { rows } = await pool.query(
    `SELECT source_message_id, match_score, match_status, match_rank, created_at
     FROM ${schema}.match_results WHERE stock_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [stockId, limit]
  );
  return rows;
}

// day/week/month bucketing for the AI Usage chart. `trunc` only ever comes
// from this fixed map (never interpolated from request input) before being
// bound as a parameter — date_trunc's field argument still has to be a
// plain string, not a placeholder value read from the table, but the
// allow-list keeps arbitrary input from ever reaching the query string.
const AI_USAGE_GRANULARITIES = {
  day: { trunc: 'day', lookback: '30 days' },
  week: { trunc: 'week', lookback: '90 days' },
  month: { trunc: 'month', lookback: '365 days' },
};

async function getAiUsageSeries(pool, granularity = 'day') {
  const cfg = AI_USAGE_GRANULARITIES[granularity] || AI_USAGE_GRANULARITIES.day;
  const { rows } = await pool.query(
    `SELECT date_trunc('${cfg.trunc}', created_at) AS bucket,
            count(*) AS requests,
            coalesce(sum(total_tokens), 0) AS total_tokens,
            coalesce(sum(estimated_cost_usd), 0) AS cost_usd
     FROM matching_dubai.ai_usage_log
     WHERE created_at > now() - $1::interval
     GROUP BY 1
     ORDER BY 1`,
    [cfg.lookback]
  );
  return rows;
}

async function getAiUsageTotals(pool) {
  const { rows } = await pool.query(`SELECT
    coalesce(sum(estimated_cost_usd) FILTER (WHERE created_at > date_trunc('day', now())), 0) AS cost_today,
    coalesce(sum(estimated_cost_usd) FILTER (WHERE created_at > now() - interval '7 days'), 0) AS cost_7d,
    coalesce(sum(estimated_cost_usd) FILTER (WHERE created_at > now() - interval '30 days'), 0) AS cost_30d,
    coalesce(sum(estimated_cost_usd), 0) AS cost_all_time,
    coalesce(sum(total_tokens), 0) AS tokens_all_time,
    count(*) AS requests_all_time
  FROM matching_dubai.ai_usage_log`);
  return rows[0];
}

async function getRecentAiUsage(pool, { limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT created_at, source_message_id, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd
     FROM matching_dubai.ai_usage_log ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = {
  getSummary,
  getStockMatchCounts,
  getStockMatchCountsTotal,
  MARKETS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_MARKET,
  resolveMarketKey,
  resolveMatchRunsMarketKey,
  MATCH_RUNS_SCHEMAS,
  getStockByMarket,
  getRequestMatches,
  getMatchHistory,
  getStockMatchedRequests,
  AI_USAGE_GRANULARITIES,
  getAiUsageSeries,
  getAiUsageTotals,
  getRecentAiUsage,
};
