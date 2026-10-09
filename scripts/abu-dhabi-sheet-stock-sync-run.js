#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { createPool } = require('../src/db/pool');
const { buildSheetsClient, readSheetRows } = require('../src/google-sheets/sheets-client');
const { validateStockRow, dedupeStockRows, validateAliasRow, dedupeAliasRows } = require('../src/core/sync-normalize');
const stockRepo = require('../src/db/abuDhabiStockRepository');
const aliasRepo = require('../src/db/abuDhabiAliasRepository');
const syncRunRepo = require('../src/db/abuDhabiStockSyncRepository');

// Abu Dhabi's own Google Sheets stock sync (AGENTS.md section 3/4; built
// BY ANALOGY with Dubai's ORIGINAL sheet-era sync, whose exact row contract
// was recovered from git history -- see docs/DECISIONS.md's Abu Dhabi ADR).
// Dubai's own sync is Joker-CRM-driven today and does not run this path;
// Abu Dhabi has no Joker feed, so Google Sheets remains its real source.
//
// Dry-run by default (AGENTS.md section 10's discipline, still followed
// even though the n8n tooling it was written for is retired -- see
// scripts/joker-stock-sync-run.js for the live precedent this mirrors). A
// real write requires BOTH the explicit --write flag AND
// ABU_DHABI_SHEET_SYNC_ALLOW_WRITE=true in the environment.
async function main() {
  const wantsWrite = process.argv.includes('--write');
  const dryRun = !wantsWrite;

  if (wantsWrite && process.env.ABU_DHABI_SHEET_SYNC_ALLOW_WRITE !== 'true') {
    console.log('abu-dhabi-sheet-stock-sync REFUSED: --write was passed but ABU_DHABI_SHEET_SYNC_ALLOW_WRITE is not exactly "true".');
    console.log('Set ABU_DHABI_SHEET_SYNC_ALLOW_WRITE=true in .env only after reviewing a dry-run output.');
    process.exit(1);
  }

  const spreadsheetId = process.env.ABU_DHABI_GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    console.error('abu-dhabi-sheet-stock-sync FAILED: ABU_DHABI_GOOGLE_SHEETS_SPREADSHEET_ID is not set.');
    process.exit(1);
  }
  const stockTab = process.env.ABU_DHABI_GOOGLE_SHEETS_STOCK_TAB || 'Stock Inventory';
  const aliasesTab = process.env.ABU_DHABI_GOOGLE_SHEETS_ALIASES_TAB || 'Aliases';

  console.log(dryRun ? '[abu-dhabi-sheet-stock-sync] DRY RUN -- scanning only, writing nothing.' : '[abu-dhabi-sheet-stock-sync] LIVE RUN -- writing to matching_abu_dhabi.*.');

  const sheets = buildSheetsClient();
  const pool = createPool();
  let syncRun = null;

  try {
    if (!dryRun) syncRun = await syncRunRepo.startRun(pool);

    const [rawStockRows, rawAliasRows] = await Promise.all([
      readSheetRows(sheets, { spreadsheetId, tabName: stockTab }),
      readSheetRows(sheets, { spreadsheetId, tabName: aliasesTab }),
    ]);
    console.log(`Read ${rawStockRows.length} raw stock row(s) from "${stockTab}", ${rawAliasRows.length} raw alias row(s) from "${aliasesTab}".`);

    const validatedStock = [];
    const rejectedStock = [];
    for (const raw of rawStockRows) {
      const { value, errors } = validateStockRow(raw);
      if (value) validatedStock.push(value);
      else rejectedStock.push({ row: raw, errors });
    }
    const { rows: dedupedStock, duplicates: dupStockIds } = dedupeStockRows(validatedStock);

    const validatedAliases = [];
    const rejectedAliases = [];
    for (const raw of rawAliasRows) {
      const { value, errors } = validateAliasRow(raw);
      if (value) validatedAliases.push(value);
      else rejectedAliases.push({ row: raw, errors });
    }
    const { rows: dedupedAliases, duplicates: dupAliasKeys } = dedupeAliasRows(validatedAliases);

    const activeCount = dedupedStock.filter((r) => r.status === 'ACTIVE').length;

    console.log(`\nStock: ${dedupedStock.length} valid (${activeCount} ACTIVE), ${rejectedStock.length} rejected, ${dupStockIds.length} duplicate stock_id(s) collapsed.`);
    if (rejectedStock.length) console.log('  Rejected stock rows:', JSON.stringify(rejectedStock).slice(0, 2000));
    console.log(`Aliases: ${dedupedAliases.length} valid, ${rejectedAliases.length} rejected, ${dupAliasKeys.length} duplicate (type, alias) pair(s) collapsed.`);
    if (rejectedAliases.length) console.log('  Rejected alias rows:', JSON.stringify(rejectedAliases).slice(0, 2000));

    if (!dryRun) {
      await stockRepo.upsertStockRows(pool, dedupedStock);
      await aliasRepo.upsertAliasRows(pool, dedupedAliases);
      await syncRunRepo.completeRun(pool, syncRun.id, {
        status: 'SUCCESS',
        stockRowsRead: rawStockRows.length,
        stockRowsActive: activeCount,
        aliasRowsRead: rawAliasRows.length,
      });
      console.log(`\nWrote ${dedupedStock.length} stock row(s) and ${dedupedAliases.length} alias row(s) to matching_abu_dhabi.*. Sync run #${syncRun.id} recorded as SUCCESS.`);
    } else {
      console.log('\nDry run only -- nothing was written. Re-run with --write (and ABU_DHABI_SHEET_SYNC_ALLOW_WRITE=true) to persist.');
    }
  } catch (err) {
    if (syncRun) {
      await syncRunRepo.completeRun(pool, syncRun.id, {
        status: 'FAILED',
        stockRowsRead: 0,
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
  console.error('[abu-dhabi-sheet-stock-sync] FAILED:', err);
  process.exit(1);
});
