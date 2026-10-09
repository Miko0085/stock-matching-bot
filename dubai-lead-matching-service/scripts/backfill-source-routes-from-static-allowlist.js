'use strict';

// One-time backfill: before ingest.source_routes becomes the authoritative
// live monitoring gate (see src/gates/source-routing.js), every chat_id
// that was actually flowing through the legacy static env allowlists
// (telegram-worker's TELEGRAM_MONITOR_CHAT_IDS, whatsapp-worker's
// WA_MONITOR_GROUP_IDS) must be marked monitoring_enabled=true,
// route_mode='DUBAI' first -- otherwise the moment the new gate goes live,
// every one of these currently-flowing groups goes silent with zero
// warning (ingest.source_routes defaults every synced source to
// monitoring_enabled=false, route_mode='NONE').
//
// DUBAI is the only live contour (rf-lead-matching-service is a skeleton),
// so that's the correct route for "this is already real production
// traffic today" -- not a guess.
//
// Safe to re-run: only ever sets monitoring_enabled=true/route_mode='DUBAI'
// for a row currently at the untouched default (monitoring_enabled=false
// AND route_mode='NONE' AND manual_override=false) -- never overwrites an
// operator's own later decision (mirrors the same "never overwrite a
// manual override" rule upsertSource() already follows on every re-sync).
//
// Usage:
//   node scripts/backfill-source-routes-from-static-allowlist.js           (dry run, prints what it would change)
//   node scripts/backfill-source-routes-from-static-allowlist.js --apply   (actually writes)

require('dotenv').config(); // lead-matching-service/.env -- DATABASE_URL lives here

// TELEGRAM_MONITOR_CHAT_IDS / WA_MONITOR_GROUP_IDS are each worker's OWN env
// vars, not this service's -- read them straight from those files rather
// than assuming they're duplicated into this service's .env.
const path = require('path');
const dotenv = require('dotenv');
const workerEnv = {
  telegram: dotenv.parse(require('fs').readFileSync(path.join(__dirname, '../../telegram-worker/.env'))),
  whatsapp: dotenv.parse(require('fs').readFileSync(path.join(__dirname, '../../whatsapp-worker/.env'))),
};

const { Pool } = require('pg');

const TELEGRAM_IDS = (workerEnv.telegram.TELEGRAM_MONITOR_CHAT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const WHATSAPP_IDS = (workerEnv.whatsapp.WA_MONITOR_GROUP_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  for (const [provider, ids] of [['telegram', TELEGRAM_IDS], ['whatsapp', WHATSAPP_IDS]]) {
    if (!ids.length) {
      console.log(`[${provider}] no static allowlist configured, nothing to backfill.`);
      continue;
    }

    const { rows: matched } = await pool.query(
      `SELECT s.id, s.account_id, s.external_source_id, s.name, sr.monitoring_enabled, sr.route_mode, sr.manual_override
       FROM ingest.sources s
       JOIN ingest.source_routes sr ON sr.source_id = s.id
       WHERE s.provider = $1 AND s.external_source_id = ANY($2)
       ORDER BY s.external_source_id, s.account_id`,
      [provider, ids]
    );

    const foundIds = new Set(matched.map((r) => r.external_source_id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length) {
      console.log(`[${provider}] WARNING: ${missing.length} static id(s) have no ingest.sources row at all (never synced, or synced under a different account) -- NOT backfilled, run "Sync Sources" first if these should still be monitored:`);
      for (const id of missing) console.log(`  - ${id}`);
    }

    const untouched = matched.filter((r) => !r.manual_override && !r.monitoring_enabled && r.route_mode === 'NONE');
    const alreadyDecided = matched.filter((r) => r.manual_override || r.monitoring_enabled || r.route_mode !== 'NONE');

    console.log(`[${provider}] ${matched.length} matched, ${untouched.length} to backfill, ${alreadyDecided.length} already have an operator decision (left untouched):`);
    for (const r of alreadyDecided) {
      console.log(`  - SKIP (already decided) [${r.account_id}] ${r.external_source_id} "${r.name}" -- monitoring_enabled=${r.monitoring_enabled}, route_mode=${r.route_mode}, manual_override=${r.manual_override}`);
    }
    for (const r of untouched) {
      console.log(`  - ${apply ? 'BACKFILL' : 'WOULD BACKFILL'} [${r.account_id}] ${r.external_source_id} "${r.name}" -> monitoring_enabled=true, route_mode=DUBAI`);
    }

    if (apply && untouched.length) {
      const sourceIds = untouched.map((r) => r.id);
      await pool.query(
        `UPDATE ingest.source_routes
         SET monitoring_enabled = true, route_mode = 'DUBAI', updated_by = 'backfill-static-allowlist-2026-09-27',
             notes = COALESCE(notes, '') || 'Backfilled from legacy TELEGRAM_MONITOR_CHAT_IDS/WA_MONITOR_GROUP_IDS before making ingest.source_routes the live monitoring gate.'
         WHERE source_id = ANY($1) AND monitoring_enabled = false AND route_mode = 'NONE' AND manual_override = false`,
        [sourceIds]
      );
      console.log(`[${provider}] applied.`);
    }
  }

  await pool.end();
  if (!apply) {
    console.log('\nDry run only -- re-run with --apply to write these changes.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
