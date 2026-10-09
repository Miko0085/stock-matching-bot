'use strict';

// Dashboard-side orchestration for the Sources/Channels page. Reuses
// src/sources/* (the shared control-plane repository/sync logic) and
// this dashboard's own existing worker HTTP client (workers.js) --
// no new service, no duplicated Telethon/Baileys access.

const sourceRepo = require('../src/sources/source-repository');
const sourceSync = require('../src/sources/source-sync');
const realWorkers = require('./workers');

async function listSources(pool, filters) {
  return sourceRepo.listSources(pool, filters);
}

async function findDuplicateExternalIds(pool) {
  return sourceRepo.findDuplicateExternalIds(pool);
}

async function listAccounts(pool) {
  return sourceRepo.listAccounts(pool);
}

async function updateSourceRoute(pool, sourceId, patch) {
  return sourceRepo.updateSourceRoute(pool, sourceId, patch);
}

async function bulkUpdateSourceRoutes(pool, sourceIds, patch) {
  return sourceRepo.bulkUpdateSourceRoutes(pool, sourceIds, patch);
}

// Syncs every currently-known, authorized Telegram account and every
// loaded WhatsApp account. Best-effort per account -- one account's
// failure (worker unreachable, not authorized) never stops the others.
//
// `workers`/`syncTelegramAccount`/`syncWhatsappAccount` are injectable
// (default to the real modules) so the P0 fetch-error-propagation
// behavior below is unit-testable without a real telegram-worker/
// whatsapp-worker/Postgres -- same dependency-injection convention as
// lead-matching-service and src/sources/source-sync.js itself.
async function syncAllSources(pool, {
  workers = realWorkers,
  syncTelegramAccount = sourceSync.syncTelegramAccount,
  syncWhatsappAccount = sourceSync.syncWhatsappAccount,
} = {}) {
  const results = { telegram: [], whatsapp: [] };

  const telegramStatus = await workers.getTelegramStatus();
  if (telegramStatus.reachable) {
    for (const account of telegramStatus.accounts) {
      if (!(account.connected && account.authorized)) {
        results.telegram.push({ accountId: account.account_id, ok: false, error: `not connected/authorized (status: ${account.status})` });
        continue;
      }
      try {
        const summary = await syncTelegramAccount(pool, {
          accountId: account.account_id,
          fetchDialogs: async (accountId) => {
            const r = await workers.getTelegramDialogsForAccount(accountId);
            // P0 release blocker: a worker HTTP failure (timeout, 500,
            // auth failure) must never look like a valid "this account has
            // zero dialogs" result -- that would make syncTelegramAccount's
            // markMissingSourcesUnavailable() wrongly flip every existing
            // source for this account to available=false. A real fetch
            // failure must abort the sync run (status=FAILED) with
            // existing source availability left untouched.
            if (!r.ok) throw new Error(`Telegram dialogs fetch failed: ${r.error}`);
            return r.data;
          },
        });
        results.telegram.push({ accountId: account.account_id, ok: true, ...summary });
      } catch (err) {
        results.telegram.push({ accountId: account.account_id, ok: false, error: err.message });
      }
    }
  } else {
    results.telegram.push({ accountId: null, ok: false, error: `telegram-worker unreachable: ${telegramStatus.error}` });
  }

  const whatsappStatus = await workers.getWhatsappStatus();
  if (whatsappStatus.reachable) {
    for (const account of whatsappStatus.accounts) {
      if (!account.connected) {
        results.whatsapp.push({ accountId: account.account_id, ok: false, error: `not connected (status: ${account.status})` });
        continue;
      }
      try {
        const summary = await syncWhatsappAccount(pool, {
          accountId: account.account_id,
          fetchGroups: async (accountId) => {
            const r = await workers.getWhatsappGroups(accountId);
            // Same P0 fix as Telegram above: a fetch failure must abort
            // the sync (FAILED run, no availability change), never be
            // treated as "this account genuinely has zero groups."
            if (!r.ok) throw new Error(`WhatsApp groups fetch failed: ${r.error}`);
            return r.data;
          },
        });
        results.whatsapp.push({ accountId: account.account_id, ok: true, ...summary });
      } catch (err) {
        results.whatsapp.push({ accountId: account.account_id, ok: false, error: err.message });
      }
    }
  } else {
    results.whatsapp.push({ accountId: null, ok: false, error: `whatsapp-worker unreachable: ${whatsappStatus.error}` });
  }

  return results;
}

module.exports = { listSources, listAccounts, findDuplicateExternalIds, updateSourceRoute, bulkUpdateSourceRoutes, syncAllSources };
