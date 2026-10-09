'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { buildServer } = require('../../src/api/server');

let pool;

// The real sourceRoutingGate runs before anything else, so every test
// chat_id needs a real ingest.sources + ingest.source_routes row
// (route_modes=['ABU_DHABI'], monitoring on) or it is REJECTED at the
// transport level before ever reaching the gate/matcher this file exercises.
// (2026-10-06, migration 0041: route_mode -> route_modes array.)
async function seedAbuDhabiRoute(chatId, provider = 'telegram') {
  const { rows } = await pool.query(
    `INSERT INTO ingest.sources (provider, account_id, external_source_id, name)
     VALUES ($1, '', $2, 'Abu Dhabi integration test fixture')
     ON CONFLICT (provider, account_id, external_source_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [provider, chatId]
  );
  await pool.query(
    `INSERT INTO ingest.source_routes (source_id, monitoring_enabled, route_modes)
     VALUES ($1, true, ARRAY['ABU_DHABI'])
     ON CONFLICT (source_id) DO UPDATE SET monitoring_enabled = true, route_modes = ARRAY['ABU_DHABI']`,
    [rows[0].id]
  );
}

const TEST_CHAT_IDS = ['-100adit1', '123@g.us', '-100adit2', '-100adit3', '-100adit4', '-100adit5'];

before(async () => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await seedAbuDhabiRoute('-100adit1', 'telegram');
  await seedAbuDhabiRoute('123@g.us', 'whatsapp');
  await seedAbuDhabiRoute('-100adit2', 'telegram');
  await seedAbuDhabiRoute('-100adit3', 'telegram');
  await seedAbuDhabiRoute('-100adit4', 'telegram');
  await seedAbuDhabiRoute('-100adit5', 'telegram');
});

after(async () => {
  await pool.query(`DELETE FROM matching_abu_dhabi.match_results WHERE source_message_id LIKE 'telegram:-100adit%' OR source_message_id LIKE 'whatsapp:123@g.us%'`);
  await pool.query(`DELETE FROM matching_abu_dhabi.match_runs WHERE source_message_id LIKE 'telegram:-100adit%' OR source_message_id LIKE 'whatsapp:123@g.us%'`);
  await pool.query(`DELETE FROM matching_abu_dhabi.stock_inventory WHERE stock_id IN ('AD-TEST-1')`);
  // The interpretation cache is keyed on (text_hash, interpreter_version)
  // only -- not scoped to chat_id -- so a rerun of this file against the
  // SAME disposable Postgres would otherwise reuse a stale cached parse
  // from a previous run instead of calling this run's fakeClassifyAndParse.
  await pool.query(`DELETE FROM matching_abu_dhabi.message_interpretation_cache WHERE interpreter_version = 'abu-dhabi-test-parser'`);
  await pool.query(
    `DELETE FROM ingest.sources WHERE external_source_id = ANY($1::text[])`,
    [TEST_CHAT_IDS]
  );
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM matching_abu_dhabi.match_results WHERE source_message_id LIKE 'telegram:-100adit%' OR source_message_id LIKE 'whatsapp:123@g.us%'`);
  await pool.query(`DELETE FROM matching_abu_dhabi.match_runs WHERE source_message_id LIKE 'telegram:-100adit%' OR source_message_id LIKE 'whatsapp:123@g.us%'`);
});

function buildTestApp(overrides = {}) {
  const config = { matcherVersion: 'abu-dhabi-test', parserVersion: 'abu-dhabi-test-parser', apiKey: 'test-key', logLevel: 'silent', aiCacheTtlDays: 14, telegramNotificationsEnabled: false, ...overrides.config };
  return buildServer({ pool, ...overrides, config });
}

test('GET /health reports the ABU_DHABI contour and real DB connectivity', async () => {
  const app = buildTestApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.contour, 'ABU_DHABI');
  assert.equal(body.database, 'ok');
  await app.close();
});

test('POST /v1/webhooks/telegram requires X-API-Key', async () => {
  const app = buildTestApp();
  const res = await app.inject({ method: 'POST', url: '/v1/webhooks/telegram', payload: { chat_id: '1', message_id: '1' } });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/webhooks/telegram persists a real matching_abu_dhabi.match_runs row and returns NOT_IMPLEMENTED (cutover OFF, the seeded default)', async () => {
  const app = buildTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: '-100adit1', message_id: '1', text: 'Looking for a 3BR in Al Reem Island up to 3M' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'NOT_IMPLEMENTED');

  const { rows } = await pool.query(`SELECT * FROM matching_abu_dhabi.match_runs WHERE id = $1`, [body.match_run_id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result_status, 'NOT_IMPLEMENTED');
  assert.equal(rows[0].original_text, 'Looking for a 3BR in Al Reem Island up to 3M');
  await app.close();
});

test('POST /v1/webhooks/whatsapp is also accepted (transport-symmetric with Telegram)', async () => {
  const app = buildTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/whatsapp',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: '123@g.us', message_id: '1', text: 'test' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'NOT_IMPLEMENTED');
  await app.close();
});

// ---- Gate ACTIVE end-to-end -- real matching_abu_dhabi.intake_rules seed
// data (migration 0038), toggled through the REAL config-repository
// draft/Apply path, exactly as an operator would via /settings?market=abu_dhabi.

const configRepo = require('../../src/repositories/config-repository');

test('cutover ON end-to-end: a real seeded BLACKLIST phrase is REJECTED, and OFF afterward restores exactly the prior NOT_IMPLEMENTED behavior', async () => {
  await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'true', enabled: true });
  const applied = await configRepo.applyDraft(pool, { note: 'test: enable Abu Dhabi gate', createdBy: 'test' });
  assert.ok(applied.ok, `applyDraft failed: ${applied.error}`);

  try {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-api-key': 'test-key' },
      // A real seeded BLACKLIST phrase (migration 0038, broker-solicitation pattern).
      payload: { chat_id: '-100adit2', message_id: '1', text: 'Do you have a buyer for a 2BR in Al Reem?' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'REJECTED');
    assert.equal(body.reason, 'BLACKLIST');

    const { rows } = await pool.query(`SELECT * FROM matching_abu_dhabi.match_runs WHERE id = $1`, [body.match_run_id]);
    assert.equal(rows[0].result_status, 'REJECTED');
    assert.match(rows[0].reason, /GATE_REJECT: BLACKLIST/);
    await app.close();
  } finally {
    await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'false', enabled: true });
    await configRepo.applyDraft(pool, { note: 'test: restore default (gate off)', createdBy: 'test' });
  }
});

// Fakes a resolved AI parse without a live OpenAI call -- the gate/AI-
// eligibility/alias/matcher/persistence chain downstream of it is 100% real
// (real disposable Postgres, real matching_abu_dhabi.* tables/config-repository).
function fakeClassifyAndParse(overrides = {}) {
  return async () => ({
    ok: true,
    value: {
      message_class: 'buyer_request', demand_owner: 'sender', promotion: false, spam: false,
      transaction_type: 'SALE', area: null, areas: [], project: null, building: null,
      property_type: null, bedrooms_min: null, bedrooms_max: null, budget_min: null,
      budget_max: null, furnishing: null, cash_buyer: null, confidence: 0.9,
      ...overrides,
    },
  });
}

test('cutover ON end-to-end: a real seeded WHITELIST+PROPERTY_SIGNAL hit is approved by the gate and reaches the real AI parser+matcher -- no location stated -> honest INSUFFICIENT_CRITERIA, never a fabricated match', async () => {
  await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'true', enabled: true });
  const applied = await configRepo.applyDraft(pool, { note: 'test: enable Abu Dhabi gate', createdBy: 'test' });
  assert.ok(applied.ok, `applyDraft failed: ${applied.error}`);

  try {
    const app = buildTestApp({ classifyAndParse: fakeClassifyAndParse() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-api-key': 'test-key' },
      // WHITELIST ("looking for") + PROPERTY_SIGNAL ("3br") -- both seeded, migration 0038.
      payload: { chat_id: '-100adit3', message_id: '1', text: 'Looking for a client, needs a 3br apartment' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'INSUFFICIENT_CRITERIA');

    const { rows } = await pool.query(`SELECT * FROM matching_abu_dhabi.match_runs WHERE id = $1`, [body.match_run_id]);
    assert.equal(rows[0].result_status, 'INSUFFICIENT_CRITERIA');
    assert.equal(rows[0].no_match_reason, 'location_unspecified');
    await app.close();
  } finally {
    await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'false', enabled: true });
    await configRepo.applyDraft(pool, { note: 'test: restore default (gate off)', createdBy: 'test' });
  }
});

test('cutover ON end-to-end: an area named but not found anywhere in stock -> NO_MATCH (location_not_found), persisted with zero match_results', async () => {
  await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'true', enabled: true });
  const applied = await configRepo.applyDraft(pool, { note: 'test: enable Abu Dhabi gate', createdBy: 'test' });
  assert.ok(applied.ok, `applyDraft failed: ${applied.error}`);

  try {
    const app = buildTestApp({
      classifyAndParse: fakeClassifyAndParse({ area: 'An Area That Does Not Exist', areas: ['An Area That Does Not Exist'], bedrooms_min: 2, bedrooms_max: 2 }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-api-key': 'test-key' },
      payload: { chat_id: '-100adit4', message_id: '1', text: 'Looking for a client, needs a 2br in a nonexistent area' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'NO_MATCH');
    assert.equal(body.reason, 'location_not_found');

    const { rows: runRows } = await pool.query(`SELECT * FROM matching_abu_dhabi.match_runs WHERE id = $1`, [body.match_run_id]);
    assert.equal(runRows[0].result_status, 'NO_MATCH');
    const { rows: resultRows } = await pool.query(`SELECT * FROM matching_abu_dhabi.match_results WHERE match_run_id = $1`, [body.match_run_id]);
    assert.equal(resultRows.length, 0);
    await app.close();
  } finally {
    await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'false', enabled: true });
    await configRepo.applyDraft(pool, { note: 'test: restore default (gate off)', createdBy: 'test' });
  }
});

test('cutover ON end-to-end: a real surviving stock row -> MATCH creates match_runs + match_results, and a reprocessing rerun UPSERTs the same pair instead of duplicating', async () => {
  await pool.query(
    `INSERT INTO matching_abu_dhabi.stock_inventory (stock_id, status, transaction_type, area, project_community, building, bedrooms, property_type, selling_price)
     VALUES ('AD-TEST-1', 'ACTIVE', 'SALE', 'Al Reem Island', 'Al Reem Island', 'Sky Tower', 2, 'Apartment', 1400000)
     ON CONFLICT (stock_id) DO UPDATE SET status = 'ACTIVE', area = EXCLUDED.area, bedrooms = EXCLUDED.bedrooms, selling_price = EXCLUDED.selling_price`
  );

  await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'true', enabled: true });
  const applied = await configRepo.applyDraft(pool, { note: 'test: enable Abu Dhabi gate', createdBy: 'test' });
  assert.ok(applied.ok, `applyDraft failed: ${applied.error}`);

  try {
    const app = buildTestApp({
      classifyAndParse: fakeClassifyAndParse({ area: 'Al Reem Island', areas: ['Al Reem Island'], bedrooms_min: 2, bedrooms_max: 2, budget_max: 1500000 }),
    });

    const payload = { chat_id: '-100adit5', message_id: '1', text: 'Looking for a client, needs a 2br in Al Reem Island up to 1.5M' };
    const res1 = await app.inject({ method: 'POST', url: '/v1/webhooks/telegram', headers: { 'x-api-key': 'test-key' }, payload });
    const body1 = res1.json();
    assert.equal(body1.status, 'MATCH');
    assert.equal(body1.matches.length, 1);

    const { rows: resultRows } = await pool.query(`SELECT * FROM matching_abu_dhabi.match_results WHERE match_run_id = $1`, [body1.match_run_id]);
    assert.equal(resultRows.length, 1);
    assert.equal(resultRows[0].stock_id, 'AD-TEST-1');

    // Reprocess: same chat_id/message_id (same source_message_id) but a
    // slightly edited text (different content_hash), so this bypasses the
    // content-dedup DUPLICATE short-circuit and genuinely reaches the
    // matcher/persistence layer a second time.
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-api-key': 'test-key' },
      payload: { ...payload, text: `${payload.text} urgent` },
    });
    const body2 = res2.json();
    assert.equal(body2.status, 'MATCH');

    const { rows: allResults } = await pool.query(
      `SELECT * FROM matching_abu_dhabi.match_results WHERE source_message_id = $1`,
      [`telegram:-100adit5:1`]
    );
    assert.equal(allResults.length, 1, 'a rerun must UPSERT the same (source_message_id, stock) pair, never duplicate it');
    await app.close();
  } finally {
    await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'false', enabled: true });
    await configRepo.applyDraft(pool, { note: 'test: restore default (gate off)', createdBy: 'test' });
  }
});

test('isolation: the Abu Dhabi service source never SQL-references the Dubai or RF contour schemas', async () => {
  const fs = require('fs');
  const path = require('path');
  const sourceFiles = [
    '../../src/services/pipeline.js',
    '../../src/repositories/match-repository.js',
    '../../src/api/server.js',
    '../../src/gates/source-routing.js',
  ].map((p) => fs.readFileSync(path.join(__dirname, p), 'utf8'));
  const forbidden = /\bmatching_dubai\s*\.|\bmatching_moscow\s*\./;
  for (const source of sourceFiles) {
    // Strip // line comments first -- this check is about real code (a SQL
    // string referencing another contour's schema), not prose explaining
    // the isolation rule.
    const codeOnly = source
      .split('\n')
      .map((line) => line.replace(/\/\/.*/, ''))
      .join('\n');
    assert.ok(!forbidden.test(codeOnly), 'Abu Dhabi service source must never reference matching_dubai./matching_moscow. (other contours\' schemas)');
  }
});
