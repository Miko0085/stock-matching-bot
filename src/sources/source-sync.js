'use strict';

// Source synchronization (MARKET_CONTOURS_AND_SOURCE_ROUTING.md section 9).
// Queries the EXISTING, already-authenticated telegram-worker/whatsapp-
// worker HTTP APIs -- never opens a second Telethon/Baileys session just
// to inventory groups. Pure orchestration: HTTP fetch + repository upsert,
// no market/domain logic at all.
//
// `fetchDialogs`/`fetchGroups` are injected async functions (same
// dependency-injection convention as lead-matching-service) so this stays
// unit-testable without a real running worker.

const sourceRepo = require('./source-repository');

// `fetchDialogs(accountId)` must resolve to the telegram-worker
// `/telegram/dialogs` response body: { dialogs: [{destination_id, name,
// username, destination_type, is_group, is_channel, is_private}, ...] }.
async function syncTelegramAccount(pool, { accountId, fetchDialogs, repo = sourceRepo }) {
  const runId = await repo.startSyncRun(pool, { provider: 'telegram', accountId });
  try {
    const response = await fetchDialogs(accountId);
    const dialogs = (response?.dialogs || []).filter((d) => d.is_group || d.is_channel);

    let created = 0;
    let updated = 0;
    const seenIds = [];

    for (const dialog of dialogs) {
      const externalSourceId = String(dialog.destination_id);
      seenIds.push(externalSourceId);
      const { inserted } = await repo.upsertSource(pool, {
        provider: 'telegram',
        accountId,
        externalSourceId,
        sourceType: dialog.destination_type || (dialog.is_channel ? 'channel' : 'group'),
        name: dialog.name || null,
        usernameOrHandle: dialog.username || null,
        memberCount: null,
        joined: true,
        available: true,
        metadata: { entity_type: dialog.entity_type || null },
      });
      if (inserted) created += 1;
      else updated += 1;
    }

    const markedUnavailable = await repo.markMissingSourcesUnavailable(pool, {
      provider: 'telegram',
      accountId,
      seenExternalSourceIds: seenIds,
    });

    await repo.completeSyncRun(pool, runId, {
      sourcesSeen: dialogs.length,
      sourcesCreated: created,
      sourcesUpdated: updated,
      sourcesMarkedUnavailable: markedUnavailable,
    });

    return { runId, sourcesSeen: dialogs.length, sourcesCreated: created, sourcesUpdated: updated, sourcesMarkedUnavailable: markedUnavailable };
  } catch (err) {
    await repo.failSyncRun(pool, runId, err);
    throw err;
  }
}

// `fetchGroups(accountId)` must resolve to the whatsapp-worker
// `/whatsapp/groups` response body: { groups: [{destination_id, name,
// owner, participants}, ...] }.
async function syncWhatsappAccount(pool, { accountId, fetchGroups, repo = sourceRepo }) {
  const runId = await repo.startSyncRun(pool, { provider: 'whatsapp', accountId });
  try {
    const response = await fetchGroups(accountId);
    const groups = response?.groups || [];

    let created = 0;
    let updated = 0;
    const seenIds = [];

    for (const group of groups) {
      const externalSourceId = String(group.destination_id);
      seenIds.push(externalSourceId);
      const { inserted } = await repo.upsertSource(pool, {
        provider: 'whatsapp',
        accountId,
        externalSourceId,
        sourceType: 'group',
        name: group.name || null,
        usernameOrHandle: null,
        memberCount: Number.isFinite(group.participants) ? group.participants : null,
        joined: true,
        available: true,
        metadata: { owner: group.owner || null },
      });
      if (inserted) created += 1;
      else updated += 1;
    }

    const markedUnavailable = await repo.markMissingSourcesUnavailable(pool, {
      provider: 'whatsapp',
      accountId,
      seenExternalSourceIds: seenIds,
    });

    await repo.completeSyncRun(pool, runId, {
      sourcesSeen: groups.length,
      sourcesCreated: created,
      sourcesUpdated: updated,
      sourcesMarkedUnavailable: markedUnavailable,
    });

    return { runId, sourcesSeen: groups.length, sourcesCreated: created, sourcesUpdated: updated, sourcesMarkedUnavailable: markedUnavailable };
  } catch (err) {
    await repo.failSyncRun(pool, runId, err);
    throw err;
  }
}

module.exports = { syncTelegramAccount, syncWhatsappAccount };
