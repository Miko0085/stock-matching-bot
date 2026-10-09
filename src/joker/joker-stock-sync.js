'use strict';

// Orchestrates a full Joker catalog scan into the 4 Joker-fed market
// tables (matching_moscow/matching_oman/matching_saudi/matching_turkey).
// UAE is explicitly skipped (see joker-market-router.js) -- it keeps its
// existing matching_dubai.stock_inventory source for now.
//
// `listObjectsPage` is injected (same DI convention as
// src/sources/source-sync.js's fetchDialogs/fetchGroups) so this is
// unit-testable without a live Joker connection -- in production it's
// dashboard/joker-client.js's listJokerObjectsPage.

const defaultRepo = require('./joker-stock-repository');
const { resolveMarket, classifySkipReason, MARKET_SCHEMAS } = require('./joker-market-router');
const { mapJokerObjectToStockRow } = require('./joker-stock-mapper');

const PAGE_LIMIT = 200;
const MARKET_KEYS = Object.keys(MARKET_SCHEMAS);

// `dryRun: true` scans and reports counts without writing anything --
// AGENTS.md section 10's "every deployment script must support dry-run".
async function syncAllMarkets(pool, { listObjectsPage, dryRun = false, repo = defaultRepo } = {}) {
  const seenIds = Object.fromEntries(MARKET_KEYS.map((k) => [k, []]));
  const upsertedCounts = Object.fromEntries(MARKET_KEYS.map((k) => [k, 0]));
  let totalScanned = 0;
  // Broken down by reason (2026-09-28, strict Moscow-city scope): a skip is
  // no longer just "Dubai" -- most skips today are non-Moscow regions that
  // used to be silently absorbed into the old catch-all. Kept as counts,
  // not just a total, so a sync report can actually show what left scope.
  const skippedBreakdown = { dubai_deliberate_skip: 0, out_of_moscow_scope: 0, no_region: 0 };

  const runIds = {};
  if (!dryRun) {
    for (const market of MARKET_KEYS) {
      runIds[market] = await repo.startSyncRun(pool, MARKET_SCHEMAS[market]);
    }
  }

  try {
    let offset = 0;
    for (;;) {
      const page = await listObjectsPage({ limit: PAGE_LIMIT, offset, full: true });
      if (!page.ok) throw new Error(`Joker fetch failed at offset ${offset}: ${page.error}`);
      const objects = page.data || [];
      if (objects.length === 0) break;
      totalScanned += objects.length;

      for (const obj of objects) {
        const market = resolveMarket(obj.region);
        if (market === null) {
          skippedBreakdown[classifySkipReason(obj.region)] += 1;
          continue;
        }
        seenIds[market].push(obj.id);
        const row = mapJokerObjectToStockRow(obj);
        if (!dryRun) {
          await repo.upsertStockRow(pool, MARKET_SCHEMAS[market], row);
        }
        upsertedCounts[market] += 1;
      }

      offset += objects.length;
      if (objects.length < PAGE_LIMIT) break;
    }

    const markedUnavailable = {};
    if (!dryRun) {
      for (const market of MARKET_KEYS) {
        markedUnavailable[market] = await repo.markMissingUnavailable(pool, MARKET_SCHEMAS[market], seenIds[market]);
        await repo.completeSyncRun(pool, MARKET_SCHEMAS[market], runIds[market], {
          objectsSeen: seenIds[market].length,
          objectsUpserted: upsertedCounts[market],
          objectsMarkedUnavailable: markedUnavailable[market],
        });
      }
    }

    const totalSkipped = Object.values(skippedBreakdown).reduce((a, b) => a + b, 0);

    return {
      dryRun,
      totalScanned,
      totalSkipped,
      skippedBreakdown,
      seenCounts: Object.fromEntries(MARKET_KEYS.map((k) => [k, seenIds[k].length])),
      upsertedCounts,
      markedUnavailable,
    };
  } catch (err) {
    if (!dryRun) {
      for (const market of MARKET_KEYS) {
        if (runIds[market]) await repo.failSyncRun(pool, MARKET_SCHEMAS[market], runIds[market], err).catch(() => {});
      }
    }
    throw err;
  }
}

module.exports = { syncAllMarkets, PAGE_LIMIT };
