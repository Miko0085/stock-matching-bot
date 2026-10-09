#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { createPool } = require('../src/db/pool');
const { groupStockContactsByPhone, chooseDisplayName } = require('../src/core/broker-backfill');

// One-time (re-runnable/idempotent) backfill that activates the dormant
// migration-0009 broker-routing schema: matching_dubai.brokers has only a
// handful of manually-created rows and stock_inventory.broker_id is 0%
// populated in production, even though 246 of 286 ACTIVE stock rows carry
// a real (free-text) broker_contact. This script dedupes those 18 distinct
// phone numbers into real `brokers` rows and backfills `broker_id`, which
// the new per-broker notification feature (broker-notifier.js,
// broker_notification_routes) needs to have anyone to route to.
//
// Dubai-only (AGENTS.md section 0 -- matching_dubai.* exclusively, never
// touches matching_moscow/matching_abu_dhabi stock or brokers).
//
// Dry-run by default (AGENTS.md section 10's discipline, same as
// scripts/dubai-pocket-stock-import-run.js). A real write needs BOTH
// --write on the command line AND BROKER_BACKFILL_ALLOW_WRITE=true in the
// environment.
async function main() {
  const wantsWrite = process.argv.includes('--write');
  const dryRun = !wantsWrite;

  if (wantsWrite && process.env.BROKER_BACKFILL_ALLOW_WRITE !== 'true') {
    console.log('[broker-backfill] REFUSED: --write was passed but BROKER_BACKFILL_ALLOW_WRITE is not exactly "true".');
    console.log('Set BROKER_BACKFILL_ALLOW_WRITE=true in .env only after reviewing a dry-run output.');
    process.exit(1);
  }

  console.log(dryRun
    ? '[broker-backfill] DRY RUN -- reading matching_dubai.stock_inventory, writing nothing.'
    : '[broker-backfill] LIVE RUN -- writing to matching_dubai.brokers / stock_inventory.broker_id.');

  const pool = createPool();
  try {
    const { rows } = await pool.query(
      `SELECT stock_id, broker, broker_contact FROM matching_dubai.stock_inventory
       WHERE status = 'ACTIVE' AND broker_contact IS NOT NULL AND broker_contact <> ''`
    );
    console.log(`[broker-backfill] ${rows.length} ACTIVE stock row(s) with a non-empty broker_contact.`);

    const { groups, skipped } = groupStockContactsByPhone(rows);
    console.log(`[broker-backfill] ${groups.length} distinct normalized phone(s); ${skipped.length} row(s) could not be normalized (no digits in broker_contact) -- skipped, never written.`);
    if (skipped.length) {
      console.log('  Unnormalizable rows:', JSON.stringify(skipped.map((r) => ({ stock_id: r.stock_id, broker: r.broker, broker_contact: r.broker_contact }))));
    }

    let created = 0;
    let matched = 0;
    let stockRowsBackfilled = 0;

    for (const group of groups) {
      const displayName = chooseDisplayName(group.names) || group.normalizedPhone;
      if (group.names.size > 1) {
        console.log(`  [multi-name] phone ${group.normalizedPhone}: seen as ${JSON.stringify(Array.from(group.names))} -> chose "${displayName}"`);
      }

      if (dryRun) {
        console.log(`  [dry-run] would upsert broker normalized_phone=${group.normalizedPhone} name="${displayName}" (${group.stockIds.length} stock row(s): ${group.stockIds.join(', ')})`);
        continue;
      }

      const { rows: existing } = await pool.query(
        `SELECT id, source_display_names FROM matching_dubai.brokers WHERE normalized_phone = $1`,
        [group.normalizedPhone]
      );

      let brokerId;
      if (existing.length > 0) {
        brokerId = existing[0].id;
        const priorNames = new Set(existing[0].source_display_names || []);
        for (const n of group.names) priorNames.add(n);
        await pool.query(
          `UPDATE matching_dubai.brokers SET source_display_names = $1, updated_at = now() WHERE id = $2`,
          [JSON.stringify(Array.from(priorNames)), brokerId]
        );
        matched += 1;
      } else {
        const { rows: inserted } = await pool.query(
          `INSERT INTO matching_dubai.brokers (name, phone, normalized_phone, source_display_names)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [displayName, group.normalizedPhone, group.normalizedPhone, JSON.stringify(Array.from(group.names))]
        );
        brokerId = inserted[0].id;
        created += 1;
      }

      const { rowCount } = await pool.query(
        `UPDATE matching_dubai.stock_inventory SET broker_id = $1
         WHERE status = 'ACTIVE' AND stock_id = ANY($2::text[])`,
        [brokerId, group.stockIds]
      );
      stockRowsBackfilled += rowCount;
    }

    if (dryRun) {
      console.log('\n[broker-backfill] Dry run only -- nothing was written. Re-run with --write (and BROKER_BACKFILL_ALLOW_WRITE=true) to persist.');
    } else {
      console.log(`\n[broker-backfill] Done. Brokers created: ${created}, matched existing: ${matched}, stock rows backfilled: ${stockRowsBackfilled}.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[broker-backfill] FAILED:', err);
  process.exit(1);
});
