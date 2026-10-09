'use strict';

// Nika Matching V2, Phase 1 integration tests (AGENTS_NIKA_MATCHING_V2.md
// section 26, Phase 1, requirement F). Exercises the real migration 0020
// against a disposable Postgres (via scripts/run-integration-tests.js,
// which applies every migration under sql/migrations/ before this file
// runs) -- proves schema constraints, seed data, and the read repository,
// WITHOUT touching any runtime decision path (nothing here calls triage.js
// or pipeline.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const {
  getActiveRuntimeSettings,
  getEnabledIntakeRules,
  getCurrentConfigVersion,
  getConfigVersionHistory,
} = require('../../src/repositories/config-repository');

let pool;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  await pool.end();
});

test('migration 0020 is idempotent -- re-running the seed block never duplicates rows', async () => {
  const before = await pool.query('SELECT count(*)::int AS c FROM matching_dubai.intake_rules');
  // Re-apply just this migration's SQL file's seed guard by re-running the
  // migration runner against the same DB -- runMigrations() already skips
  // applied filenames via matching_dubai.schema_migrations, so this proves the
  // ACTUAL idempotency guarantee the runner relies on, not a hypothetical.
  const { runMigrations } = require('../../../src/db/migrate');
  const { appliedNow } = await runMigrations(pool);
  assert.equal(appliedNow.includes('0020_matching_v2_config.sql'), false, 'already-applied migration must not re-run');
  const after = await pool.query('SELECT count(*)::int AS c FROM matching_dubai.intake_rules');
  assert.equal(after.rows[0].c, before.rows[0].c);
});

test('rule_group CHECK constraint rejects an invalid group', async () => {
  await assert.rejects(
    () => pool.query(
      `INSERT INTO matching_dubai.intake_rules (rule_group, match_type, pattern) VALUES ('NOT_A_REAL_GROUP', 'PHRASE', 'x')`
    ),
    /violates check constraint/
  );
});

test('match_type CHECK constraint rejects an invalid type', async () => {
  await assert.rejects(
    () => pool.query(
      `INSERT INTO matching_dubai.intake_rules (rule_group, match_type, pattern) VALUES ('BLACKLIST', 'FUZZY', 'x')`
    ),
    /violates check constraint/
  );
});

test('a valid rule_group/match_type combination inserts cleanly (and is cleaned up)', async () => {
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.intake_rules (rule_group, match_type, pattern, description)
     VALUES ('SEND_TO_AI', 'PHRASE', 'test-only-row', 'inserted by config-repository.integration.test.js')
     RETURNING id`
  );
  assert.ok(rows[0].id > 0);
  await pool.query('DELETE FROM matching_dubai.intake_rules WHERE id = $1', [rows[0].id]);
});

// Phase 1.1 hardening: the constraint moved from a finite key-name
// blocklist (`key NOT IN (...)`) to a structural `^location_` prefix
// rejection -- these two names ('location_filter_enabled',
// 'location_match_enabled') are ones the OLD blocklist would have let
// through silently; they must be rejected under the new constraint.
for (const key of ['location_enabled', 'location_matching_enabled', 'location_filter_enabled', 'location_match_enabled']) {
  test(`LOCATION can never be represented as a disableable runtime_settings row: "${key}" is rejected (structural CHECK)`, async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO matching_dubai.runtime_settings (key, value_type, value_text) VALUES ($1, 'boolean', 'false')`,
        [key]
      ),
      /violates check constraint/
    );
  });
}

test('a normal, non-location key is still accepted by the constraint', async () => {
  const { rows } = await pool.query(
    `INSERT INTO matching_dubai.runtime_settings (key, value_type, value_text) VALUES ('phase11_sanity_check', 'boolean', 'true') RETURNING id`
  );
  assert.ok(rows[0].id > 0);
  await pool.query('DELETE FROM matching_dubai.runtime_settings WHERE id = $1', [rows[0].id]);
});

test('runtime_settings.key is UNIQUE -- a duplicate key insert is rejected', async () => {
  await assert.rejects(
    () => pool.query(
      `INSERT INTO matching_dubai.runtime_settings (key, value_type, value_text) VALUES ('budget_tolerance_pct', 'numeric', '15')`
    ),
    /duplicate key value violates unique constraint/
  );
});

test('getActiveRuntimeSettings: seed values match the current env-based defaults they were derived from', async () => {
  const settings = await getActiveRuntimeSettings(pool);
  assert.equal(settings.budget_tolerance_pct.value, 10); // MATCH_PRICE_TOLERANCE_PCT default
  assert.equal(settings.content_dedup_ttl_hours.value, 48); // DEDUP_WINDOW_HOURS default
  assert.equal(settings.ai_cache_ttl_days.value, 14); // INTERPRETATION_CACHE_TTL_DAYS default
  assert.equal(settings.transaction_matching_enabled.value, true);
  assert.equal(settings.bedrooms_matching_enabled.value, true);
  assert.equal(settings.property_type_matching_enabled.value, true);
  assert.equal(settings.budget_matching_enabled.value, true);
  // No key represents a location on/off toggle at all (not just disabled).
  assert.equal(Object.keys(settings).some((k) => k.toLowerCase().includes('location')), false);
});

test('getEnabledIntakeRules: every contract rule_group key is present, SEND_TO_AI is intentionally empty', async () => {
  const grouped = await getEnabledIntakeRules(pool);
  assert.ok(Array.isArray(grouped.BLACKLIST) && grouped.BLACKLIST.length > 0);
  assert.ok(Array.isArray(grouped.WHITELIST) && grouped.WHITELIST.length > 0);
  assert.ok(Array.isArray(grouped.PROPERTY_SIGNAL) && grouped.PROPERTY_SIGNAL.length > 0);
  assert.deepEqual(grouped.SEND_TO_AI, []);
});

test('getEnabledIntakeRules: a disabled rule is excluded from the read', async () => {
  const inserted = await pool.query(
    `INSERT INTO matching_dubai.intake_rules (rule_group, match_type, pattern, enabled)
     VALUES ('WHITELIST', 'PHRASE', 'test-disabled-row', false) RETURNING id`
  );
  try {
    const grouped = await getEnabledIntakeRules(pool);
    assert.equal(grouped.WHITELIST.some((r) => r.pattern === 'test-disabled-row'), false);
  } finally {
    await pool.query('DELETE FROM matching_dubai.intake_rules WHERE id = $1', [inserted.rows[0].id]);
  }
});

test('getCurrentConfigVersion / getConfigVersionHistory: seed version 1 exists and is readable', async () => {
  const current = await getCurrentConfigVersion(pool);
  assert.ok(current);
  assert.equal(current.version_number >= 1, true);

  const history = await getConfigVersionHistory(pool);
  assert.ok(history.some((v) => v.version_number === 1));
});

// Phase 1.1: config_versions.snapshot for version 1 must be a COMPLETE
// historical record -- sufficient to reconstruct version 1 later without
// relying on the mutable runtime_settings/intake_rules tables (which a
// future Phase 2 UI will let an operator edit in place).
test('version 1 snapshot is a complete historical record: schema_version + config_version + all 13 settings + all 41 rules', async () => {
  const { rows } = await pool.query(
    'SELECT snapshot FROM matching_dubai.config_versions WHERE version_number = 1'
  );
  const snapshot = rows[0].snapshot;
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.config_version, 1);
  assert.equal(Array.isArray(snapshot.runtime_settings), true);
  assert.equal(snapshot.runtime_settings.length, 13);
  assert.equal(Array.isArray(snapshot.intake_rules), true);
  assert.equal(snapshot.intake_rules.length, 41);

  // Spot-check the snapshot actually carries real field values, not just
  // the right array lengths.
  const budgetTolerance = snapshot.runtime_settings.find((s) => s.key === 'budget_tolerance_pct');
  assert.ok(budgetTolerance);
  assert.equal(budgetTolerance.value_text, '10');

  const sendToAiRules = snapshot.intake_rules.filter((r) => r.rule_group === 'SEND_TO_AI');
  assert.deepEqual(sendToAiRules, []);
});

test('seed consistency: every intake_rules row references the real config_versions row it was seeded with', async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS orphaned FROM matching_dubai.intake_rules r
     LEFT JOIN matching_dubai.config_versions v ON v.id = r.config_version_id
     WHERE r.config_version_id IS NOT NULL AND v.id IS NULL`
  );
  assert.equal(rows[0].orphaned, 0);
});
