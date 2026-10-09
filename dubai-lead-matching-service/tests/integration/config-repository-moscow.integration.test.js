'use strict';

// Migration 0029 (matching_moscow.runtime_settings/intake_rules/
// config_versions/config_draft) + the schema-parameterized config-repository
// (2026-09-28: the user asked for Moscow's /settings page to have "the
// same parameters" as UAE's, not a separate static reference page).
// Proves: (a) matching_moscow's own seed exists and is independent from
// matching_dubai's, (b) writing to one schema never touches the other, (c)
// the RF wrapper (rf-lead-matching-service/src/repositories/config-repository.js)
// and the dashboard re-export (dashboard/moscow-settings-queries.js) both
// correctly target matching_moscow without the caller ever passing a schema.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const uaeConfigRepo = require('../../src/repositories/config-repository');

let pool;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  await pool.end();
});

test('migration 0029 seed: matching_moscow has its own version 1, independent from matching_dubai', async () => {
  const uaeVersion = await uaeConfigRepo.getCurrentConfigVersion(pool, { schema: 'matching_dubai' });
  const moscowVersion = await uaeConfigRepo.getCurrentConfigVersion(pool, { schema: 'matching_moscow' });
  assert.ok(uaeVersion, 'UAE must still have its own version 1+ (migration 0020)');
  assert.ok(moscowVersion, 'Moscow must have its own version 1 (migration 0029)');
});

test('migration 0029 seed: property_signal_threshold=0 for Moscow, 1 for UAE -- the one confirmed exception', async () => {
  const uaeSettings = await uaeConfigRepo.getActiveRuntimeSettings(pool, { schema: 'matching_dubai' });
  const moscowSettings = await uaeConfigRepo.getActiveRuntimeSettings(pool, { schema: 'matching_moscow' });
  assert.equal(uaeSettings.property_signal_threshold.value, 1);
  assert.equal(moscowSettings.property_signal_threshold.value, 0);
});

test('migration 0030: the 5 UAE-copied matching toggles were removed from Moscow -- they conflicted with Moscow\'s real field model and duplicated the Joker criteria reference', async () => {
  const moscowSettings = await uaeConfigRepo.getActiveRuntimeSettings(pool, { schema: 'matching_moscow' });
  for (const key of ['transaction_matching_enabled', 'bedrooms_matching_enabled', 'property_type_matching_enabled', 'budget_matching_enabled', 'budget_tolerance_pct']) {
    assert.equal(moscowSettings[key], undefined, `expected "${key}" to be removed from Moscow's runtime_settings`);
  }
  const uaeSettings = await uaeConfigRepo.getActiveRuntimeSettings(pool, { schema: 'matching_dubai' });
  assert.ok(uaeSettings.bedrooms_matching_enabled, 'UAE must keep its own 5-dimension toggles untouched');
});

test('migration 0031: the 15 Joker criteria are real, individually toggleable settings with the correct seeded defaults', async () => {
  const moscowSettings = await uaeConfigRepo.getActiveRuntimeSettings(pool, { schema: 'matching_moscow' });
  const onByDefault = ['joker_property_type_enabled', 'joker_city_enabled', 'joker_district_enabled', 'joker_complex_enabled', 'joker_rooms_enabled', 'joker_bedrooms_enabled', 'joker_area_enabled', 'joker_floor_enabled', 'joker_floors_total_enabled', 'joker_price_enabled', 'joker_readiness_enabled'];
  const offByDefault = ['joker_layout_enabled', 'joker_euro_layout_enabled', 'joker_deal_type_enabled', 'joker_amenities_enabled'];
  for (const key of onByDefault) {
    assert.equal(moscowSettings[key].value, true, `expected "${key}" to default to true`);
  }
  for (const key of offByDefault) {
    assert.equal(moscowSettings[key].value, false, `expected "${key}" to default to false`);
  }
});

test('migration 0031: editing a Joker criterion through the draft only affects matching_moscow, never matching_dubai (which has no such key at all)', async () => {
  await uaeConfigRepo.updateDraftSetting(pool, 'joker_layout_enabled', { valueText: 'true', enabled: true }, { schema: 'matching_moscow' });
  const draft = await uaeConfigRepo.getOrInitDraft(pool, { schema: 'matching_moscow' });
  const layout = draft.settings.find((s) => s.key === 'joker_layout_enabled');
  assert.equal(layout.value_text, 'true');
  const uaeSettings = await uaeConfigRepo.getActiveRuntimeSettings(pool, { schema: 'matching_dubai' });
  assert.equal(uaeSettings.joker_layout_enabled, undefined, 'UAE must never have a Joker-criteria key at all');
  await uaeConfigRepo.discardDraft(pool, { schema: 'matching_moscow' });
});

test('migration 0030: Moscow\'s draft correctly rebuilds without the removed keys after the migration deleted the stale singleton draft row', async () => {
  const draft = await uaeConfigRepo.getOrInitDraft(pool, { schema: 'matching_moscow' });
  const keys = draft.settings.map((s) => s.key);
  assert.ok(!keys.includes('bedrooms_matching_enabled'));
  assert.ok(keys.includes('property_signal_threshold'), 'other real Moscow settings are still present');
});

test('migration 0029 seed: BLACKLIST/WHITELIST seeded for Moscow, PROPERTY_SIGNAL/SEND_TO_AI empty (same shape as UAE launch)', async () => {
  const rules = await uaeConfigRepo.getEnabledIntakeRules(pool, { schema: 'matching_moscow' });
  assert.ok(rules.BLACKLIST.length > 0);
  assert.ok(rules.WHITELIST.length > 0);
  assert.deepEqual(rules.PROPERTY_SIGNAL, []);
  assert.deepEqual(rules.SEND_TO_AI, []);
  assert.ok(rules.WHITELIST.some((r) => r.pattern === 'ищу для клиента'));
  assert.ok(rules.BLACKLIST.some((r) => r.pattern === 'агентское вознаграждение'));
});

test('assertValidConfigSchema: refuses any schema not in the allow-list -- never interpolates arbitrary input into SQL', async () => {
  await assert.rejects(
    () => uaeConfigRepo.getActiveRuntimeSettings(pool, { schema: 'matching; DROP TABLE matching_dubai.runtime_settings; --' }),
    /not in the allow-list/
  );
});

test('ISOLATION: a draft edit against matching_moscow never touches matching_dubai.config_draft', async () => {
  const before = await uaeConfigRepo.getOrInitDraft(pool, { schema: 'matching_dubai' });
  await uaeConfigRepo.updateDraftSetting(pool, 'ai_cache_ttl_days', { valueText: '99', enabled: true }, { schema: 'matching_moscow' });
  const afterUae = await uaeConfigRepo.getOrInitDraft(pool, { schema: 'matching_dubai' });
  const afterMoscow = await uaeConfigRepo.getOrInitDraft(pool, { schema: 'matching_moscow' });
  assert.equal(afterUae.is_dirty, before.is_dirty, 'UAE draft is untouched by a Moscow-schema edit');
  assert.equal(afterMoscow.is_dirty, true);
  const moscowTtl = afterMoscow.settings.find((s) => s.key === 'ai_cache_ttl_days');
  assert.equal(moscowTtl.value_text, '99');
  // Clean up: discard the Moscow draft edit so this test doesn't leak state.
  await uaeConfigRepo.discardDraft(pool, { schema: 'matching_moscow' });
});

// ---- RF wrapper + dashboard re-export (2026-09-28) -----------------------

test('rf-lead-matching-service config-repository wrapper always targets matching_moscow without the caller passing a schema', async () => {
  const rfConfigRepo = require('../../../rf-lead-matching-service/src/repositories/config-repository');
  const settings = await rfConfigRepo.getActiveRuntimeSettings(pool);
  assert.equal(settings.property_signal_threshold.value, 0, 'proves it read matching_moscow, not matching_dubai');
});

test('dashboard/moscow-settings-queries.js re-exports the RF wrapper and config-validation, same pattern as dashboard/settings-queries.js', async () => {
  const moscowSettingsQueries = require('../../../dashboard/moscow-settings-queries');
  const settings = await moscowSettingsQueries.getActiveRuntimeSettings(pool);
  assert.equal(settings.property_signal_threshold.value, 0);
  assert.equal(typeof moscowSettingsQueries.validateRule, 'function', 'config-validation is re-exported too');
});
