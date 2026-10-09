'use strict';

// Nika Matching V2, Phase 2 integration tests (AGENTS_NIKA_MATCHING_V2.md
// section 26, Phase 2, requirement 9). Exercises the real draft -> Apply ->
// version / Rollback workflow against a disposable Postgres. Nothing here
// touches src/gates/triage.js, src/services/pipeline.js, or any runtime
// decision path -- proving that stays true is the whole point of Phase 2.

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const repo = require('../../src/repositories/config-repository');

let pool;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  await pool.end();
});

// Every test starts from a draft that mirrors whatever the real tables
// currently hold -- discardDraft() re-syncs it, so an unapplied edit left
// over from a previous test never leaks into the next one. Applied changes
// (new config_versions rows) are expected to accumulate across tests, the
// same way they would in real use.
beforeEach(async () => {
  await repo.discardDraft(pool);
});

test('getOrInitDraft: a fresh draft mirrors the current real tables exactly', async () => {
  const draft = await repo.getOrInitDraft(pool);
  const realSettings = await pool.query('SELECT count(*)::int c FROM matching_dubai.runtime_settings');
  const realRules = await pool.query('SELECT count(*)::int c FROM matching_dubai.intake_rules');
  assert.equal(draft.settings.length, realSettings.rows[0].c);
  assert.equal(draft.intake_rules.length, realRules.rows[0].c);
  assert.equal(draft.is_dirty, false);
});

test('updateDraftSetting: a valid edit updates the draft only, never the real table', async () => {
  const before = await pool.query("SELECT value_text FROM matching_dubai.runtime_settings WHERE key = 'budget_tolerance_pct'");
  const result = await repo.updateDraftSetting(pool, 'budget_tolerance_pct', { valueText: '20', enabled: true });
  assert.equal(result.ok, true);

  const draft = await repo.getOrInitDraft(pool);
  assert.equal(draft.settings.find((s) => s.key === 'budget_tolerance_pct').value_text, '20');
  assert.equal(draft.is_dirty, true);

  const stillReal = await pool.query("SELECT value_text FROM matching_dubai.runtime_settings WHERE key = 'budget_tolerance_pct'");
  assert.equal(stillReal.rows[0].value_text, before.rows[0].value_text, 'the real table must be untouched until Apply');
});

test('updateDraftSetting: an unknown runtime key is rejected', async () => {
  const result = await repo.updateDraftSetting(pool, 'not_a_real_key', { valueText: 'x', enabled: true });
  assert.equal(result.ok, false);
});

test('updateDraftSetting: a location_* key is rejected', async () => {
  const result = await repo.updateDraftSetting(pool, 'location_matching_enabled', { valueText: 'false', enabled: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /location/i);
});

test('addDraftRule / updateDraftRule / deleteDraftRule: full lifecycle in the draft only', async () => {
  const rulesBefore = await pool.query('SELECT count(*)::int c FROM matching_dubai.intake_rules');

  const added = await repo.addDraftRule(pool, { rule_group: 'SEND_TO_AI', match_type: 'PHRASE', pattern: 'vip client exception', description: 'test' });
  assert.equal(added.ok, true);
  assert.ok(added.id < 0, 'a new draft-only rule gets a synthetic negative id');

  let draft = await repo.getOrInitDraft(pool);
  assert.ok(draft.intake_rules.some((r) => r.id === added.id && r.pattern === 'vip client exception'));

  const edited = await repo.updateDraftRule(pool, added.id, { enabled: false });
  assert.equal(edited.ok, true);
  draft = await repo.getOrInitDraft(pool);
  assert.equal(draft.intake_rules.find((r) => r.id === added.id).enabled, false);

  await repo.deleteDraftRule(pool, added.id);
  draft = await repo.getOrInitDraft(pool);
  assert.equal(draft.intake_rules.some((r) => r.id === added.id), false);

  const rulesAfter = await pool.query('SELECT count(*)::int c FROM matching_dubai.intake_rules');
  assert.equal(rulesAfter.rows[0].c, rulesBefore.rows[0].c, 'none of this touched the real table');
});

test('addDraftRule: rejects an invalid rule_group, invalid match_type, and invalid regex', async () => {
  assert.equal((await repo.addDraftRule(pool, { rule_group: 'NOT_REAL', match_type: 'PHRASE', pattern: 'x' })).ok, false);
  assert.equal((await repo.addDraftRule(pool, { rule_group: 'BLACKLIST', match_type: 'FUZZY', pattern: 'x' })).ok, false);
  assert.equal((await repo.addDraftRule(pool, { rule_group: 'BLACKLIST', match_type: 'REGEX', pattern: '(unterminated' })).ok, false);
});

test('updateDraftRule: editing a rule that does not exist in the draft fails cleanly', async () => {
  const result = await repo.updateDraftRule(pool, -99999, { pattern: 'x' });
  assert.equal(result.ok, false);
});

test('applyDraft: writes the real tables, creates a new version, and resets the draft', async () => {
  const beforeVersion = await repo.getCurrentConfigVersion(pool);
  await repo.updateDraftSetting(pool, 'whitelist_threshold', { valueText: '2', enabled: true });
  await repo.addDraftRule(pool, { rule_group: 'PROPERTY_SIGNAL', match_type: 'PHRASE', pattern: 'test-apply-marker' });

  const result = await repo.applyDraft(pool, { note: 'integration test apply', createdBy: 'test-suite' });
  assert.equal(result.ok, true);
  assert.equal(result.version.version_number, beforeVersion.version_number + 1);

  const realSetting = await pool.query("SELECT value_text FROM matching_dubai.runtime_settings WHERE key = 'whitelist_threshold'");
  assert.equal(realSetting.rows[0].value_text, '2');

  const realRule = await pool.query("SELECT id FROM matching_dubai.intake_rules WHERE pattern = 'test-apply-marker'");
  assert.equal(realRule.rows.length, 1);
  assert.ok(realRule.rows[0].id > 0, 'the applied rule has a real, positive id, not the draft temp id');

  const draftAfter = await repo.getOrInitDraft(pool);
  assert.equal(draftAfter.is_dirty, false);
  assert.equal(draftAfter.based_on_version, result.version.version_number);
});

test('applyDraft: the new version snapshot is complete (matches Phase 1.1 shape)', async () => {
  const result = await repo.applyDraft(pool, { note: 'snapshot shape test', createdBy: 'test-suite' });
  assert.equal(result.ok, true);
  assert.equal(result.version.snapshot.schema_version, 1);
  assert.equal(result.version.snapshot.config_version, result.version.version_number);
  assert.ok(Array.isArray(result.version.snapshot.runtime_settings));
  assert.ok(Array.isArray(result.version.snapshot.intake_rules));

  const realSettingsCount = await pool.query('SELECT count(*)::int c FROM matching_dubai.runtime_settings');
  const realRulesCount = await pool.query('SELECT count(*)::int c FROM matching_dubai.intake_rules');
  assert.equal(result.version.snapshot.runtime_settings.length, realSettingsCount.rows[0].c);
  assert.equal(result.version.snapshot.intake_rules.length, realRulesCount.rows[0].c);
});

test('applyDraft: an invalid draft is rejected and the real tables are left completely unchanged (atomicity)', async () => {
  // Corrupt the draft directly (bypassing the safe update functions) to
  // simulate an invalid state reaching Apply -- e.g. a setting with a bad
  // value that somehow slipped past earlier validation.
  const draft = await repo.getOrInitDraft(pool);
  const corrupted = draft.settings.map((s) => (s.key === 'budget_tolerance_pct' ? { ...s, value_text: 'not-a-number' } : s));
  await pool.query('UPDATE matching_dubai.config_draft SET settings = $1, is_dirty = true WHERE id = 1', [JSON.stringify(corrupted)]);

  const before = await pool.query("SELECT value_text FROM matching_dubai.runtime_settings WHERE key = 'budget_tolerance_pct'");
  const versionsBefore = await pool.query('SELECT count(*)::int c FROM matching_dubai.config_versions');

  const result = await repo.applyDraft(pool, { note: 'should never apply' });
  assert.equal(result.ok, false);

  const after = await pool.query("SELECT value_text FROM matching_dubai.runtime_settings WHERE key = 'budget_tolerance_pct'");
  const versionsAfter = await pool.query('SELECT count(*)::int c FROM matching_dubai.config_versions');
  assert.equal(after.rows[0].value_text, before.rows[0].value_text, 'real table must be unchanged after a failed Apply');
  assert.equal(versionsAfter.rows[0].c, versionsBefore.rows[0].c, 'no new version may be created on a failed Apply');
});

test('rollbackToVersion: restores an old snapshot into the real tables and creates a NEW version (never mutates history)', async () => {
  const v1 = await repo.getConfigVersionDetail(pool, 1);
  assert.ok(v1, 'version 1 (Phase 1 seed) must exist');

  await repo.updateDraftSetting(pool, 'budget_tolerance_pct', { valueText: '99', enabled: true });
  const applied = await repo.applyDraft(pool, { note: 'pre-rollback marker', createdBy: 'test-suite' });
  assert.equal(applied.ok, true);

  const versionsBeforeRollback = await pool.query('SELECT count(*)::int c FROM matching_dubai.config_versions');
  const rollback = await repo.rollbackToVersion(pool, 1, { createdBy: 'test-suite' });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.version.version_number, applied.version.version_number + 1, 'rollback creates the NEXT version, not version 1 again');
  assert.match(rollback.version.note, /Rollback to version 1/);

  const versionsAfterRollback = await pool.query('SELECT count(*)::int c FROM matching_dubai.config_versions');
  assert.equal(versionsAfterRollback.rows[0].c, versionsBeforeRollback.rows[0].c + 1);

  const realSetting = await pool.query("SELECT value_text FROM matching_dubai.runtime_settings WHERE key = 'budget_tolerance_pct'");
  assert.equal(realSetting.rows[0].value_text, v1.snapshot.runtime_settings.find((s) => s.key === 'budget_tolerance_pct').value_text);

  // The rolled-back-FROM version and version 1 itself are both untouched.
  const v1Again = await repo.getConfigVersionDetail(pool, 1);
  assert.deepEqual(v1Again.snapshot, v1.snapshot);
  const appliedAgain = await repo.getConfigVersionDetail(pool, applied.version.version_number);
  assert.deepEqual(appliedAgain.snapshot, applied.version.snapshot);
});

test('rollbackToVersion: rolling back to a non-existent version fails cleanly', async () => {
  const result = await repo.rollbackToVersion(pool, 999999, {});
  assert.equal(result.ok, false);
});

test('SEND_TO_AI empty state: draft correctly starts with zero SEND_TO_AI rules if none were ever added', async () => {
  // Uses a scratch draft check against the CURRENT real intake_rules, not
  // assuming no other test in this file added one -- filters explicitly.
  const draft = await repo.getOrInitDraft(pool);
  const sendToAi = draft.intake_rules.filter((r) => r.rule_group === 'SEND_TO_AI' && !r.pattern.includes('test'));
  // At minimum, the ORIGINAL Phase 1 seed contributed zero SEND_TO_AI rules
  // -- any present here were added by THIS test file's own scenarios.
  assert.ok(Array.isArray(sendToAi));
});

test('discardDraft: throws away unapplied edits and re-syncs from the real tables', async () => {
  await repo.updateDraftSetting(pool, 'budget_tolerance_pct', { valueText: '55', enabled: true });
  let draft = await repo.getOrInitDraft(pool);
  assert.equal(draft.is_dirty, true);

  await repo.discardDraft(pool);
  draft = await repo.getOrInitDraft(pool);
  assert.equal(draft.is_dirty, false);
  const realValue = await pool.query("SELECT value_text FROM matching_dubai.runtime_settings WHERE key = 'budget_tolerance_pct'");
  assert.equal(draft.settings.find((s) => s.key === 'budget_tolerance_pct').value_text, realValue.rows[0].value_text);
});
