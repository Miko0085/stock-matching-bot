#!/usr/bin/env node
'use strict';

// Read-only: lists active brokers linked to Joker CRM (source = 'JOKER') as
// `id|name` lines, the input for tools/telegram_create_broker_bots.py.
//   node scripts/export-joker-brokers.js [output-file]
// Default output: telegram-worker/state/joker_brokers.txt (gitignored).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createPool } = require('../src/db/pool');

const DEFAULT_OUTPUT = path.join(__dirname, '..', 'telegram-worker', 'state', 'joker_brokers.txt');

async function listJokerBrokers(pool) {
  const { rows } = await pool.query(`
    SELECT DISTINCT b.id, b.name
    FROM matching_dubai.brokers b
    JOIN matching_dubai.broker_external_identities ei ON ei.broker_id = b.id AND ei.source = 'JOKER'
    WHERE b.is_active
    ORDER BY b.id
  `);
  return rows;
}

function formatLines(rows) {
  return rows.map((r) => `${r.id}|${String(r.name).replace(/[\r\n|]+/g, ' ').trim()}`);
}

async function main() {
  const output = process.argv[2] || DEFAULT_OUTPUT;
  const pool = createPool();
  try {
    const rows = await listJokerBrokers(pool);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, formatLines(rows).join('\n') + '\n');
    console.log(`Exported ${rows.length} Joker brokers to ${output}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { listJokerBrokers, formatLines };
