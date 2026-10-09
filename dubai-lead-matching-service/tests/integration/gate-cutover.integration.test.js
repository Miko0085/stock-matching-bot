'use strict';

// Nika Matching V2, Phase 4 (AGENTS_NIKA_MATCHING_V2.md section 26, Phase
// 4). Integration tests against the real migration 0023 (applied by
// scripts/run-integration-tests.js before this file runs): migration
// correctness, Draft -> Apply -> Rollback for the two new settings, and a
// real end-to-end authoritative pipeline run proving config-version
// coherence and AI zero-call behavior against the live database.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const {
  getActiveRuntimeSettings,
  getCurrentConfigVersion,
  loadActiveV2Config,
  getOrInitDraft,
  discardDraft,
  updateDraftSetting,
  applyDraft,
  rollbackToVersion,
} = require('../../src/repositories/config-repository');
const { evaluateAuthoritativeGate } = require('../../src/services/shadow-evaluator');

let pool;

// Test-file self-sufficiency: other integration files in this same run
// (config-draft.integration.test.js) legitimately roll back to version 1
// as part of THEIR OWN coverage -- version 1 predates migration 0023, so
// that rollback correctly wipes v2_intake_cutover_enabled/
// buyer_signal_policy from the live tables as a side effect (that is
// exactly what "never mutates history, restores exactly that version's
// state" is supposed to do). Rather than depend on file execution order
// across the whole suite, this file re-establishes its own precondition
// directly: if the two settings are missing, insert them (idempotent,
// mirrors migration 0023's own seed) and Apply once so a real,
// consistent config_version exists that actually contains them.
async function ensurePhase4SettingsSeeded() {
  const { rows } = await pool.query(`SELECT 1 FROM matching_dubai.runtime_settings WHERE key = 'v2_intake_cutover_enabled'`);
  if (rows.length) return;
  await pool.query(
    `INSERT INTO matching_dubai.runtime_settings (key, value_type, value_text, enabled, updated_by) VALUES
       ('v2_intake_cutover_enabled', 'boolean', 'false', true, 'test:gate-cutover'),
       ('buyer_signal_policy', 'text', 'REQUIRE_BOTH', true, 'test:gate-cutover')
     ON CONFLICT (key) DO NOTHING`
  );
  // The draft singleton (if one already existed from earlier Phase 2
  // tests) was initialized from the OLD real-table state and would
  // otherwise overwrite the rows just inserted above with its own stale
  // copy on Apply -- discard it first so it re-syncs from the current
  // real tables.
  await discardDraft(pool);
  const apply = await applyDraft(pool, { note: 'test setup: re-seed Phase 4 settings after an unrelated rollback wiped them', createdBy: 'test:gate-cutover' });
  assert.equal(apply.ok, true, apply.error);
}

before(async () => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await ensurePhase4SettingsSeeded();
});

after(async () => {
  await pool.end();
});

test('migration 0023: v2_intake_cutover_enabled and buyer_signal_policy exist with safe defaults', async () => {
  const settings = await getActiveRuntimeSettings(pool);
  assert.equal(settings.v2_intake_cutover_enabled.value, false, 'must default OFF after deployment');
  assert.equal(settings.buyer_signal_policy.value, 'REQUIRE_BOTH', 'must default to the original AND behavior, not the emergency OR');
});

test('migration 0023: ai_intake_gate_enabled is untouched -- never reinterpreted as the cutover flag', async () => {
  const settings = await getActiveRuntimeSettings(pool);
  assert.ok(settings.ai_intake_gate_enabled, 'the pre-existing Phase 1 setting still exists, unchanged');
  assert.notEqual(settings.ai_intake_gate_enabled, settings.v2_intake_cutover_enabled, 'these must be two distinct settings');
});

test('migration 0023: existing runtime_settings/intake_rules were re-stamped to the new version, and the new version snapshot includes all of them', async () => {
  const current = await getCurrentConfigVersion(pool);
  assert.ok(current.version_number >= 2, 'migration 0023 bumps the version at least once past the Phase 1 seed');
  const settingsInSnapshot = current.snapshot.runtime_settings.map((s) => s.key);
  assert.ok(settingsInSnapshot.includes('v2_intake_cutover_enabled'));
  assert.ok(settingsInSnapshot.includes('buyer_signal_policy'));
  assert.ok(settingsInSnapshot.includes('whitelist_threshold'), 'pre-existing Phase 1 settings are still present in the new snapshot');
  assert.equal(current.snapshot.intake_rules.length > 0, true, 'pre-existing rules were preserved across the re-stamp');
});

test('migration 0023: DB CHECK constraint rejects an invalid buyer_signal_policy value directly', async () => {
  await assert.rejects(
    () => pool.query(`UPDATE matching_dubai.runtime_settings SET value_text = 'NOT_A_POLICY' WHERE key = 'buyer_signal_policy'`),
    /violates check constraint/
  );
});

test('migration 0023: shadow_gate_evaluations.mode defaults to SHADOW for pre-existing rows, old_decision is nullable', async () => {
  const cols = await pool.query(
    `SELECT column_name, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema='matching_dubai' AND table_name='shadow_gate_evaluations' AND column_name IN ('mode','old_decision')`
  );
  const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
  assert.equal(byName.old_decision.is_nullable, 'YES');
  assert.equal(byName.mode.is_nullable, 'NO');
  assert.ok(byName.mode.column_default.includes('SHADOW'));
});

// ---------------------------------------------------------------------
// F. Apply / Rollback for the two new settings
// ---------------------------------------------------------------------

test('Draft -> Apply -> Rollback: a draft policy change has no effect on the ACTIVE config until Apply', async () => {
  const before = await loadActiveV2Config(pool);
  assert.equal(before.settings.buyer_signal_policy.value, 'REQUIRE_BOTH');

  const draftEdit = await updateDraftSetting(pool, 'buyer_signal_policy', { valueText: 'REQUIRE_ANY', enabled: true });
  assert.equal(draftEdit.ok, true);

  const stillActive = await loadActiveV2Config(pool);
  assert.equal(stillActive.settings.buyer_signal_policy.value, 'REQUIRE_BOTH', 'a draft edit must never leak into the ACTIVE config');
});

test('Draft -> Apply -> Rollback: Apply activates REQUIRE_ANY, a real authoritative evaluation immediately reflects it, then rollback restores REQUIRE_BOTH', async () => {
  const applyResult = await applyDraft(pool, { note: 'Phase 4 test: emergency REQUIRE_ANY', createdBy: 'phase4-test' });
  assert.equal(applyResult.ok, true, applyResult.error);

  const afterApply = await loadActiveV2Config(pool);
  assert.equal(afterApply.settings.buyer_signal_policy.value, 'REQUIRE_ANY');
  assert.equal(afterApply.settings.v2_intake_cutover_enabled.value, false, 'cutover itself was never toggled by this test -- only the policy');

  // Turn cutover ON too, so evaluateAuthoritativeGate actually engages.
  await updateDraftSetting(pool, 'v2_intake_cutover_enabled', { valueText: 'true', enabled: true });
  const applyCutoverOn = await applyDraft(pool, { note: 'Phase 4 test: cutover ON', createdBy: 'phase4-test' });
  assert.equal(applyCutoverOn.ok, true, applyCutoverOn.error);

  // try/finally: this test deliberately puts LIVE cutover state (ON,
  // REQUIRE_ANY) into the shared test database -- an assertion failure
  // partway through must never leave that state leaked into whatever
  // integration test file runs next (this exact failure mode was hit and
  // fixed while writing this test: a comparison bug here once aborted the
  // test before its own rollback ran, and a later, unrelated file's test
  // failed as a direct, confusing side effect).
  const deps = { pool, getActiveV2Config: () => loadActiveV2Config(pool) };
  try {
    // A whitelist-only message: REQUIRE_ANY must send it to AI even without a property signal.
    const result = await evaluateAuthoritativeGate({
      unifiedMessage: { source_message_id: 'gate-cutover-it:1', provider: 'telegram', original_text: 'i need a place asap' },
      deps,
    });
    assert.equal(result.cutoverEnabled, true);
    assert.equal(result.decision, 'SEND_TO_AI', 'REQUIRE_ANY must accept a whitelist-only match');
    assert.equal(String(result.configVersionId), String(applyCutoverOn.version.id), 'exact version attribution on this evaluation (config_versions.id, not version_number)');
  } finally {
    // Rollback to the version BEFORE either of these two Applies (i.e. before this test started tampering).
    const preTestVersion = applyResult.version.version_number - 1;
    const rollbackResult = await rollbackToVersion(pool, preTestVersion, { createdBy: 'phase4-test' });
    assert.equal(rollbackResult.ok, true, rollbackResult.error);
  }

  const afterRollback = await loadActiveV2Config(pool);
  assert.equal(afterRollback.settings.buyer_signal_policy.value, 'REQUIRE_BOTH', 'rollback restored the pre-test policy');
  assert.equal(afterRollback.settings.v2_intake_cutover_enabled.value, false, 'rollback restored cutover OFF -- operational rollback requires no code change');

  // Cutover OFF after rollback must work IMMEDIATELY (spec section 18).
  const resultAfterRollback = await evaluateAuthoritativeGate({
    unifiedMessage: { source_message_id: 'gate-cutover-it:2', provider: 'telegram', original_text: 'i need a place asap' },
    deps,
  });
  assert.deepEqual(resultAfterRollback, { cutoverEnabled: false }, 'cutover is immediately off again, no code/deploy required');
});

test('config coherence: loadActiveV2Config reads settings/rules/version from one consistent snapshot (REPEATABLE READ)', async () => {
  // Not a true concurrency race (that would need a second live transaction
  // mid-flight), but proves the function completes correctly inside an
  // explicit transaction and returns internally consistent data -- the
  // config_version_id returned actually matches a version whose own
  // snapshot contains exactly the settings/rules keys just read.
  const config = await loadActiveV2Config(pool);
  const current = await getCurrentConfigVersion(pool);
  assert.equal(config.configVersionId, current.id);
  const snapshotKeys = new Set(current.snapshot.runtime_settings.map((s) => s.key));
  for (const key of Object.keys(config.settings)) {
    assert.ok(snapshotKeys.has(key), `${key} present in loadActiveV2Config's settings must also be present in the current version's own snapshot`);
  }
});
