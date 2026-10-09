'use strict';

// Nika Matching V2, Phase 3 integration tests (AGENTS_NIKA_MATCHING_V2.md
// section 26, Phase 3, requirement 15). Exercises the real migration 0022
// against a disposable Postgres (applied by scripts/run-integration-tests.js
// before this file runs), the real Phase 1/1.1 seeded config, and the real
// orchestrator (services/shadow-evaluator.js) end to end -- proves
// persistence, disagreement classification, config-version attribution
// (draft edits must NEVER leak into a shadow evaluation, only an Apply may),
// and non-blocking failure isolation.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { loadActiveV2Config, updateDraftSetting, applyDraft } = require('../../src/repositories/config-repository');
const { evaluateShadowGate } = require('../../src/services/shadow-evaluator');
const { runWebhookPipeline } = require('../../src/services/pipeline');

let pool;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  await pool.end();
});

async function fetchRow(id) {
  const { rows } = await pool.query('SELECT * FROM matching_dubai.shadow_gate_evaluations WHERE id = $1', [id]);
  return rows[0];
}

test('shadow row is persisted with the correct old/v2 decisions and is attributed to the ACTIVE config version', async () => {
  const cfg = await loadActiveV2Config(pool);
  const deps = { pool, getActiveV2Config: () => loadActiveV2Config(pool) };

  const insert = await evaluateShadowGate({
    unifiedMessage: { source_message_id: 'shadow-it:1', provider: 'telegram', account_id: 'a', chat_id: 'c', sender_id: 's', original_text: 'a message with no rule-matching content at all zzz' },
    log: { interpretation_source: 'ai' },
    deps,
  });
  const row = await fetchRow(insert.id);
  assert.equal(row.old_decision, 'SEND_TO_AI');
  assert.equal(row.v2_decision, 'REJECT');
  assert.equal(row.disagreement, true);
  assert.equal(row.projected_ai_saved, true);
  assert.equal(row.projected_ai_added, false);
  assert.equal(String(row.config_version_id), String(cfg.configVersionId));
});

test('projected_ai_added is true only for a genuinely NEW old-non-AI -> V2 SEND_TO_AI case, never for old CACHE_HIT_AI', async () => {
  const deps = { pool, getActiveV2Config: () => loadActiveV2Config(pool) };
  const text = 'I need a 2BR apartment, budget 1.2M';

  const localInsert = await evaluateShadowGate({
    unifiedMessage: { source_message_id: 'shadow-it:2', provider: 'telegram', original_text: text },
    log: { interpretation_source: 'local' },
    deps,
  });
  const localRow = await fetchRow(localInsert.id);
  assert.equal(localRow.old_decision, 'PARSED_LOCALLY');
  assert.equal(localRow.v2_decision, 'SEND_TO_AI');
  assert.equal(localRow.projected_ai_added, true);

  const cacheInsert = await evaluateShadowGate({
    unifiedMessage: { source_message_id: 'shadow-it:3', provider: 'telegram', original_text: text },
    log: { interpretation_source: 'cache_ai' },
    deps,
  });
  const cacheRow = await fetchRow(cacheInsert.id);
  assert.equal(cacheRow.old_decision, 'CACHE_HIT_AI');
  assert.equal(cacheRow.v2_decision, 'SEND_TO_AI');
  assert.equal(cacheRow.projected_ai_added, false, 'a cache hit already paid for this content once -- V2 sending it again is not NEW spend');
});

test('draft config edits do NOT affect the shadow result -- only an Apply does', async () => {
  const before = await loadActiveV2Config(pool);
  const beforeThreshold = before.settings.whitelist_threshold.value;

  // Edit the DRAFT only (never applied yet).
  const draftEdit = await updateDraftSetting(pool, 'whitelist_threshold', { valueText: '99', enabled: true });
  assert.equal(draftEdit.ok, true);

  const deps = { pool, getActiveV2Config: () => loadActiveV2Config(pool) };
  const stillActive = await deps.getActiveV2Config();
  assert.equal(stillActive.settings.whitelist_threshold.value, beforeThreshold, 'a draft edit must never leak into the ACTIVE config the shadow gate reads');

  const preApplyInsert = await evaluateShadowGate({
    unifiedMessage: { source_message_id: 'shadow-it:4', provider: 'telegram', original_text: 'I need a 2BR apartment' },
    log: { interpretation_source: 'local' },
    deps,
  });
  const preApplyRow = await fetchRow(preApplyInsert.id);
  assert.equal(preApplyRow.v2_decision, 'SEND_TO_AI', 'threshold is still the real (low) active one before Apply');

  // Now Apply -- the draft's threshold=99 becomes the new active version.
  const applyResult = await applyDraft(pool, { note: 'phase 3 test: raise whitelist threshold', createdBy: 'phase3-test' });
  assert.equal(applyResult.ok, true);

  const afterApply = await deps.getActiveV2Config();
  assert.equal(afterApply.settings.whitelist_threshold.value, 99);

  const postApplyInsert = await evaluateShadowGate({
    unifiedMessage: { source_message_id: 'shadow-it:5', provider: 'telegram', original_text: 'I need a 2BR apartment' },
    log: { interpretation_source: 'local' },
    deps,
  });
  const postApplyRow = await fetchRow(postApplyInsert.id);
  assert.equal(postApplyRow.v2_decision, 'REJECT', 'with whitelist_threshold=99, a single whitelist hit is no longer enough');
  assert.equal(String(postApplyRow.config_version_id), String(afterApply.configVersionId));
  assert.notEqual(String(postApplyRow.config_version_id), String(preApplyRow.config_version_id));

  // Restore the threshold so later tests in this file (and any that run
  // after it) see the original, documented seed value again.
  const restoreEdit = await updateDraftSetting(pool, 'whitelist_threshold', { valueText: String(beforeThreshold), enabled: true });
  assert.equal(restoreEdit.ok, true);
  const restoreApply = await applyDraft(pool, { note: 'phase 3 test: restore whitelist threshold', createdBy: 'phase3-test' });
  assert.equal(restoreApply.ok, true);
});

test('an event-duplicate outcome shortcuts to a trivial DUPLICATE/DUPLICATE shadow row without loading config', async () => {
  let configLoadCalls = 0;
  const deps = { pool, getActiveV2Config: async () => { configLoadCalls += 1; return loadActiveV2Config(pool); } };
  const insert = await evaluateShadowGate({
    unifiedMessage: { source_message_id: 'shadow-it:6', provider: 'telegram', original_text: 'irrelevant' },
    log: { event_duplicate: true },
    deps,
  });
  const row = await fetchRow(insert.id);
  assert.equal(row.old_decision, 'DUPLICATE');
  assert.equal(row.v2_decision, 'DUPLICATE');
  assert.equal(row.config_version_id, null);
  assert.equal(configLoadCalls, 0);
});

test('live routing is unaffected end-to-end: runWebhookPipeline via a real Telegram webhook still returns the real result, and a shadow row is persisted alongside it', async () => {
  const eventDedupRepo = require('../../src/repositories/event-dedup-repository');
  const matchRepo = require('../../src/repositories/match-repository');
  const aiUsageRepo = require('../../src/repositories/ai-usage-repository');
  const interpretationCacheRepo = require('../../src/repositories/interpretation-cache-repository');
  const { loadAliasIndex } = require('../../src/repositories/alias-repository');
  const { loadCanonicalRegistry } = require('../../src/repositories/canonical-registry-repository');
  const { buildLocationDictionary } = require('../../src/matching/location-dictionary');
  const { makeStockRepository } = require('../../src/repositories/stock-repository');

  const [aliasIndex, canonicalRegistry] = await Promise.all([loadAliasIndex(pool), loadCanonicalRegistry(pool)]);
  const locationDictionary = buildLocationDictionary({ aliasIndex, canonicalRegistry });

  const events = [];
  const deps = {
    config: { parserVersion: 'test-v1', matcherVersion: 'test-v1', dedupWindowHours: 24, interpretationCacheTtlDays: 30, matchDebug: false },
    pool,
    stockRepo: makeStockRepository(pool),
    matchRepo,
    aiUsageRepo,
    eventDedupRepo,
    interpretationCacheRepo,
    classifyAndParse: async () => { throw new Error('this scenario must never reach AI -- it is a deterministic REJECT'); },
    getAliasIndex: async () => aliasIndex,
    getLocationDictionary: async () => locationDictionary,
    getActiveV2Config: () => loadActiveV2Config(pool),
    evaluateShadowGate,
    logEvent: (fields) => events.push(fields),
  };

  const result = await runWebhookPipeline({
    rawPayload: {
      chat_id: 'shadow-it-e2e-chat',
      message_id: 'shadow-it-e2e-msg-1',
      text: "Have a client looking to BUY or RENT in Emaar Beachfront?\nSend us your requirements — we'll find the right option for you.\nAGENTS ARE ALWAYS WELCOME!\nSend me your client's requirements now:",
      sender_username: 'broker1',
    },
    provider: 'telegram',
    deps,
  });

  assert.equal(result.status, 'REJECTED', 'the real pipeline result must be exactly what triage.js already decides today');

  const { rows } = await pool.query(
    'SELECT * FROM matching_dubai.shadow_gate_evaluations WHERE source_message_id = $1',
    [result.request_id]
  );
  assert.equal(rows.length, 1, 'exactly one shadow row must be persisted for this real webhook request');
  assert.equal(rows[0].old_decision, 'REJECT_WITHOUT_AI', 'a deterministic triage.js REJECT is REJECT_WITHOUT_AI, distinct from PARSED_LOCALLY');
});

test('a shadow config-load failure never breaks the real pipeline result', async () => {
  const eventDedupRepo = require('../../src/repositories/event-dedup-repository');
  const matchRepo = require('../../src/repositories/match-repository');
  const aiUsageRepo = require('../../src/repositories/ai-usage-repository');
  const interpretationCacheRepo = require('../../src/repositories/interpretation-cache-repository');
  const { loadAliasIndex } = require('../../src/repositories/alias-repository');
  const { loadCanonicalRegistry } = require('../../src/repositories/canonical-registry-repository');
  const { buildLocationDictionary } = require('../../src/matching/location-dictionary');
  const { makeStockRepository } = require('../../src/repositories/stock-repository');

  const [aliasIndex, canonicalRegistry] = await Promise.all([loadAliasIndex(pool), loadCanonicalRegistry(pool)]);
  const locationDictionary = buildLocationDictionary({ aliasIndex, canonicalRegistry });

  const loggedEvents = [];
  const deps = {
    config: { parserVersion: 'test-v1', matcherVersion: 'test-v1', dedupWindowHours: 24, interpretationCacheTtlDays: 30, matchDebug: false },
    pool,
    stockRepo: makeStockRepository(pool),
    matchRepo,
    aiUsageRepo,
    eventDedupRepo,
    interpretationCacheRepo,
    classifyAndParse: async () => { throw new Error('must never reach AI'); },
    getAliasIndex: async () => aliasIndex,
    getLocationDictionary: async () => locationDictionary,
    getActiveV2Config: async () => { throw new Error('simulated config load failure'); },
    evaluateShadowGate,
    logEvent: (fields) => loggedEvents.push(fields),
  };

  const result = await runWebhookPipeline({
    rawPayload: {
      chat_id: 'shadow-it-e2e-chat-2',
      message_id: 'shadow-it-e2e-msg-2',
      text: "Have a client looking to BUY or RENT in Emaar Beachfront?\nSend us your requirements — we'll find the right option for you.\nAGENTS ARE ALWAYS WELCOME!\nSend me your client's requirements now:",
      sender_username: 'broker2',
    },
    provider: 'telegram',
    deps,
  });

  assert.equal(result.status, 'REJECTED', 'a broken shadow config load must never prevent the real, correctly-decided result from returning');
  const shadowFailureLogged = loggedEvents.some((e) => e.event === 'shadow_gate_failed');
  assert.equal(shadowFailureLogged, true, 'the shadow failure should still be observable in logs');
});
