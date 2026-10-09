'use strict';

// Regression tests for the P0 release blocker fixed in
// dashboard/source-queries.js: a telegram-worker/whatsapp-worker HTTP
// failure (timeout, 500, auth failure) must never be silently treated as
// "this account genuinely has zero dialogs/groups" -- that would make
// source-sync.js's markMissingSourcesUnavailable() wrongly flip every
// existing source for the account to available=false. See AUDIT item #1.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncTelegramAccount: realSyncTelegram, syncWhatsappAccount: realSyncWhatsapp } = require('../../src/sources/source-sync');
const { syncAllSources } = require('../../dashboard/source-queries');

// Same in-memory fake repo shape as tests/unit/source-sync.test.js, kept
// as a local copy so this file can exercise the REAL source-sync.js logic
// (not a stub) end-to-end from dashboard/source-queries.js's own
// syncAllSources orchestration, with no real Postgres/worker involved.
function makeFakeRepo(seedSources = []) {
  const sources = new Map();
  for (const s of seedSources) {
    sources.set(`${s.provider}:${s.accountId}:${s.externalSourceId}`, { ...s, available: true });
  }
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
      Object.assign(syncRuns[runId - 1], { status: 'FAILED', error: String(err?.message || err) });
    },
    async upsertSource(pool, args) {
      const key = `${args.provider}:${args.accountId}:${args.externalSourceId}`;
      const inserted = !sources.has(key);
      sources.set(key, { ...args, available: true });
      return { id: key, inserted };
    },
    async markMissingSourcesUnavailable(pool, { provider, accountId, seenExternalSourceIds }) {
      let count = 0;
      for (const source of sources.values()) {
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

function seedNSources(provider, accountId, n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({ provider, accountId, externalSourceId: String(-1000 - i) });
  }
  return rows;
}

test('P0: Telegram worker HTTP failure fails the sync run and marks ZERO sources unavailable (existing 89 stay available=true)', async () => {
  const repo = makeFakeRepo(seedNSources('telegram', 'tg_main', 89));
  const fakeWorkers = {
    getTelegramStatus: async () => ({ reachable: true, accounts: [{ account_id: 'tg_main', connected: true, authorized: true, status: 'ok' }] }),
    getTelegramDialogsForAccount: async () => ({ ok: false, error: 'HTTP 500' }),
    getWhatsappStatus: async () => ({ reachable: false, error: 'not configured' }),
  };

  const result = await syncAllSources({}, {
    workers: fakeWorkers,
    syncTelegramAccount: (pool, args) => realSyncTelegram(pool, { ...args, repo }),
    syncWhatsappAccount: (pool, args) => realSyncWhatsapp(pool, { ...args, repo }),
  });

  assert.equal(result.telegram[0].ok, false);
  assert.match(result.telegram[0].error, /HTTP 500/);
  assert.equal(repo.syncRuns[0].status, 'FAILED');
  for (const source of repo.sources.values()) {
    assert.equal(source.available, true, `source ${source.externalSourceId} must remain available=true after a worker fetch failure`);
  }
});

test('P0: WhatsApp worker HTTP failure fails the sync run and marks ZERO sources unavailable', async () => {
  const repo = makeFakeRepo(seedNSources('whatsapp', 'wa_main', 24));
  const fakeWorkers = {
    getTelegramStatus: async () => ({ reachable: false, error: 'not configured' }),
    getWhatsappStatus: async () => ({ reachable: true, accounts: [{ account_id: 'wa_main', connected: true, status: 'ok' }] }),
    getWhatsappGroups: async () => ({ ok: false, error: 'timed out' }),
  };

  const result = await syncAllSources({}, {
    workers: fakeWorkers,
    syncTelegramAccount: (pool, args) => realSyncTelegram(pool, { ...args, repo }),
    syncWhatsappAccount: (pool, args) => realSyncWhatsapp(pool, { ...args, repo }),
  });

  assert.equal(result.whatsapp[0].ok, false);
  assert.match(result.whatsapp[0].error, /timed out/);
  assert.equal(repo.syncRuns[0].status, 'FAILED');
  for (const source of repo.sources.values()) {
    assert.equal(source.available, true, `source ${source.externalSourceId} must remain available=true after a worker fetch failure`);
  }
});

test('a genuinely successful empty dialog list is still a valid sync and MAY mark missing sources unavailable', async () => {
  const repo = makeFakeRepo(seedNSources('telegram', 'tg_main', 3));
  const fakeWorkers = {
    getTelegramStatus: async () => ({ reachable: true, accounts: [{ account_id: 'tg_main', connected: true, authorized: true, status: 'ok' }] }),
    getTelegramDialogsForAccount: async () => ({ ok: true, data: { dialogs: [] } }),
    getWhatsappStatus: async () => ({ reachable: false, error: 'not configured' }),
  };

  const result = await syncAllSources({}, {
    workers: fakeWorkers,
    syncTelegramAccount: (pool, args) => realSyncTelegram(pool, { ...args, repo }),
    syncWhatsappAccount: (pool, args) => realSyncWhatsapp(pool, { ...args, repo }),
  });

  assert.equal(result.telegram[0].ok, true);
  assert.equal(repo.syncRuns[0].status, 'SUCCESS');
  assert.equal(result.telegram[0].sourcesMarkedUnavailable, 3, 'a real empty result is a legitimate signal that every previously-known source disappeared');
  for (const source of repo.sources.values()) {
    assert.equal(source.available, false);
  }
});

test('one account failing does not stop other accounts from syncing (best-effort per account)', async () => {
  const repo = makeFakeRepo();
  const fakeWorkers = {
    getTelegramStatus: async () => ({
      reachable: true,
      accounts: [
        { account_id: 'tg_bad', connected: true, authorized: true, status: 'ok' },
        { account_id: 'tg_good', connected: true, authorized: true, status: 'ok' },
      ],
    }),
    getTelegramDialogsForAccount: async (accountId) => (
      accountId === 'tg_bad' ? { ok: false, error: 'HTTP 500' } : { ok: true, data: { dialogs: [] } }
    ),
    getWhatsappStatus: async () => ({ reachable: false, error: 'not configured' }),
  };

  const result = await syncAllSources({}, {
    workers: fakeWorkers,
    syncTelegramAccount: (pool, args) => realSyncTelegram(pool, { ...args, repo }),
    syncWhatsappAccount: (pool, args) => realSyncWhatsapp(pool, { ...args, repo }),
  });

  assert.equal(result.telegram.find((r) => r.accountId === 'tg_bad').ok, false);
  assert.equal(result.telegram.find((r) => r.accountId === 'tg_good').ok, true);
});
