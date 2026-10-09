'use strict';

// /requests page filter (2026-09-28): the page previously had no filter at
// all, dumping every match_run ever processed. These tests cover the new
// getRequestMatches() filters directly against matching_dubai.v_request_matches
// (a LEFT JOIN from match_runs, so it -- unlike v_match_history -- also
// includes NO_MATCH requests with null stock/match columns). Rows are
// inserted directly rather than run through the real matcher, since this
// is testing the SQL filter, not matching logic (already covered by
// tests/integration/matching.test.js).

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getPool, ensureMigrated, truncateAll } = require('./helpers/setup');
const queries = require('../../dashboard/queries');

before(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
});

async function insertStock(pool, overrides = {}) {
  const s = { stock_id: 'STK-1', status: 'ACTIVE', transaction_type: 'SALE', area: 'Business Bay', building: 'Peninsula Four', bedrooms: 2, property_type: 'Apartment', selling_price: 2500000, ...overrides };
  await pool.query(
    `INSERT INTO matching_dubai.stock_inventory (stock_id, status, transaction_type, area, building, bedrooms, property_type, selling_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [s.stock_id, s.status, s.transaction_type, s.area, s.building, s.bedrooms, s.property_type, s.selling_price]
  );
}

async function insertRun(pool, overrides = {}) {
  const r = { sourceMessageId: 'MSG-1', resultStatus: 'MATCH', matchesCount: 1, noMatchReason: null, provider: null, accountId: null, chatId: null, ...overrides };
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.match_runs (source_message_id, result_status, matches_count, no_match_reason, provider, account_id, chat_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [r.sourceMessageId, r.resultStatus, r.matchesCount, r.noMatchReason, r.provider, r.accountId, r.chatId]
  );
  return rows[0].id;
}

async function insertResult(pool, matchRunId, overrides = {}) {
  const r = { sourceMessageId: 'MSG-1', stockId: 'STK-1', matchScore: 90, matchStatus: 'MATCH', matchRank: 1, ...overrides };
  await pool.query(
    `INSERT INTO matching_dubai.match_results (match_run_id, source_message_id, stock_id, match_score, match_status, match_rank)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [matchRunId, r.sourceMessageId, r.stockId, r.matchScore, r.matchStatus, r.matchRank]
  );
}

test('getRequestMatches: with no filters, every request appears, including NO_MATCH (unlike getMatchHistory)', async () => {
  const pool = getPool();
  await insertStock(pool);
  const matchedRunId = await insertRun(pool, { sourceMessageId: 'MSG-MATCHED' });
  await insertResult(pool, matchedRunId, { sourceMessageId: 'MSG-MATCHED' });
  await insertRun(pool, { sourceMessageId: 'MSG-NOMATCH', resultStatus: 'NO_MATCH', matchesCount: 0, noMatchReason: 'area_not_resolved' });

  const rows = await queries.getRequestMatches(pool);
  const ids = rows.map((r) => r.source_message_id);
  assert.ok(ids.includes('MSG-MATCHED'));
  assert.ok(ids.includes('MSG-NOMATCH'), 'NO_MATCH requests must be visible on /requests, unlike /history');
});

test('getRequestMatches: resultStatus=NO_MATCH returns only requests with zero matches', async () => {
  const pool = getPool();
  await insertStock(pool);
  const matchedRunId = await insertRun(pool, { sourceMessageId: 'MSG-MATCHED' });
  await insertResult(pool, matchedRunId, { sourceMessageId: 'MSG-MATCHED' });
  await insertRun(pool, { sourceMessageId: 'MSG-NOMATCH', resultStatus: 'NO_MATCH', matchesCount: 0, noMatchReason: 'area_not_resolved' });

  const rows = await queries.getRequestMatches(pool, { resultStatus: 'NO_MATCH' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_message_id, 'MSG-NOMATCH');
  assert.equal(rows[0].no_match_reason, 'area_not_resolved');
  assert.equal(rows[0].stock_id, null, 'a NO_MATCH row has no joined stock at all');
});

test('getRequestMatches: filtering by area/building/bedrooms/stockId filters on the MATCHED STOCK\'s attributes and naturally excludes NO_MATCH rows', async () => {
  const pool = getPool();
  await insertStock(pool, { stock_id: 'STK-JVC', area: 'JVC', building: 'Tower A', bedrooms: 1 });
  await insertStock(pool, { stock_id: 'STK-MARINA', area: 'Dubai Marina', building: 'Tower B', bedrooms: 3 });
  const jvcRun = await insertRun(pool, { sourceMessageId: 'MSG-JVC' });
  await insertResult(pool, jvcRun, { sourceMessageId: 'MSG-JVC', stockId: 'STK-JVC' });
  const marinaRun = await insertRun(pool, { sourceMessageId: 'MSG-MARINA' });
  await insertResult(pool, marinaRun, { sourceMessageId: 'MSG-MARINA', stockId: 'STK-MARINA' });
  await insertRun(pool, { sourceMessageId: 'MSG-NOMATCH', resultStatus: 'NO_MATCH', matchesCount: 0, noMatchReason: 'no_stock_in_location' });

  const byArea = await queries.getRequestMatches(pool, { area: 'JVC' });
  assert.equal(byArea.length, 1);
  assert.equal(byArea[0].source_message_id, 'MSG-JVC');

  const byStockId = await queries.getRequestMatches(pool, { stockId: 'STK-MARINA' });
  assert.equal(byStockId.length, 1);
  assert.equal(byStockId[0].source_message_id, 'MSG-MARINA');

  const byBedrooms = await queries.getRequestMatches(pool, { bedrooms: '3' });
  assert.equal(byBedrooms.length, 1);
  assert.equal(byBedrooms[0].source_message_id, 'MSG-MARINA');
});

test('getRequestMatches: sourceMessageId does a partial (ILIKE) match', async () => {
  const pool = getPool();
  await insertStock(pool);
  const runId = await insertRun(pool, { sourceMessageId: 'telegram-12345' });
  await insertResult(pool, runId, { sourceMessageId: 'telegram-12345' });
  await insertRun(pool, { sourceMessageId: 'whatsapp-99999', resultStatus: 'NO_MATCH', matchesCount: 0 });

  const rows = await queries.getRequestMatches(pool, { sourceMessageId: '12345' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_message_id, 'telegram-12345');
});

test('getRequestMatches: resultStatus and area filters combine with AND semantics', async () => {
  const pool = getPool();
  await insertStock(pool, { stock_id: 'STK-A', area: 'JVC' });
  const matchedRun = await insertRun(pool, { sourceMessageId: 'MSG-A' });
  await insertResult(pool, matchedRun, { sourceMessageId: 'MSG-A', stockId: 'STK-A' });
  await insertRun(pool, { sourceMessageId: 'MSG-B', resultStatus: 'NO_MATCH', matchesCount: 0 });

  const rows = await queries.getRequestMatches(pool, { resultStatus: 'MATCH', area: 'JVC' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_message_id, 'MSG-A');

  const noRows = await queries.getRequestMatches(pool, { resultStatus: 'NO_MATCH', area: 'JVC' });
  assert.equal(noRows.length, 0, 'a NO_MATCH request never has an area, so this combination correctly yields nothing');
});

test('getRequestMatches: an empty-string filter value is ignored (same "no filter" convention as getMatchHistory)', async () => {
  const pool = getPool();
  await insertStock(pool);
  const runId = await insertRun(pool);
  await insertResult(pool, runId);

  const rows = await queries.getRequestMatches(pool, { area: '', resultStatus: '', bedrooms: '' });
  assert.equal(rows.length, 1);
});

// ---- channel/route/account filters (2026-10-07, ADR-046) -----------------

test('getRequestMatches: provider/accountId/chatId filters narrow on match_runs columns the view now surfaces', async () => {
  const pool = getPool();
  await insertStock(pool);
  const tgRun = await insertRun(pool, { sourceMessageId: 'MSG-TG', provider: 'telegram', accountId: 'tg_main', chatId: '-1001' });
  await insertResult(pool, tgRun, { sourceMessageId: 'MSG-TG' });
  const waRun = await insertRun(pool, { sourceMessageId: 'MSG-WA', provider: 'whatsapp', accountId: 'wa_main', chatId: '12035@g.us', resultStatus: 'NO_MATCH', matchesCount: 0 });

  const byProvider = await queries.getRequestMatches(pool, { provider: 'whatsapp' });
  assert.equal(byProvider.length, 1);
  assert.equal(byProvider[0].source_message_id, 'MSG-WA');

  const byAccount = await queries.getRequestMatches(pool, { accountId: 'tg_main' });
  assert.equal(byAccount.length, 1);
  assert.equal(byAccount[0].source_message_id, 'MSG-TG');

  const byChat = await queries.getRequestMatches(pool, { chatId: '12035@g.us' });
  assert.equal(byChat.length, 1);
  assert.equal(byChat[0].source_message_id, 'MSG-WA');
  assert.equal(byChat[0].result_status, 'NO_MATCH');
});

test('getMatchHistory: provider/accountId/chatId filters work the same way, via the run join added in migration 0042', async () => {
  const pool = getPool();
  await insertStock(pool);
  const tgRun = await insertRun(pool, { sourceMessageId: 'MSG-TG', provider: 'telegram', accountId: 'tg_main', chatId: '-1001' });
  await insertResult(pool, tgRun, { sourceMessageId: 'MSG-TG' });
  const waRun = await insertRun(pool, { sourceMessageId: 'MSG-WA', provider: 'whatsapp', accountId: 'wa_main', chatId: '12035@g.us' });
  await insertResult(pool, waRun, { sourceMessageId: 'MSG-WA', stockId: 'STK-1' });

  const byProvider = await queries.getMatchHistory(pool, { provider: 'telegram' });
  assert.equal(byProvider.length, 1);
  assert.equal(byProvider[0].source_message_id, 'MSG-TG');

  const byAccount = await queries.getMatchHistory(pool, { accountId: 'wa_main' });
  assert.equal(byAccount.length, 1);
  assert.equal(byAccount[0].source_message_id, 'MSG-WA');
});

test('getRequestMatches/getMatchHistory: schema parameter routes to the right market, rejecting anything outside the allow-list', async () => {
  const pool = getPool();
  await assert.rejects(() => queries.getRequestMatches(pool, {}, 'matching_evil; DROP TABLE matching_dubai.stock_inventory; --'));
  await assert.rejects(() => queries.getMatchHistory(pool, {}, 'not_a_real_schema'));

  await pool.query(
    `INSERT INTO matching_abu_dhabi.stock_inventory (stock_id, status, transaction_type, area, building, bedrooms, property_type, selling_price)
     VALUES ('AD-STK-1','ACTIVE','SALE','Al Reem','Tower AD',2,'Apartment',1800000)`
  );
  const { rows: runRows } = await pool.query(
    `INSERT INTO matching_abu_dhabi.match_runs (source_message_id, result_status, matches_count, provider, account_id, chat_id)
     VALUES ('AD-MSG-1','MATCH',1,'telegram','tg_ad','-2002') RETURNING id`
  );
  await pool.query(
    `INSERT INTO matching_abu_dhabi.match_results (match_run_id, source_message_id, stock_id, match_score, match_status, match_rank)
     VALUES ($1,'AD-MSG-1','AD-STK-1',88,'MATCH',1)`,
    [runRows[0].id]
  );

  const rows = await queries.getRequestMatches(pool, {}, 'matching_abu_dhabi');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_message_id, 'AD-MSG-1');
  assert.equal(rows[0].account_id, 'tg_ad');

  const historyRows = await queries.getMatchHistory(pool, {}, 'matching_abu_dhabi');
  assert.equal(historyRows.length, 1);
  assert.equal(historyRows[0].chat_id, '-2002');
});

// ---- getStockByMarket (2026-09-28, multi-market /stock) -----------------

const { mapJokerObjectToStockRow } = require('../../src/joker/joker-stock-mapper');
const jokerRepo = require('../../src/joker/joker-stock-repository');

async function cleanJokerSchemas(pool) {
  for (const schema of ['matching_moscow', 'matching_turkey']) {
    await pool.query(`DELETE FROM ${schema}.stock_inventory`);
  }
}

test('getStockByMarket: market="uae" (or omitted/invalid) returns the existing UAE view, untouched by this feature', async () => {
  const pool = getPool();
  await insertStock(pool, { stock_id: 'STK-MARKET-UAE' });
  const { market, rows } = await queries.getStockByMarket(pool, 'uae');
  assert.equal(market, 'uae');
  assert.ok(rows.some((r) => r.stock_id === 'STK-MARKET-UAE'));
});

test('getStockByMarket: market="moscow" queries matching_moscow.stock_inventory, never matching_dubai.stock_inventory', async () => {
  const pool = getPool();
  await cleanJokerSchemas(pool);
  await jokerRepo.upsertStockRow(pool, 'matching_moscow', mapJokerObjectToStockRow({
    id: 555001, url: 'https://moscow.nikaestate.ru/x/555001', type: 'Квартиры - вторичное жильё', deal_type: 'sale',
    region: 'Москва', city: 'Москва', district: 'Тверской', microdistrict: null, price: '50000000',
    development: null, complex: null, agent: { id: 1, name: 'A', phone: null, email: null }, params: {},
  }));

  const { market, rows } = await queries.getStockByMarket(pool, 'moscow');
  assert.equal(market, 'moscow');
  assert.ok(rows.some((r) => Number(r.joker_object_id) === 555001));
  await cleanJokerSchemas(pool);
});

test('getStockByMarket: only rows marked available=true are returned', async () => {
  const pool = getPool();
  await cleanJokerSchemas(pool);
  await jokerRepo.upsertStockRow(pool, 'matching_turkey', mapJokerObjectToStockRow({
    id: 555002, url: 'https://moscow.nikaestate.ru/x/555002', type: 'Квартиры - вторичное жильё', deal_type: 'sale',
    region: 'Турция', city: 'Стамбул', district: null, microdistrict: null, price: '4000000',
    development: null, complex: null, agent: { id: 1, name: 'A', phone: null, email: null }, params: {},
  }));
  await jokerRepo.markMissingUnavailable(pool, 'matching_turkey', []); // nothing "seen" -> marks it unavailable

  const { rows } = await queries.getStockByMarket(pool, 'turkey');
  assert.equal(rows.some((r) => Number(r.joker_object_id) === 555002), false);
  await cleanJokerSchemas(pool);
});

// ---- Pagination (2026-09-28) -- was a hardcoded, silent LIMIT 500 --------

test('getStockByMarket: paginates instead of silently truncating -- totalCount reflects ALL available rows, not just the page returned', async () => {
  const pool = getPool();
  await cleanJokerSchemas(pool);
  const pageSize = 5;
  for (let i = 0; i < 12; i++) {
    await jokerRepo.upsertStockRow(pool, 'matching_turkey', mapJokerObjectToStockRow({
      id: 556000 + i, url: `https://moscow.nikaestate.ru/x/${556000 + i}`, type: 'Квартиры - вторичное жильё', deal_type: 'sale',
      region: 'Турция', city: 'Стамбул', district: null, microdistrict: null, price: '4000000',
      development: null, complex: null, agent: { id: 1, name: 'A', phone: null, email: null }, params: {},
    }));
  }

  const page1 = await queries.getStockByMarket(pool, 'turkey', { page: 1, pageSize });
  assert.equal(page1.rows.length, pageSize);
  assert.equal(page1.totalCount, 12);
  assert.equal(page1.totalPages, 3);

  const page3 = await queries.getStockByMarket(pool, 'turkey', { page: 3, pageSize });
  assert.equal(page3.rows.length, 2, 'last page is a partial page, not padded or empty');

  const allIdsAcrossPages = new Set();
  for (let p = 1; p <= 3; p++) {
    const { rows } = await queries.getStockByMarket(pool, 'turkey', { page: p, pageSize });
    for (const r of rows) allIdsAcrossPages.add(Number(r.joker_object_id));
  }
  assert.equal(allIdsAcrossPages.size, 12, 'every row is reachable via pagination exactly once, none silently dropped');
  await cleanJokerSchemas(pool);
});

test('getStockByMarket: an out-of-range or invalid page number falls back to page 1, never throws', async () => {
  const pool = getPool();
  await insertStock(pool, { stock_id: 'STK-PAGE-FALLBACK' });
  const zero = await queries.getStockByMarket(pool, 'uae', { page: 0 });
  assert.equal(zero.page, 1);
  const negative = await queries.getStockByMarket(pool, 'uae', { page: -5 });
  assert.equal(negative.page, 1);
});

// ---- Quick stock_id search (2026-10-08) ----------------------------------

test('getStockByMarket: search is a case-insensitive partial match on stock_id (hasMatchCounts markets)', async () => {
  const pool = getPool();
  await insertStock(pool, { stock_id: 'STK-SEARCH-ALPHA' });
  await insertStock(pool, { stock_id: 'STK-SEARCH-BETA' });
  await insertStock(pool, { stock_id: 'STK-OTHER-GAMMA' });

  const { rows, totalCount } = await queries.getStockByMarket(pool, 'uae', { search: 'search-alpha' });
  assert.equal(totalCount, 1);
  assert.deepEqual(rows.map((r) => r.stock_id), ['STK-SEARCH-ALPHA']);
});

test('getStockByMarket: an empty/whitespace-only search behaves exactly like no search at all', async () => {
  const pool = getPool();
  await insertStock(pool, { stock_id: 'STK-NOSEARCH-1' });
  const withBlank = await queries.getStockByMarket(pool, 'uae', { search: '   ' });
  const withNone = await queries.getStockByMarket(pool, 'uae', {});
  assert.equal(withBlank.totalCount, withNone.totalCount);
});

test('getStockByMarket: a search matching nothing returns zero rows, never throws', async () => {
  const pool = getPool();
  await insertStock(pool, { stock_id: 'STK-SEARCH-REAL' });
  const { rows, totalCount } = await queries.getStockByMarket(pool, 'uae', { search: 'no-such-id-exists' });
  assert.equal(totalCount, 0);
  assert.deepEqual(rows, []);
});

test('getStockByMarket: search also works for Joker-fed markets, matching joker_object_id as text', async () => {
  const pool = getPool();
  await cleanJokerSchemas(pool);
  await jokerRepo.upsertStockRow(pool, 'matching_turkey', mapJokerObjectToStockRow({
    id: 557123, url: 'https://moscow.nikaestate.ru/x/557123', type: 'Квартиры - вторичное жильё', deal_type: 'sale',
    region: 'Турция', city: 'Стамбул', district: null, microdistrict: null, price: '4000000',
    development: null, complex: null, agent: { id: 1, name: 'A', phone: null, email: null }, params: {},
  }));
  await jokerRepo.upsertStockRow(pool, 'matching_turkey', mapJokerObjectToStockRow({
    id: 999999, url: 'https://moscow.nikaestate.ru/x/999999', type: 'Квартиры - вторичное жильё', deal_type: 'sale',
    region: 'Турция', city: 'Стамбул', district: null, microdistrict: null, price: '4000000',
    development: null, complex: null, agent: { id: 1, name: 'A', phone: null, email: null }, params: {},
  }));

  const { rows, totalCount } = await queries.getStockByMarket(pool, 'turkey', { search: '557123' });
  assert.equal(totalCount, 1);
  assert.equal(Number(rows[0].joker_object_id), 557123);
  await cleanJokerSchemas(pool);
});

test('getStockByMarket: a non-numeric search against a Joker-fed market matches nothing, never throws a type error', async () => {
  const pool = getPool();
  await cleanJokerSchemas(pool);
  await jokerRepo.upsertStockRow(pool, 'matching_turkey', mapJokerObjectToStockRow({
    id: 557124, url: 'https://moscow.nikaestate.ru/x/557124', type: 'Квартиры - вторичное жильё', deal_type: 'sale',
    region: 'Турция', city: 'Стамбул', district: null, microdistrict: null, price: '4000000',
    development: null, complex: null, agent: { id: 1, name: 'A', phone: null, email: null }, params: {},
  }));
  const { rows, totalCount } = await queries.getStockByMarket(pool, 'turkey', { search: 'not-a-number' });
  assert.equal(totalCount, 0);
  assert.deepEqual(rows, []);
  await cleanJokerSchemas(pool);
});
