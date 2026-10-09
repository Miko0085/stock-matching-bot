#!/usr/bin/env node
'use strict';

require('dotenv').config();
const path = require('path');
const { createPool } = require('../src/db/pool');
const { readXlsxRows } = require('../src/core/xlsx-reader');
const { validateStockRow, dedupeStockRows } = require('../src/core/sync-normalize');
const stockRepo = require('../src/db/stockRepository');
const syncRunRepo = require('../src/db/stockSyncRepository');

// One-off/occasional bulk import of a broker-provided "pocket listings"
// spreadsheet into matching_dubai.stock_inventory -- a second stock source
// alongside the main sync, tagged stock_source='POCKET_LISTING' so it's
// distinguishable (AGENTS.md section 3/4: ACTIVE scope and SALE default
// still apply identically; this is an additional INPUT, not a new table or
// a new matching code path).
//
// HARD RULE (AGENTS.md section 0): this file spans multiple emirates in
// practice (confirmed on the real file used to build this script: 200
// Dubai / 14 Abu Dhabi / 3 Sharjah / 1 blank, out of 218 rows) -- a Dubai
// matcher MUST NEVER query Abu Dhabi stock. Every row is filtered to
// `city === 'Dubai'` (exact, case-sensitive match to the sheet's own
// vocabulary) BEFORE validation; every non-Dubai row is reported, never
// silently dropped and never written to matching_dubai.* or any other
// schema by this script.
//
// Dry-run by default (AGENTS.md section 10's discipline, same as
// scripts/abu-dhabi-sheet-stock-sync-run.js/scripts/joker-stock-sync-run.js).
// A real write needs BOTH --write on the command line AND
// DUBAI_POCKET_STOCK_IMPORT_ALLOW_WRITE=true in the environment.
async function main() {
  const filePath = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'));
  const wantsWrite = process.argv.includes('--write');
  const dryRun = !wantsWrite;

  if (!filePath) {
    console.error('Usage: node scripts/dubai-pocket-stock-import-run.js <path-to-.xlsx> [--write]');
    process.exit(1);
  }
  if (wantsWrite && process.env.DUBAI_POCKET_STOCK_IMPORT_ALLOW_WRITE !== 'true') {
    console.log('dubai-pocket-stock-import REFUSED: --write was passed but DUBAI_POCKET_STOCK_IMPORT_ALLOW_WRITE is not exactly "true".');
    console.log('Set DUBAI_POCKET_STOCK_IMPORT_ALLOW_WRITE=true in .env only after reviewing a dry-run output.');
    process.exit(1);
  }

  console.log(dryRun
    ? `[dubai-pocket-stock-import] DRY RUN -- reading ${path.resolve(filePath)}, writing nothing.`
    : `[dubai-pocket-stock-import] LIVE RUN -- writing Dubai-only rows to matching_dubai.stock_inventory.`);

  const rawRows = await readXlsxRows(filePath);
  console.log(`Read ${rawRows.length} raw row(s) from the sheet.`);

  const byCity = new Map();
  for (const r of rawRows) {
    const city = r.city || '(blank)';
    byCity.set(city, (byCity.get(city) || 0) + 1);
  }
  console.log('Rows by city:', Object.fromEntries(byCity));

  const dubaiRows = rawRows.filter((r) => r.city === 'Dubai');
  const excludedCount = rawRows.length - dubaiRows.length;
  if (excludedCount > 0) {
    console.log(`Excluding ${excludedCount} non-Dubai row(s) (see "Rows by city" above) -- AGENTS.md section 0 forbids mixing another market's stock into matching_dubai.*. Those rows were NOT written anywhere by this script.`);
  }

  const validated = [];
  const rejected = [];
  for (const raw of dubaiRows) {
    const { value, errors } = validateStockRow(raw);
    if (value) validated.push({ ...value, stock_source: 'POCKET_LISTING' });
    else rejected.push({ row: raw, errors });
  }
  const { rows: deduped, duplicates: dupStockIds } = dedupeStockRows(validated);
  const activeCount = deduped.filter((r) => r.status === 'ACTIVE').length;

  console.log(`\nDubai rows: ${deduped.length} valid (${activeCount} ACTIVE), ${rejected.length} rejected, ${dupStockIds.length} duplicate stock_id(s) collapsed.`);
  if (rejected.length) console.log('  Rejected rows:', JSON.stringify(rejected).slice(0, 2000));
  if (dupStockIds.length) console.log('  Duplicate stock_id(s):', dupStockIds);

  if (dryRun) {
    console.log('\nDry run only -- nothing was written. Re-run with --write (and DUBAI_POCKET_STOCK_IMPORT_ALLOW_WRITE=true) to persist.');
    return;
  }

  const pool = createPool();
  let syncRun = null;
  try {
    syncRun = await syncRunRepo.startRun(pool);
    await stockRepo.upsertStockRows(pool, deduped);
    await syncRunRepo.completeRun(pool, syncRun.id, {
      status: 'SUCCESS',
      stockRowsRead: rawRows.length,
      stockRowsActive: activeCount,
      aliasRowsRead: 0,
    });
    console.log(`\nWrote ${deduped.length} stock row(s) (stock_source='POCKET_LISTING') to matching_dubai.stock_inventory. Sync run #${syncRun.id} recorded as SUCCESS.`);
  } catch (err) {
    if (syncRun) {
      await syncRunRepo.completeRun(pool, syncRun.id, {
        status: 'FAILED',
        stockRowsRead: rawRows.length,
        stockRowsActive: 0,
        aliasRowsRead: 0,
        error: err.message,
      }).catch(() => {});
    }
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[dubai-pocket-stock-import] FAILED:', err);
  process.exit(1);
});
