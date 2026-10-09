'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const sourceRepo = require('../../src/sources/source-repository');

let pool;

before(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

after(async () => {
  await pool.query(`DELETE FROM ingest.source_routes WHERE source_id IN (SELECT id FROM ingest.sources WHERE account_id LIKE 'src-it-%')`);
  await pool.query(`DELETE FROM ingest.sources WHERE account_id LIKE 'src-it-%'`);
  await pool.query(`DELETE FROM ingest.source_sync_runs WHERE account_id LIKE 'src-it-%'`);
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM ingest.source_routes WHERE source_id IN (SELECT id FROM ingest.sources WHERE account_id LIKE 'src-it-%')`);
  await pool.query(`DELETE FROM ingest.sources WHERE account_id LIKE 'src-it-%'`);
  await pool.query(`DELETE FROM ingest.source_sync_runs WHERE account_id LIKE 'src-it-%'`);
});

test('upsertSource: first call creates, second call updates -- identity is (provider, account_id, external_source_id)', async () => {
  const first = await sourceRepo.upsertSource(pool, {
    provider: 'telegram', accountId: 'src-it-1', externalSourceId: '-1001111', name: 'Dubai Brokers',
  });
  assert.equal(first.inserted, true);

  const second = await sourceRepo.upsertSource(pool, {
    provider: 'telegram', accountId: 'src-it-1', externalSourceId: '-1001111', name: 'Dubai Brokers (renamed)',
  });
  assert.equal(second.inserted, false);
  assert.equal(second.id, first.id);

  const source = await sourceRepo.getSourceById(pool, first.id);
  assert.equal(source.name, 'Dubai Brokers (renamed)');
});

test('upsertSource: creates a default, inert source_routes row automatically (monitoring off, route NONE)', async () => {
  const { id } = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-2', externalSourceId: '-1002222', name: 'X' });
  const source = await sourceRepo.getSourceById(pool, id);
  assert.equal(source.monitoring_enabled, false);
  assert.deepEqual(source.route_modes, ['NONE']);
});

test('RELEASE BLOCKER: a re-sync (upsertSource called again) never overwrites an operator\'s route decision', async () => {
  const { id } = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-3', externalSourceId: '-1003333', name: 'X' });
  await sourceRepo.updateSourceRoute(pool, id, { monitoringEnabled: true, routeModes: ['RF'], notes: 'set by operator' });

  // Simulate a re-sync: same identity, refreshed descriptive fields.
  await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-3', externalSourceId: '-1003333', name: 'X (renamed on Telegram)', memberCount: 500 });

  const source = await sourceRepo.getSourceById(pool, id);
  assert.equal(source.name, 'X (renamed on Telegram)', 'descriptive fields DO refresh');
  assert.equal(source.monitoring_enabled, true, 'operator monitoring decision must survive a re-sync');
  assert.deepEqual(source.route_modes, ['RF'], 'operator route decision must survive a re-sync');
  assert.equal(source.notes, 'set by operator');
});

test('markMissingSourcesUnavailable: a disappeared source is marked unavailable, never deleted', async () => {
  const { id } = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-4', externalSourceId: '-1004444', name: 'X' });
  const markedCount = await sourceRepo.markMissingSourcesUnavailable(pool, { provider: 'telegram', accountId: 'src-it-4', seenExternalSourceIds: [] });
  assert.equal(markedCount, 1);
  const source = await sourceRepo.getSourceById(pool, id);
  assert.equal(source.available, false);
  assert.ok(source.id, 'the row still exists -- never deleted');
});

test('updateSourceRoute: setting routeModes/monitoring_enabled implicitly sets manual_override=true', async () => {
  const { id } = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-5', externalSourceId: '-1005555', name: 'X' });
  const updated = await sourceRepo.updateSourceRoute(pool, id, { routeModes: ['DUBAI'] });
  assert.equal(updated.manual_override, true);
});

test('updateSourceRoute: rejects AUTO/NONE combined with a real market, never writes the invalid combination', async () => {
  const { id } = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-5b', externalSourceId: '-1005556', name: 'X' });
  const result = await sourceRepo.updateSourceRoute(pool, id, { routeModes: ['AUTO', 'DUBAI'] });
  assert.equal(result.ok, false);
  assert.match(result.error, /AUTO\/NONE/);
  const source = await sourceRepo.getSourceById(pool, id);
  assert.deepEqual(source.route_modes, ['NONE'], 'the invalid write must never land -- route stays at the default');
});

test('updateSourceRoute: a genuine multi-market combination is accepted and stored as-is', async () => {
  const { id } = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-5c', externalSourceId: '-1005557', name: 'X' });
  await sourceRepo.updateSourceRoute(pool, id, { routeModes: ['DUBAI', 'ABU_DHABI'] });
  const source = await sourceRepo.getSourceById(pool, id);
  assert.deepEqual(source.route_modes.sort(), ['ABU_DHABI', 'DUBAI']);
});

test('bulkUpdateSourceRoutes: updates every listed source', async () => {
  const a = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-6', externalSourceId: '-1006001', name: 'A' });
  const b = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-6', externalSourceId: '-1006002', name: 'B' });
  await sourceRepo.bulkUpdateSourceRoutes(pool, [a.id, b.id], { monitoringEnabled: true, routeModes: ['DUBAI', 'RF'] });

  const sourceA = await sourceRepo.getSourceById(pool, a.id);
  const sourceB = await sourceRepo.getSourceById(pool, b.id);
  assert.deepEqual(sourceA.route_modes.sort(), ['DUBAI', 'RF']);
  assert.deepEqual(sourceB.route_modes.sort(), ['DUBAI', 'RF']);
});

test('listSources: filters by provider, route (containment), and monitoring_enabled', async () => {
  const a = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-7', externalSourceId: '-1007001', name: 'Dubai Group' });
  const b = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-7', externalSourceId: '-1007002', name: 'RF Group' });
  const c = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-7', externalSourceId: '-1007003', name: 'Dubai+AbuDhabi Group' });
  await sourceRepo.updateSourceRoute(pool, a.id, { monitoringEnabled: true, routeModes: ['DUBAI'] });
  await sourceRepo.updateSourceRoute(pool, b.id, { monitoringEnabled: true, routeModes: ['RF'] });
  await sourceRepo.updateSourceRoute(pool, c.id, { monitoringEnabled: true, routeModes: ['DUBAI', 'ABU_DHABI'] });

  const dubaiOnly = await sourceRepo.listSources(pool, { accountId: 'src-it-7', routeMode: 'DUBAI' });
  assert.equal(dubaiOnly.length, 2, 'containment filter must also surface the multi-market source');
  assert.deepEqual(dubaiOnly.map((s) => s.name).sort(), ['Dubai Group', 'Dubai+AbuDhabi Group']);
});

test('sync run lifecycle: startSyncRun/completeSyncRun/failSyncRun persist correctly', async () => {
  const runId = await sourceRepo.startSyncRun(pool, { provider: 'telegram', accountId: 'src-it-8' });
  await sourceRepo.completeSyncRun(pool, runId, { sourcesSeen: 3, sourcesCreated: 2, sourcesUpdated: 1, sourcesMarkedUnavailable: 0 });
  const { rows } = await pool.query(`SELECT * FROM ingest.source_sync_runs WHERE id = $1`, [runId]);
  assert.equal(rows[0].status, 'SUCCESS');
  assert.equal(rows[0].sources_created, 2);
});

// Read-only duplicate indicator (2026-09-27): the same physical group
// synced under two of our own accounts (found live: nikaestate_ae joining
// groups tg_main already monitored). Read-only by explicit product
// decision -- this only surfaces the pair, never merges/disables/deletes.
test('findDuplicateExternalIds: the same (provider, external_source_id) under two different accounts is reported as a duplicate', async () => {
  await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-9a', externalSourceId: '-1009001', name: 'Shared Group' });
  await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-9b', externalSourceId: '-1009001', name: 'Shared Group' });

  const duplicates = await sourceRepo.findDuplicateExternalIds(pool);
  const entry = duplicates.get('telegram:-1009001');
  assert.ok(entry, 'expected a duplicate entry for the shared external_source_id');
  assert.equal(entry.accountCount, 2);
  assert.deepEqual(entry.accountIds.sort(), ['src-it-9a', 'src-it-9b']);
});

test('findDuplicateExternalIds: the same external_source_id under only ONE account is never reported as a duplicate', async () => {
  await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-10', externalSourceId: '-1010001', name: 'Solo Group' });

  const duplicates = await sourceRepo.findDuplicateExternalIds(pool);
  assert.equal(duplicates.has('telegram:-1010001'), false);
});

test('findDuplicateExternalIds: the same external_source_id under the SAME account twice (re-sync, not a duplicate) is never reported', async () => {
  const first = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-11', externalSourceId: '-1011001', name: 'Re-synced Group' });
  const second = await sourceRepo.upsertSource(pool, { provider: 'telegram', accountId: 'src-it-11', externalSourceId: '-1011001', name: 'Re-synced Group (renamed)' });
  assert.equal(second.id, first.id, 'sanity: this is genuinely the same row, not two');

  const duplicates = await sourceRepo.findDuplicateExternalIds(pool);
  assert.equal(duplicates.has('telegram:-1011001'), false);
});
