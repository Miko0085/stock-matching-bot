#!/usr/bin/env node
'use strict';

// TZ 97: replay a raw provider fixture through the exact same pipeline a
// real webhook would use -- adapter -> gate -> AI (live by default, or
// --mock for an offline dry run) -> matcher -> persistence -- and print a
// human-readable summary. Useful for debugging a real incident by hand
// (paste the exact raw payload into a fixture file) without going through
// n8n or a live worker at all.
//
// Usage:
//   node scripts/replay-message.js tests/fixtures/telegram-business-bay.json
//   node scripts/replay-message.js tests/fixtures/telegram-emaar-ad.json --mock
//   node scripts/replay-message.js path/to/fixture.json --provider=whatsapp

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/repositories/pool');
const { loadAliasIndex } = require('../src/repositories/alias-repository');
const { makeStockRepository } = require('../src/repositories/stock-repository');
const matchRepo = require('../src/repositories/match-repository');
const aiUsageRepo = require('../src/repositories/ai-usage-repository');
const { classifyAndParse } = require('../src/parser/openai-client');
const { createAliasCache } = require('../src/services/alias-cache');
const { runWebhookPipeline } = require('../src/services/pipeline');

function mockClassifyAndParse() {
  return async () => ({
    ok: true,
    warnings: [],
    usage: null,
    value: {
      message_class: 'unknown', demand_owner: 'unknown', promotion: false, spam: false,
      transaction_type: null, area: null, project: null, building: null, property_type: null,
      bedrooms_min: null, bedrooms_max: null, budget_min: null, budget_max: null, furnishing: null, cash_buyer: null, confidence: null,
    },
  });
}

function parseArgs(argv) {
  const fixturePath = argv.find((a) => !a.startsWith('--'));
  const providerArg = argv.find((a) => a.startsWith('--provider='));
  const mock = argv.includes('--mock');
  if (!fixturePath) {
    console.error('Usage: node scripts/replay-message.js <fixture.json> [--provider=telegram|whatsapp] [--mock]');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(path.resolve(fixturePath), 'utf8'));
  const provider = providerArg ? providerArg.split('=')[1] : raw.provider;
  if (!provider || !['telegram', 'whatsapp'].includes(provider)) {
    console.error('Could not determine provider -- pass --provider=telegram|whatsapp or include "provider" in the fixture.');
    process.exit(1);
  }
  return { rawPayload: raw, provider, mock };
}

async function main() {
  const { rawPayload, provider, mock } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const pool = createPool({ DATABASE_URL: config.databaseUrl });
  const aliasCache = createAliasCache({ loader: () => loadAliasIndex(pool) });

  const deps = {
    config,
    pool,
    stockRepo: makeStockRepository(pool),
    matchRepo,
    aiUsageRepo,
    classifyAndParse: mock ? mockClassifyAndParse() : classifyAndParse,
    getAliasIndex: () => aliasCache.get(),
    logEvent: (fields) => console.log('[log]', JSON.stringify(fields)),
  };

  console.log(`\n=== Replaying ${provider} fixture ${mock ? '(mock AI)' : '(LIVE OpenAI)'} ===\n`);
  console.log('Raw payload:', JSON.stringify(rawPayload, null, 2));

  const result = await runWebhookPipeline({ rawPayload, provider, deps });

  console.log('\n--- RESULT ---');
  console.log('status:            ', result.status);
  console.log('no_match_reason:   ', result.no_match_reason);
  console.log('request_id:        ', result.request_id);
  console.log('match_run_id:      ', result.match_run_id);
  if (result.structured_request) {
    console.log('\nStructuredRequest:', JSON.stringify(result.structured_request, null, 2));
  }
  console.log(`\nMatches (${result.matches.length}):`);
  for (const m of result.matches) {
    console.log(`  #${m.rank} ${m.stock_id} — score ${m.score} — ${m.building || m.project_community || m.area} — ${m.bedrooms}BR — AED ${m.selling_price}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('replay-message failed:', err);
  process.exit(1);
});
