'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncTelegramAccount, syncWhatsappAccount } = require('../../src/sources/source-sync');

function makeFakeRepo() {
  const sources = new Map();
  const syncRuns = [];
  return {
    sources,
    syncRuns,
    async startSyncRun(pool, { provider, accountId }) {
      const id = syncRuns.length + 1;
      syncRuns.push({ id, provider, accountId, status: 'RUNNING' });
      return id;
    },
    async completeSyncRun(pool, runId, summary) {
      Object.assign(syncRuns[runId - 1], { status: 'SUCCESS', ...summary });
    },
    async failSyncRun(pool, runId, err) {
      Object.assign(syncRuns[runId - 1], { status: 'FAILED', error: String(err) });
    },
    async upsertSource(pool, args) {
      const key = `${args.provider}:${args.accountId}:${args.externalSourceId}`;
      const inserted = !sources.has(key);
      sources.set(key, { ...args, available: true });
      return { id: key, inserted };
    },
    async markMissingSourcesUnavailable(pool, { provider, accountId, seenExternalSourceIds }) {
      let count = 0;
      for (const [key, source] of sources.entries()) {
        if (source.provider !== provider || source.accountId !== accountId) continue;
        if (!source.available) continue;
        if (!seenExternalSourceIds.includes(source.externalSourceId)) {
          source.available = false;
          count += 1;
        }
      }
      return count;
    },
  };
}

test('syncTelegramAccount: upserts groups/channels, skips private dialogs entirely', async () => {
  const repo = makeFakeRepo();
  const fetchDialogs = async () => ({
    dialogs: [
      { destination_id: '-1001111', name: 'Dubai Brokers', username: 'dubai_brokers', destination_type: 'channel', is_group: false, is_channel: true, is_private: false },
      { destination_id: '-1002222', name: 'RF Brokers', username: null, destination_type: 'group', is_group: true, is_channel: false, is_private: false },
      { destination_id: '99999', name: 'Some Contact', username: 'john', destination_type: 'private', is_group: false, is_channel: false, is_private: true },
    ],
  });

  const result = await syncTelegramAccount({}, { accountId: 'tg_main', fetchDialogs, repo });

  assert.equal(result.sourcesSeen, 2, 'private dialogs must never become sources');
  assert.equal(result.sourcesCreated, 2);
  assert.ok(repo.sources.has('telegram:tg_main:-1001111'));
  assert.ok(repo.sources.has('telegram:tg_main:-1002222'));
  assert.ok(!repo.sources.has('telegram:tg_main:99999'));
});

test('syncTelegramAccount: a resync marks a disappeared group unavailable, never deletes it', async () => {
  const repo = makeFakeRepo();
  await syncTelegramAccount({}, {
    accountId: 'tg_main',
    fetchDialogs: async () => ({ dialogs: [{ destination_id: '-1001111', name: 'Dubai Brokers', is_group: true, is_channel: false }] }),
    repo,
  });

  const secondResult = await syncTelegramAccount({}, {
    accountId: 'tg_main',
    fetchDialogs: async () => ({ dialogs: [] }), // the group is gone from the account now
    repo,
  });

  assert.equal(secondResult.sourcesMarkedUnavailable, 1);
  assert.equal(repo.sources.get('telegram:tg_main:-1001111').available, false);
});

test('syncTelegramAccount: re-syncing the same group again is an update, not a duplicate create', async () => {
  const repo = makeFakeRepo();
  const fetchDialogs = async () => ({ dialogs: [{ destination_id: '-1001111', name: 'Dubai Brokers', is_group: true, is_channel: false }] });

  const first = await syncTelegramAccount({}, { accountId: 'tg_main', fetchDialogs, repo });
  const second = await syncTelegramAccount({}, { accountId: 'tg_main', fetchDialogs, repo });

  assert.equal(first.sourcesCreated, 1);
  assert.equal(second.sourcesCreated, 0);
  assert.equal(second.sourcesUpdated, 1);
  assert.equal(repo.sources.size, 1, 'must never duplicate the same (provider, account, external_source_id) identity');
});

test('syncTelegramAccount: a sync failure is recorded on the run, and the error still propagates', async () => {
  const repo = makeFakeRepo();
  await assert.rejects(() =>
    syncTelegramAccount({}, { accountId: 'tg_main', fetchDialogs: async () => { throw new Error('worker unreachable'); }, repo })
  );
  assert.equal(repo.syncRuns[0].status, 'FAILED');
});

test('syncWhatsappAccount: upserts groups keyed by JID, carries participant count', async () => {
  const repo = makeFakeRepo();
  const fetchGroups = async () => ({
    groups: [{ destination_id: '123456789@g.us', name: 'Dubai Brokers WA', owner: '971500000000@s.whatsapp.net', participants: 42 }],
  });

  const result = await syncWhatsappAccount({}, { accountId: 'wa_main', fetchGroups, repo });

  assert.equal(result.sourcesCreated, 1);
  const source = repo.sources.get('whatsapp:wa_main:123456789@g.us');
  assert.equal(source.memberCount, 42);
});

test('multi-account identity: the same-looking external_source_id on two different accounts never collides (P1.6)', async () => {
  const repo = makeFakeRepo();
  await syncTelegramAccount({}, { accountId: 'tg_main', fetchDialogs: async () => ({ dialogs: [{ destination_id: '-1001111', name: 'X', is_group: true }] }), repo });
  await syncTelegramAccount({}, { accountId: 'tg_sales_1', fetchDialogs: async () => ({ dialogs: [{ destination_id: '-1001111', name: 'X (seen from a second account)', is_group: true }] }), repo });

  assert.equal(repo.sources.size, 2, 'the same chat monitored by two accounts must be two distinct source rows');
});
