'use strict';

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getPool, ensureMigrated, truncateAll } = require('./helpers/setup');
const { upsertStockRows, fetchActiveStock } = require('../../src/db/stockRepository');
const { persistMatchOutcome } = require('../../src/db/matchRepository');
const { matchRequest } = require('../../src/core/matcher');
const { buildAliasIndex } = require('../../src/core/aliases');
const { DEFAULT_CONFIG } = require('../../src/core/config');
const { validateStockRow } = require('../../src/core/sync-normalize');
const { makeParsedRequest } = require('../../tests/fixtures/requests');

before(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAll();
});

function stockRow(overrides) {
  return validateStockRow({
    stock_id: 'STK-1',
    status: 'live',
    transaction_type: 'SALE',
    area: 'Business Bay',
    building: 'Peninsula Four',
    bedrooms: 2,
    property_type: 'Apartment',
    furnishing: 'Furnished',
    selling_price: 2500000,
    ...overrides,
  }).value;
}

async function loadStockAndMatch(pool, parsedRequestOverrides = {}) {
  const stockCandidates = await fetchActiveStock(pool, { transactionTypes: ['SALE'] });
  return matchRequest({
    parsedRequest: makeParsedRequest(parsedRequestOverrides),
    aliasIndex: buildAliasIndex([]),
    stockCandidates,
    config: DEFAULT_CONFIG,
    stockSyncedAt: new Date().toISOString(),
  });
}

test('MATCH creates a match_runs row and a match_results row', async () => {
  const pool = getPool();
  await upsertStockRows(pool, [stockRow()]);
  const outcome = await loadStockAndMatch(pool);
  assert.notEqual(outcome.resultStatus, 'NO_MATCH');

  const { matchRunId } = await persistMatchOutcome(pool, {
    sourceMessageId: 'MSG-1',
    parsedRequest: makeParsedRequest(),
    matchOutcome: outcome,
    stockSyncedAt: new Date().toISOString(),
    parserVersion: 'pilot-v1',
    matcherVersion: 'pilot-v1',
  });

  const run = await pool.query('SELECT * FROM matching_dubai.match_runs WHERE id = $1', [matchRunId]);
  assert.equal(run.rows.length, 1);
  assert.notEqual(run.rows[0].result_status, 'NO_MATCH');

  const results = await pool.query('SELECT * FROM matching_dubai.match_results WHERE match_run_id = $1', [matchRunId]);
  assert.equal(results.rows.length, 1);
  assert.equal(results.rows[0].source_message_id, 'MSG-1');
  assert.equal(results.rows[0].stock_id, 'STK-1');
});

test('NO_MATCH creates a match_runs row and zero match_results rows', async () => {
  const pool = getPool();
  await upsertStockRows(pool, [stockRow({ area: 'JVC', building: 'Unrelated Tower' })]);
  const outcome = await loadStockAndMatch(pool);
  assert.equal(outcome.resultStatus, 'NO_MATCH');

  const { matchRunId } = await persistMatchOutcome(pool, {
    sourceMessageId: 'MSG-2',
    parsedRequest: makeParsedRequest(),
    matchOutcome: outcome,
    stockSyncedAt: new Date().toISOString(),
    parserVersion: 'pilot-v1',
    matcherVersion: 'pilot-v1',
  });

  const run = await pool.query('SELECT * FROM matching_dubai.match_runs WHERE id = $1', [matchRunId]);
  assert.equal(run.rows[0].result_status, 'NO_MATCH');
  assert.ok(run.rows[0].no_match_reason);

  const results = await pool.query('SELECT * FROM matching_dubai.match_results WHERE match_run_id = $1', [matchRunId]);
  assert.equal(results.rows.length, 0);
});

test('CRITICAL: five successful stock matches are all persisted as five match_results rows', async () => {
  const pool = getPool();
  await upsertStockRows(pool, [
    stockRow({ stock_id: 'STK-1001', selling_price: 2400000 }),
    stockRow({ stock_id: 'STK-1002', selling_price: 2450000 }),
    stockRow({ stock_id: 'STK-1003', selling_price: 2500000 }),
    stockRow({ stock_id: 'STK-1004', selling_price: 2380000 }),
    stockRow({ stock_id: 'STK-1005', selling_price: 2420000 }),
  ]);
  const outcome = await loadStockAndMatch(pool);
  assert.equal(outcome.matchesCount, 5);

  const { matchRunId } = await persistMatchOutcome(pool, {
    sourceMessageId: 'MSG-5',
    parsedRequest: makeParsedRequest(),
    matchOutcome: outcome,
    stockSyncedAt: new Date().toISOString(),
    parserVersion: 'pilot-v1',
    matcherVersion: 'pilot-v1',
  });

  const results = await pool.query(
    'SELECT stock_id FROM matching_dubai.match_results WHERE match_run_id = $1 ORDER BY stock_id',
    [matchRunId]
  );
  assert.deepEqual(
    results.rows.map((r) => r.stock_id),
    ['STK-1001', 'STK-1002', 'STK-1003', 'STK-1004', 'STK-1005']
  );
});

test('rerunning the same request does not duplicate the same Request<->Stock match', async () => {
  const pool = getPool();
  await upsertStockRows(pool, [stockRow()]);
  const outcomeFirst = await loadStockAndMatch(pool);
  await persistMatchOutcome(pool, {
    sourceMessageId: 'MSG-3',
    parsedRequest: makeParsedRequest(),
    matchOutcome: outcomeFirst,
    stockSyncedAt: new Date().toISOString(),
    parserVersion: 'pilot-v1',
    matcherVersion: 'pilot-v1',
  });

  const outcomeSecond = await loadStockAndMatch(pool);
  await persistMatchOutcome(pool, {
    sourceMessageId: 'MSG-3',
    parsedRequest: makeParsedRequest(),
    matchOutcome: outcomeSecond,
    stockSyncedAt: new Date().toISOString(),
    parserVersion: 'pilot-v1',
    matcherVersion: 'pilot-v1',
  });

  const results = await pool.query(
    'SELECT * FROM matching_dubai.match_results WHERE source_message_id = $1',
    ['MSG-3']
  );
  assert.equal(results.rows.length, 1);

  const runs = await pool.query('SELECT * FROM matching_dubai.match_runs WHERE source_message_id = $1', ['MSG-3']);
  assert.equal(runs.rows.length, 2, 'each attempt still records its own match_runs row for debugging');
});

test('the match_results UNIQUE(source_message_id, stock_id) constraint rejects a raw duplicate insert', async () => {
  const pool = getPool();
  await upsertStockRows(pool, [stockRow()]);
  const runResult = await pool.query(
    `INSERT INTO matching_dubai.match_runs (source_message_id, result_status) VALUES ('MSG-4', 'MATCH') RETURNING id`
  );
  const runId = runResult.rows[0].id;
  await pool.query(
    `INSERT INTO matching_dubai.match_results (match_run_id, source_message_id, stock_id, match_score, match_status)
     VALUES ($1, 'MSG-4', 'STK-1', 90, 'STRONG_MATCH')`,
    [runId]
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO matching_dubai.match_results (match_run_id, source_message_id, stock_id, match_score, match_status)
       VALUES ($1, 'MSG-4', 'STK-1', 91, 'STRONG_MATCH')`,
      [runId]
    ),
    /duplicate key value violates unique constraint/
  );
});

test('a successful match links back to the existing source message ID', async () => {
  const pool = getPool();
  await upsertStockRows(pool, [stockRow()]);
  const outcome = await loadStockAndMatch(pool);
  const { matchRunId } = await persistMatchOutcome(pool, {
    sourceMessageId: 'EXISTING-DEVI-MESSAGE-42',
    parsedRequest: makeParsedRequest(),
    matchOutcome: outcome,
    stockSyncedAt: new Date().toISOString(),
    parserVersion: 'pilot-v1',
    matcherVersion: 'pilot-v1',
  });
  const results = await pool.query('SELECT source_message_id FROM matching_dubai.match_results WHERE match_run_id = $1', [matchRunId]);
  assert.equal(results.rows[0].source_message_id, 'EXISTING-DEVI-MESSAGE-42');
});

test('telegram_post/whatsapp_post on match_results describe the REQUEST source, not the stock', async () => {
  const pool = getPool();
  await upsertStockRows(pool, [stockRow()]);
  const outcome = await loadStockAndMatch(pool);
  const { matchRunId } = await persistMatchOutcome(pool, {
    sourceMessageId: 'MSG-TG',
    parsedRequest: makeParsedRequest(),
    matchOutcome: outcome,
    stockSyncedAt: new Date().toISOString(),
    parserVersion: 'pilot-v1',
    matcherVersion: 'pilot-v1',
    provider: 'telegram',
    sourceUrl: 'https://t.me/somegroup/456',
  });
  const result = await pool.query(
    'SELECT telegram_post, whatsapp_post FROM matching_dubai.match_results WHERE match_run_id = $1',
    [matchRunId]
  );
  assert.equal(result.rows[0].telegram_post, 'https://t.me/somegroup/456');
  assert.equal(result.rows[0].whatsapp_post, null);
});
