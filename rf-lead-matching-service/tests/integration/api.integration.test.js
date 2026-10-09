'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { buildServer } = require('../../src/api/server');

let pool;

// The real sourceRoutingGate (2026-09-29) now runs before anything else, so
// every test chat_id needs a real ingest.sources + ingest.source_routes row
// (route_modes=['RF'], monitoring on) or it is REJECTED at the transport
// level before ever reaching the gate/matcher this file actually exercises.
// (2026-10-06, migration 0041: route_mode -> route_modes array.)
async function seedRfRoute(chatId, provider = 'telegram') {
  const { rows } = await pool.query(
    `INSERT INTO ingest.sources (provider, account_id, external_source_id, name)
     VALUES ($1, '', $2, 'RF integration test fixture')
     ON CONFLICT (provider, account_id, external_source_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [provider, chatId]
  );
  await pool.query(
    `INSERT INTO ingest.source_routes (source_id, monitoring_enabled, route_modes)
     VALUES ($1, true, ARRAY['RF'])
     ON CONFLICT (source_id) DO UPDATE SET monitoring_enabled = true, route_modes = ARRAY['RF']`,
    [rows[0].id]
  );
}

const TEST_CHAT_IDS = ['-100rfit1', '123@g.us', '-100rfit2', '-100rfit3', '-100rfit4', '-100rfit5', '-100rfit6'];

before(async () => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await seedRfRoute('-100rfit1', 'telegram');
  await seedRfRoute('123@g.us', 'whatsapp');
  await seedRfRoute('-100rfit2', 'telegram');
  await seedRfRoute('-100rfit3', 'telegram');
  await seedRfRoute('-100rfit4', 'telegram');
  await seedRfRoute('-100rfit5', 'telegram');
  await seedRfRoute('-100rfit6', 'telegram');
});

after(async () => {
  await pool.query(`DELETE FROM matching_moscow.match_results WHERE source_message_id LIKE 'telegram:-100rfit%' OR source_message_id LIKE 'whatsapp:123@g.us%'`);
  await pool.query(`DELETE FROM matching_moscow.match_runs WHERE chat_id LIKE '-100rfit%' OR chat_id = '123@g.us'`);
  await pool.query(`DELETE FROM matching_moscow.stock_inventory WHERE joker_object_id IN (-900001, -900002)`);
  // The interpretation cache is keyed on (text_hash, interpreter_version) only
  // -- not scoped to chat_id -- so a rerun of this file against the SAME
  // disposable Postgres would otherwise reuse a stale cached parse from a
  // previous run instead of calling this run's fakeClassifyAndParse again.
  await pool.query(`DELETE FROM matching_moscow.message_interpretation_cache WHERE interpreter_version = 'rf-test-parser'`);
  await pool.query(
    `DELETE FROM ingest.sources WHERE external_source_id = ANY($1::text[])`,
    [TEST_CHAT_IDS]
  );
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM matching_moscow.match_results WHERE source_message_id LIKE 'telegram:-100rfit%' OR source_message_id LIKE 'whatsapp:123@g.us%'`);
  await pool.query(`DELETE FROM matching_moscow.match_runs WHERE chat_id LIKE '-100rfit%' OR chat_id = '123@g.us'`);
});

function buildTestApp(overrides = {}) {
  const config = { matcherVersion: 'rf-test', parserVersion: 'rf-test-parser', apiKey: 'test-key', logLevel: 'silent', aiCacheTtlDays: 14, telegramNotificationsEnabled: false, ...overrides.config };
  return buildServer({ pool, ...overrides, config });
}

test('GET /health reports the RF contour, matching_implemented=true (2026-09-29), and real DB connectivity', async () => {
  const app = buildTestApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.contour, 'RF');
  assert.equal(body.matching_implemented, true);
  assert.equal(body.database, 'ok');
  await app.close();
});

test('POST /v1/webhooks/telegram requires X-API-Key', async () => {
  const app = buildTestApp();
  const res = await app.inject({ method: 'POST', url: '/v1/webhooks/telegram', payload: { chat_id: '1', message_id: '1' } });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /v1/webhooks/telegram persists a real matching_moscow.match_runs row and returns NOT_IMPLEMENTED', async () => {
  const app = buildTestApp();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-api-key': 'test-key' },
    payload: { chat_id: '-100rfit1', message_id: '1', text: 'Ищу 3-комнатную в Москва, ЮЗАО, до 30 млн' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'NOT_IMPLEMENTED');

  const { rows } = await pool.query(`SELECT * FROM matching_moscow.match_runs WHERE id = $1`, [body.match_run_id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result_status, 'NOT_IMPLEMENTED');
  assert.equal(rows[0].original_text, 'Ищу 3-комнатную в Москва, ЮЗАО, до 30 млн');
  await app.close();
});

test('POST /v1/webhooks/whatsapp is also accepted (transport-symmetric with Telegram, per shared-ingress design)', async () => {
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

// ---- Gate ACTIVE end-to-end (2026-09-29) -- real matching_moscow.intake_rules
// seed data (migration 0029), toggled through the REAL config-repository
// draft/Apply path, exactly as an operator would via /settings?market=moscow.

const configRepo = require('../../src/repositories/config-repository');

test('cutover ON end-to-end: a real seeded BLACKLIST phrase is REJECTED, and OFF afterward restores exactly the prior NOT_IMPLEMENTED behavior', async () => {
  await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'true', enabled: true });
  const applied = await configRepo.applyDraft(pool, { note: 'test: enable Moscow gate', createdBy: 'test' });
  assert.ok(applied.ok, `applyDraft failed: ${applied.error}`);

  try {
    const app = buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-api-key': 'test-key' },
      // A real seeded BLACKLIST phrase (migration 0029): reused from UAE's
      // own BLACKLIST, "seller/landlord announcing their own listing".
      payload: { chat_id: '-100rfit2', message_id: '1', text: 'Сдам 2-комнатную квартиру в центре' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'REJECTED');
    assert.equal(body.reason, 'BLACKLIST');

    const { rows } = await pool.query(`SELECT * FROM matching_moscow.match_runs WHERE id = $1`, [body.match_run_id]);
    assert.equal(rows[0].result_status, 'REJECTED');
    assert.match(rows[0].reason, /GATE_REJECT: BLACKLIST/);
    await app.close();
  } finally {
    // Restore the seeded default (OFF) so this test never leaks state into
    // the other tests in this file/suite.
    await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'false', enabled: true });
    await configRepo.applyDraft(pool, { note: 'test: restore default (gate off)', createdBy: 'test' });
  }
});

// Fakes a resolved AI parse without a live OpenAI call -- the gate/AI-
// eligibility/alias/matcher/persistence chain downstream of it is 100% real
// (real disposable Postgres, real matching_moscow.* tables/config-repository).
function fakeClassifyAndParse(overrides = {}) {
  return async () => ({
    ok: true,
    value: {
      message_class: 'buyer_request', demand_owner: 'sender', promotion: false, spam: false,
      transaction_type: 'SALE', district: null, complex: null, property_type: null,
      rooms: null, rooms_sentinel: null, bedrooms_min: null, bedrooms_max: null,
      budget_min: null, budget_max: null, area_sqm_min: null, area_sqm_max: null,
      floor_min: null, floor_max: null, readiness_year: null, cash_buyer: null, confidence: 0.9,
      ...overrides,
    },
  });
}

test('cutover ON end-to-end: a real seeded WHITELIST phrase is approved by the gate and now reaches the real AI parser+matcher (2026-09-29) -- no location stated -> honest INSUFFICIENT_CRITERIA, never a fabricated match', async () => {
  await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'true', enabled: true });
  const applied = await configRepo.applyDraft(pool, { note: 'test: enable Moscow gate', createdBy: 'test' });
  assert.ok(applied.ok, `applyDraft failed: ${applied.error}`);

  try {
    const app = buildTestApp({ classifyAndParse: fakeClassifyAndParse() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-api-key': 'test-key' },
      // A real seeded WHITELIST phrase (migration 0029).
      payload: { chat_id: '-100rfit3', message_id: '1', text: 'Ищу для клиента 3-комнатную квартиру в ЮЗАО' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'INSUFFICIENT_CRITERIA');

    const { rows } = await pool.query(`SELECT * FROM matching_moscow.match_runs WHERE id = $1`, [body.match_run_id]);
    assert.equal(rows[0].result_status, 'INSUFFICIENT_CRITERIA');
    assert.equal(rows[0].no_match_reason, 'location_unspecified');
    await app.close();
  } finally {
    await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'false', enabled: true });
    await configRepo.applyDraft(pool, { note: 'test: restore default (gate off)', createdBy: 'test' });
  }
});

test('cutover ON end-to-end: a district named but not found anywhere in stock -> NO_MATCH (location_not_found), persisted with zero match_results', async () => {
  await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'true', enabled: true });
  const applied = await configRepo.applyDraft(pool, { note: 'test: enable Moscow gate', createdBy: 'test' });
  assert.ok(applied.ok, `applyDraft failed: ${applied.error}`);

  try {
    const app = buildTestApp({ classifyAndParse: fakeClassifyAndParse({ district: 'Округ-Которого-Не-Существует-Никогда', rooms: 2 }) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-api-key': 'test-key' },
      payload: { chat_id: '-100rfit4', message_id: '1', text: 'Ищу для клиента квартиру в несуществующем округе' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'NO_MATCH');
    assert.equal(body.reason, 'location_not_found');

    const { rows: runRows } = await pool.query(`SELECT * FROM matching_moscow.match_runs WHERE id = $1`, [body.match_run_id]);
    assert.equal(runRows[0].result_status, 'NO_MATCH');
    const { rows: resultRows } = await pool.query(`SELECT * FROM matching_moscow.match_results WHERE match_run_id = $1`, [body.match_run_id]);
    assert.equal(resultRows.length, 0);
    await app.close();
  } finally {
    await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'false', enabled: true });
    await configRepo.applyDraft(pool, { note: 'test: restore default (gate off)', createdBy: 'test' });
  }
});

test('cutover ON end-to-end: a real surviving stock row -> MATCH creates match_runs + match_results, and a reprocessing rerun UPSERTs the same pair instead of duplicating', async () => {
  await pool.query(
    `INSERT INTO matching_moscow.stock_inventory (joker_object_id, available, deal_type, property_type, property_type_excluded, district, complex, rooms, price)
     VALUES (-900001, true, 'sale', 'Квартира', false, 'Юго-Западный административный округ', NULL, 2, 14000000)
     ON CONFLICT (joker_object_id) DO UPDATE SET available = true, district = EXCLUDED.district, rooms = EXCLUDED.rooms, price = EXCLUDED.price`
  );

  await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'true', enabled: true });
  const applied = await configRepo.applyDraft(pool, { note: 'test: enable Moscow gate', createdBy: 'test' });
  assert.ok(applied.ok, `applyDraft failed: ${applied.error}`);

  try {
    const app = buildTestApp({
      classifyAndParse: fakeClassifyAndParse({ district: 'Юго-Западный административный округ', rooms: 2, budget_max: 15000000 }),
    });

    const payload = { chat_id: '-100rfit5', message_id: '1', text: 'Ищу для клиента 2-комнатную в ЮЗАО до 15 млн' };
    const res1 = await app.inject({ method: 'POST', url: '/v1/webhooks/telegram', headers: { 'x-api-key': 'test-key' }, payload });
    const body1 = res1.json();
    assert.equal(body1.status, 'MATCH');
    assert.equal(body1.matches.length, 1);

    const { rows: resultRows } = await pool.query(`SELECT * FROM matching_moscow.match_results WHERE match_run_id = $1`, [body1.match_run_id]);
    assert.equal(resultRows.length, 1);
    assert.equal(Number(resultRows[0].stock_joker_object_id), -900001);

    // Reprocess: same chat_id/message_id (same source_message_id) but a
    // slightly edited text (different content_hash), so this bypasses the
    // content-dedup DUPLICATE short-circuit and genuinely reaches the
    // matcher/persistence layer a second time -- exactly the case the
    // match_results UNIQUE(source_message_id, stock_joker_object_id)
    // constraint exists for (a message-edit redelivery, not a verbatim resend).
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-api-key': 'test-key' },
      payload: { ...payload, text: `${payload.text} срочно` },
    });
    const body2 = res2.json();
    assert.equal(body2.status, 'MATCH');

    const { rows: allResults } = await pool.query(
      `SELECT * FROM matching_moscow.match_results WHERE source_message_id = $1`,
      [`telegram:-100rfit5:1`]
    );
    assert.equal(allResults.length, 1, 'a rerun must UPSERT the same (source_message_id, stock) pair, never duplicate it');
    await app.close();
  } finally {
    await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'false', enabled: true });
    await configRepo.applyDraft(pool, { note: 'test: restore default (gate off)', createdBy: 'test' });
  }
});

test('cutover ON end-to-end: a RENT buyer request ("сниму" -- the whitelist gap fixed by the RF rental-enablement plan) -> MATCH against real rent stock, never cross-matched against sale stock', async () => {
  await pool.query(
    `INSERT INTO matching_moscow.stock_inventory (joker_object_id, available, deal_type, property_type, property_type_excluded, district, complex, rooms, price)
     VALUES (-900002, true, 'rent', 'Квартира', false, 'Юго-Западный административный округ', NULL, 2, 65000)
     ON CONFLICT (joker_object_id) DO UPDATE SET available = true, deal_type = 'rent', district = EXCLUDED.district, rooms = EXCLUDED.rooms, price = EXCLUDED.price`
  );

  await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'true', enabled: true });
  const applied = await configRepo.applyDraft(pool, { note: 'test: enable Moscow gate', createdBy: 'test' });
  assert.ok(applied.ok, `applyDraft failed: ${applied.error}`);

  try {
    const app = buildTestApp({
      classifyAndParse: fakeClassifyAndParse({
        transaction_type: 'RENT', district: 'Юго-Западный административный округ', rooms: 2, budget_max: 70000,
      }),
    });

    // Real "сниму" text -- exercises the new WHITELIST phrase through the
    // actual gate, not just a stubbed classification result.
    const payload = { chat_id: '-100rfit6', message_id: '1', text: 'Сниму 2-комнатную в ЮЗАО, бюджет до 70 тысяч' };
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks/telegram', headers: { 'x-api-key': 'test-key' }, payload });
    const body = res.json();
    assert.equal(body.status, 'MATCH');
    assert.equal(body.matches.length, 1);

    const { rows: resultRows } = await pool.query(`SELECT * FROM matching_moscow.match_results WHERE match_run_id = $1`, [body.match_run_id]);
    assert.equal(resultRows.length, 1);
    assert.equal(Number(resultRows[0].stock_joker_object_id), -900002, 'must match the RENT stock row, not the SALE fixture from the previous test');
    await app.close();
  } finally {
    await configRepo.updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'false', enabled: true });
    await configRepo.applyDraft(pool, { note: 'test: restore default (gate off)', createdBy: 'test' });
  }
});

test('isolation: RF service source never SQL-references the Dubai contour schemas', async () => {
  const fs = require('fs');
  const path = require('path');
  const sourceFiles = [
    '../../src/services/pipeline.js',
    '../../src/repositories/match-repository.js',
    '../../src/api/server.js',
  ].map((p) => fs.readFileSync(path.join(__dirname, p), 'utf8'));
  const forbidden = /\bmatching\s*\.\s*\w|\bmatching_dubai\s*\./;
  for (const source of sourceFiles) {
    // Strip // line comments first -- this check is about real code (a
    // SQL string referencing the UAE schema), not prose that happens to
    // mention the forbidden pattern while explaining the isolation rule.
    const codeOnly = source
      .split('\n')
      .map((line) => line.replace(/\/\/.*/, ''))
      .join('\n');
    assert.ok(!forbidden.test(codeOnly), 'RF service source must never reference matching.* / matching_dubai. (Dubai contour schemas)');
  }
});
