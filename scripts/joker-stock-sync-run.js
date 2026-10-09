#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { createPool } = require('../src/db/pool');
const { syncAllMarkets } = require('../src/joker/joker-stock-sync');
const { listJokerObjectsPage } = require('../dashboard/joker-client');

// Dry-run by default (AGENTS.md section 10: "every deployment script must
// support dry-run"). A real write requires BOTH the explicit --write flag
// AND JOKER_STOCK_SYNC_ALLOW_WRITE=true in the environment -- same
// "explicit opt-in, refuse by default" convention as scripts/n8n-deploy.js's
// N8N_ALLOW_WRITE gate. Never runs against production without a human
// having set that variable on purpose.
async function main() {
  const wantsWrite = process.argv.includes('--write');
  const dryRun = !wantsWrite;

  if (wantsWrite && process.env.JOKER_STOCK_SYNC_ALLOW_WRITE !== 'true') {
    console.log('joker-stock-sync REFUSED: --write was passed but JOKER_STOCK_SYNC_ALLOW_WRITE is not exactly "true".');
    console.log('Set JOKER_STOCK_SYNC_ALLOW_WRITE=true in .env only after reviewing a --dry-run run\'s output.');
    process.exit(1);
  }

  console.log(dryRun ? '[joker-stock-sync] DRY RUN -- scanning only, writing nothing.' : '[joker-stock-sync] LIVE RUN -- writing to matching_moscow/matching_oman/matching_saudi/matching_turkey.');

  const pool = createPool();
  try {
    const result = await syncAllMarkets(pool, { listObjectsPage: listJokerObjectsPage, dryRun });
    console.log('\nScanned total objects:', result.totalScanned);
    console.log('Skipped total:', result.totalSkipped, JSON.stringify(result.skippedBreakdown));
    console.log('\nPer-market seen / upserted / marked-unavailable:');
    for (const market of Object.keys(result.seenCounts)) {
      const unavailable = result.markedUnavailable[market];
      console.log(`  ${market}: seen=${result.seenCounts[market]} upserted=${result.upsertedCounts[market]} marked_unavailable=${unavailable === undefined ? '(dry run)' : unavailable}`);
    }
    if (dryRun) {
      console.log('\nDry run only -- nothing was written. Re-run with --write (and JOKER_STOCK_SYNC_ALLOW_WRITE=true) to persist.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[joker-stock-sync] FAILED:', err);
  process.exit(1);
});
