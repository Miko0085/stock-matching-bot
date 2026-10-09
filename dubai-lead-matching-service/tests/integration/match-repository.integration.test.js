'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const matchRepo = require('../../src/repositories/match-repository');

let pool;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  await pool.query(`DELETE FROM matching_dubai.match_results WHERE source_message_id LIKE 'lms-it:%'`);
  await pool.query(`DELETE FROM matching_dubai.match_runs WHERE source_message_id LIKE 'lms-it:%'`);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM matching_dubai.match_results WHERE source_message_id LIKE 'lms-it:%'`);
  await pool.query(`DELETE FROM matching_dubai.match_runs WHERE source_message_id LIKE 'lms-it:%'`);
});

function baseRunArgs(overrides = {}) {
  return {
    sourceMessageId: 'lms-it:1',
    provider: 'telegram',
    sourceUrl: 'https://t.me/example/1',
    groupName: 'Test Group',
    originalText: 'Need 2BR in Business Bay, budget up to 2.5M — exactly as written! 🏠',
    resultStatus: 'MATCH',
    parsedRequest: { message_class: 'buyer_request' },
    normalizedRequest: { area: 'Business Bay' },
    stockSyncedAt: null,
    activeStockCount: 10,
    candidatesCount: 1,
    matchesCount: 1,
    bestScore: 88,
    noMatchReason: null,
    parserVersion: 'lms-v1',
    matcherVersion: 'lms-v1',
    contentHash: 'abc123',
    requesterContactUrl: 'https://t.me/john',
    requesterSenderId: '1',
    requesterName: 'John',
    ...overrides,
  };
}

test('TZ 68/110: original_text and source_url persist 1:1, including emoji/punctuation', async () => {
  const run = await matchRepo.insertMatchRun(pool, baseRunArgs());
  const { rows } = await pool.query('SELECT * FROM matching_dubai.match_runs WHERE id = $1', [run.id]);
  assert.equal(rows[0].original_text, baseRunArgs().originalText);
  assert.equal(rows[0].source_url, baseRunArgs().sourceUrl);
  assert.equal(rows[0].provider, 'telegram');
  assert.equal(rows[0].group_name, 'Test Group');
});

test('ADR-046: account_id/chat_id persist -- this data used to be silently dropped (pipeline.js never passed it, the columns did not exist)', async () => {
  const run = await matchRepo.insertMatchRun(pool, baseRunArgs({ accountId: 'tg_main', chatId: '-1001932106227' }));
  const { rows } = await pool.query('SELECT account_id, chat_id FROM matching_dubai.match_runs WHERE id = $1', [run.id]);
  assert.equal(rows[0].account_id, 'tg_main');
  assert.equal(rows[0].chat_id, '-1001932106227');
});

test('TZ 72: the new result statuses are accepted by the (widened) CHECK constraint', async () => {
  for (const status of ['REJECTED', 'DUPLICATE', 'PARSER_ERROR', 'INSUFFICIENT_CRITERIA', 'NO_MATCH', 'MATCH']) {
    const run = await matchRepo.insertMatchRun(pool, baseRunArgs({ sourceMessageId: `lms-it:status-${status}`, resultStatus: status }));
    assert.ok(run.id);
  }
});

test('TZ 70: UNIQUE(source_message_id, stock_id) + UPSERT -- rerunning the same match updates, never duplicates', async () => {
  const sourceMessageId = baseRunArgs().sourceMessageId;
  const run = await matchRepo.insertMatchRun(pool, baseRunArgs());
  const entry = { stock: { stock_id: 'STK-X' }, score: { total: 70, components: { location: { score: 80 } } }, rank: 1 };

  await matchRepo.upsertMatchResult(pool, { matchRunId: run.id, sourceMessageId, entry, telegramPost: null, whatsappPost: null });
  const rerunEntry = { ...entry, score: { total: 95, components: { location: { score: 100 } } } };
  await matchRepo.upsertMatchResult(pool, { matchRunId: run.id, sourceMessageId, entry: rerunEntry, telegramPost: null, whatsappPost: null });

  const { rows } = await pool.query('SELECT * FROM matching_dubai.match_results WHERE source_message_id = $1 AND stock_id = $2', [sourceMessageId, 'STK-X']);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].match_score), 95);
});

test('checkDuplicate finds a content_hash inserted within the window, not one outside it', async () => {
  await matchRepo.insertMatchRun(pool, baseRunArgs({ sourceMessageId: 'lms-it:dup-1', contentHash: 'dup-hash-1' }));
  const isDup = await matchRepo.checkDuplicate(pool, { contentHash: 'dup-hash-1', windowHours: 48 });
  assert.equal(isDup, true);

  const notDup = await matchRepo.checkDuplicate(pool, { contentHash: 'never-inserted-hash', windowHours: 48 });
  assert.equal(notDup, false);
});

test('a NO_MATCH run never gets a match_results row -- persistence mirrors matcher output faithfully', async () => {
  const run = await matchRepo.insertMatchRun(pool, baseRunArgs({ sourceMessageId: 'lms-it:no-match', resultStatus: 'NO_MATCH', noMatchReason: 'no_stock_in_area', matchesCount: 0 }));
  const { rows } = await pool.query('SELECT * FROM matching_dubai.match_results WHERE match_run_id = $1', [run.id]);
  assert.equal(rows.length, 0);
});
