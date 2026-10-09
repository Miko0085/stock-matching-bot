#!/usr/bin/env node
'use strict';

// TZ 98-99: shadow comparison -- run the SAME raw message text through the
// OLD n8n-era matcher (src/core/*.js, its own AI prompt) and the NEW
// standalone service (this service's gate/AI/matcher), against the same
// real stock/alias data, and report where they disagree. Read-only: never
// writes to match_runs/match_results, never sends a Telegram message,
// never switches production. Only ever calls each AI prompt/matcher, both
// as pure computation over the SAME fixtures.
//
// Usage:
//   node scripts/shadow-compare.js --fixtures=tests/fixtures/telegram-business-bay.json,tests/fixtures/telegram-emaar-ad.json
//   node scripts/shadow-compare.js --historical=20   (pulls the 20 most recent real match_runs rows)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/repositories/pool');
const { loadAliasIndex } = require('../src/repositories/alias-repository');
const { matchRequest: newMatchRequest } = require('../src/matching/matcher');
const { classifyAndParse: newClassifyAndParse } = require('../src/parser/openai-client');
const { buildStructuredRequest } = require('../src/normalization/structured-request');

const { validateParsedRequest } = require('../../src/core/request-schema');
const { matchRequest: oldMatchRequest } = require('../../src/core/matcher');
const { DEFAULT_CONFIG: OLD_CONFIG } = require('../../src/core/config');

const OLD_SYSTEM_PROMPT =
  'Classify this Dubai residential real estate social media post, then extract structured buyer/renter criteria only if applicable. Return JSON with exactly these fields. Four independent boolean labels: buying_intent (the author is SEEKING to buy or rent residential property, for themselves or naming a client — a genuine buyer/renter/broker-with-a-client request), seeking_info (the author is asking a general question, seeking advice, or making a complaint — not stating their own requirement), promotion (the author is advertising their OWN property listing, business, service, or job opening — offering, not seeking), spam (no genuine real-estate value: scams, unrelated content, phishing, and similar). A commercial or business-for-sale post (shop, restaurant, office-as-a-business) is promotion or spam, never buying_intent. Extraction fields, all null unless buying_intent is true: transaction_type (SALE|RENT), area, building, bedrooms, property_type, budget_min, budget_max, furnishing (Furnished|Unfurnished|Semi-Furnished), cash_buyer, confidence (0-1). property_type must be a residential type (Apartment, Villa, Townhouse, Penthouse, Studio, or similar) or null — never a business/commercial category. Use null for anything not stated. Never invent values.';

function callOpenAiRaw({ systemPrompt, userText, apiKey, model }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
    });
    const req = https.request(
      'https://api.openai.com/v1/chat/completions',
      { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runOld({ originalText, config, aliasIndex, activeStock }) {
  const raw = await callOpenAiRaw({ systemPrompt: OLD_SYSTEM_PROMPT, userText: originalText, apiKey: config.openaiApiKey, model: config.openaiModel });
  let rawParsed = {};
  try {
    const httpResponse = JSON.parse(raw);
    const content = httpResponse.choices?.[0]?.message?.content;
    rawParsed = typeof content === 'string' ? JSON.parse(content) : content || {};
  } catch {
    return { classification: null, outcome: null, error: 'old_parser_error' };
  }
  const { value, warnings } = validateParsedRequest(rawParsed);
  const outcome = oldMatchRequest({
    parsedRequest: value,
    parserWarnings: warnings,
    aliasIndex,
    stockCandidates: activeStock,
    config: OLD_CONFIG,
    stockSyncedAt: new Date().toISOString(),
  });
  return {
    classification: { buying_intent: value.buying_intent, promotion: value.promotion, spam: value.spam },
    status: outcome.resultStatus,
    reason: outcome.noMatchReason,
    matchesCount: outcome.matchesCount,
    matchedStockIds: outcome.successfulMatches.map((m) => m.stock.stock_id),
    bestScore: outcome.bestScore,
  };
}

async function runNew({ originalText, config, aliasIndex, fetchCandidates, checkLocationExists }) {
  const aiResult = await newClassifyAndParse({ originalText, apiKey: config.openaiApiKey, model: config.openaiModel });
  if (!aiResult.ok) return { classification: null, outcome: null, error: aiResult.reason };

  const eligible = aiResult.value.message_class === 'buyer_request' && aiResult.value.demand_owner === 'sender' && !aiResult.value.promotion && !aiResult.value.spam;
  if (!eligible) {
    return {
      classification: { message_class: aiResult.value.message_class, demand_owner: aiResult.value.demand_owner, promotion: aiResult.value.promotion },
      status: 'REJECTED',
      reason: null,
      matchesCount: 0,
      matchedStockIds: [],
      bestScore: null,
    };
  }

  const unifiedMessage = { source_message_id: 'shadow', provider: 'telegram', source_url: null, group_name: null, author_name: null, author_contact: null, original_text: originalText, sender_id: null };
  const { structuredRequest, resolution } = buildStructuredRequest({ unifiedMessage, aiValue: aiResult.value, aliasIndex });
  const outcome = await newMatchRequest({ structuredRequest, resolution, config, fetchCandidates, checkLocationExists });
  return {
    classification: { message_class: aiResult.value.message_class, demand_owner: aiResult.value.demand_owner, promotion: aiResult.value.promotion },
    status: outcome.status,
    reason: outcome.noMatchReason,
    matchesCount: outcome.matches.length,
    matchedStockIds: outcome.matches.map((m) => m.stock.stock_id),
    bestScore: outcome.matches[0]?.score.total ?? null,
  };
}

async function loadTexts({ fixturesArg, historicalArg, pool }) {
  if (fixturesArg) {
    return fixturesArg.split(',').map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));
      return { label: path.basename(f), text: raw.text };
    });
  }
  if (historicalArg) {
    const { rows } = await pool.query(
      `SELECT source_message_id, original_text FROM matching_dubai.match_runs WHERE original_text IS NOT NULL ORDER BY created_at DESC LIMIT $1`,
      [Number(historicalArg)]
    );
    if (rows.length === 0) {
      console.log('No historical rows with original_text found (only the new service populates that column) -- falling back to bundled fixtures.');
    }
    return rows.map((r) => ({ label: r.source_message_id, text: r.original_text }));
  }
  return fs
    .readdirSync(path.join(__dirname, '..', 'tests', 'fixtures'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', f), 'utf8'));
      return { label: f, text: raw.text };
    });
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    })
  );

  const config = loadConfig();
  const pool = createPool({ DATABASE_URL: config.databaseUrl });
  const aliasIndex = await loadAliasIndex(pool);
  const { rows: activeStock } = await pool.query(`SELECT * FROM matching_dubai.stock_inventory WHERE status = 'ACTIVE' AND transaction_type = ANY($1)`, [['SALE']]);

  const fetchCandidates = async (sql, params) => (await pool.query(sql, params)).rows;
  const checkLocationExists = async (sql, params) => (await pool.query(sql, params)).rows.length > 0;

  const items = await loadTexts({ fixturesArg: args.fixtures, historicalArg: args.historical, pool });

  console.log(`\nShadow comparison: OLD matcher vs NEW service, ${items.length} message(s), against ${activeStock.length} active SALE stock rows.\n`);

  const summary = { agree: 0, disagree: 0 };
  for (const item of items) {
    const [oldResult, newResult] = await Promise.all([
      runOld({ originalText: item.text, config, aliasIndex, activeStock }),
      runNew({ originalText: item.text, config, aliasIndex, fetchCandidates, checkLocationExists }),
    ]);

    const oldMatchedSet = new Set(oldResult.matchedStockIds || []);
    const newMatchedSet = new Set(newResult.matchedStockIds || []);
    const removedFalsePositives = [...oldMatchedSet].filter((id) => !newMatchedSet.has(id));
    const newOnlyMatches = [...newMatchedSet].filter((id) => !oldMatchedSet.has(id));
    const agrees = oldResult.status === newResult.status && removedFalsePositives.length === 0 && newOnlyMatches.length === 0;
    summary[agrees ? 'agree' : 'disagree'] += 1;

    console.log(`--- ${item.label} ---`);
    console.log(`text: ${item.text.slice(0, 100).replace(/\n/g, ' ')}${item.text.length > 100 ? '…' : ''}`);
    console.log(`OLD: classification=${JSON.stringify(oldResult.classification)} status=${oldResult.status} reason=${oldResult.reason} matches=${oldResult.matchesCount} bestScore=${oldResult.bestScore}`);
    console.log(`NEW: classification=${JSON.stringify(newResult.classification)} status=${newResult.status} reason=${newResult.reason} matches=${newResult.matchesCount} bestScore=${newResult.bestScore}`);
    if (removedFalsePositives.length) console.log(`  removed false positives (matched OLD, not NEW): ${removedFalsePositives.join(', ')}`);
    if (newOnlyMatches.length) console.log(`  new-only matches (matched NEW, not OLD): ${newOnlyMatches.join(', ')}`);
    if (oldResult.status !== newResult.status) console.log(`  status changed: ${oldResult.status} -> ${newResult.status}`);
    console.log(agrees ? '  [AGREE]' : '  [DIFFERENT]');
    console.log('');
  }

  console.log(`Summary: ${summary.agree} agree, ${summary.disagree} different (of ${items.length}).`);
  await pool.end();
}

main().catch((err) => {
  console.error('shadow-compare failed:', err);
  process.exit(1);
});
