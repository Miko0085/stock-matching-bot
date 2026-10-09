#!/usr/bin/env node
'use strict';

// Cost-optimization plan, item 8 (metrics). Deliberately reads REAL,
// already-persisted matching_dubai.match_runs / matching_dubai.ai_usage_log rows for a
// time window -- it never fabricates or estimates a "would have been"
// number. Before the new triage_decision/interpretation_source columns
// (migration 0015) exist on a row, that row simply can't be attributed to
// a funnel stage and is reported separately as "pre-cost-plan rows",
// rather than silently guessed at.
//
// Usage:
//   node scripts/replay-metrics.js --since=24h
//   node scripts/replay-metrics.js --since=7d

require('dotenv').config();
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/repositories/pool');

function parseSince(arg) {
  const match = /^(\d+)([hd])$/.exec(arg || '24h');
  if (!match) return '24 hours';
  const [, amount, unit] = match;
  return `${amount} ${unit === 'h' ? 'hours' : 'days'}`;
}

async function main() {
  const sinceArg = (process.argv.find((a) => a.startsWith('--since=')) || '--since=24h').split('=')[1];
  const interval = parseSince(sinceArg);
  const config = loadConfig();
  const pool = createPool({ DATABASE_URL: config.databaseUrl });

  const { rows: funnelRows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE true) AS raw_messages,
       count(*) FILTER (WHERE result_status = 'DUPLICATE' AND no_match_reason = 'duplicate_event') AS event_duplicates,
       count(*) FILTER (WHERE result_status = 'DUPLICATE' AND no_match_reason = 'duplicate_content') AS content_duplicates,
       count(*) FILTER (WHERE interpretation_source LIKE 'cache_%') AS interpretation_cache_hits,
       count(*) FILTER (WHERE triage_decision = 'REJECT') AS deterministic_rejected,
       count(*) FILTER (WHERE triage_decision = 'PARSED_LOCALLY') AS parsed_locally,
       count(*) FILTER (WHERE triage_decision = 'AI_REVIEW') AS sent_to_ai,
       count(*) FILTER (WHERE triage_decision = 'AI_REVIEW' AND result_status = 'REJECTED') AS ai_rejected,
       count(*) FILTER (WHERE triage_decision = 'AI_REVIEW' AND result_status IN ('MATCH','NO_MATCH','INSUFFICIENT_CRITERIA')) AS ai_buyer,
       count(*) FILTER (WHERE result_status IN ('MATCH','NO_MATCH')) AS matching_started,
       count(*) FILTER (WHERE result_status = 'MATCH') AS matched,
       count(*) FILTER (WHERE result_status = 'NO_MATCH') AS no_match,
       count(*) FILTER (WHERE triage_decision IS NULL AND result_status NOT IN ('DUPLICATE')) AS pre_cost_plan_rows
     FROM matching_dubai.match_runs
     WHERE created_at > now() - $1::interval`,
    [interval]
  );

  const { rows: usageRows } = await pool.query(
    `SELECT count(*) AS ai_calls, sum(prompt_tokens) AS input_tokens, sum(completion_tokens) AS output_tokens, sum(estimated_cost_usd) AS estimated_cost_usd
     FROM matching_dubai.ai_usage_log
     WHERE created_at > now() - $1::interval`,
    [interval]
  );

  const f = funnelRows[0];
  const u = usageRows[0];
  const rawMessages = Number(f.raw_messages) || 0;
  const sentToAi = Number(f.sent_to_ai) || 0;
  const aiBuyer = Number(f.ai_buyer) || 0;
  const matched = Number(f.matched) || 0;
  const cacheHits = Number(f.interpretation_cache_hits) || 0;
  const triageEligible = sentToAi + cacheHits + Number(f.parsed_locally || 0) + Number(f.deterministic_rejected || 0);

  console.log(`\n=== Cost-optimization funnel (last ${interval}) ===\n`);
  console.log(JSON.stringify({
    raw_messages: rawMessages,
    event_duplicates: Number(f.event_duplicates) || 0,
    content_duplicates: Number(f.content_duplicates) || 0,
    interpretation_cache_hits: cacheHits,
    deterministic_rejected: Number(f.deterministic_rejected) || 0,
    parsed_locally: Number(f.parsed_locally) || 0,
    sent_to_ai: sentToAi,
    ai_rejected: Number(f.ai_rejected) || 0,
    ai_buyer: aiBuyer,
    matching_started: Number(f.matching_started) || 0,
    matched,
    no_match: Number(f.no_match) || 0,
    pre_cost_plan_rows: Number(f.pre_cost_plan_rows) || 0,
    input_tokens: Number(u.input_tokens) || 0,
    output_tokens: Number(u.output_tokens) || 0,
    estimated_cost_usd: u.estimated_cost_usd === null ? null : Number(u.estimated_cost_usd),
  }, null, 2));

  console.log('\n--- Derived rates ---');
  console.log('ai_call_rate (sent_to_ai / raw_messages):        ', rawMessages ? (sentToAi / rawMessages).toFixed(4) : 'n/a (no rows in window)');
  console.log('cache_hit_rate (cache_hits / triage-eligible):   ', triageEligible ? (cacheHits / triageEligible).toFixed(4) : 'n/a');
  console.log('cost_per_accepted_buyer (USD):                   ', matched && u.estimated_cost_usd !== null ? (Number(u.estimated_cost_usd) / matched).toFixed(4) : 'n/a');

  if (Number(f.pre_cost_plan_rows) > 0) {
    console.log(`\nNote: ${f.pre_cost_plan_rows} row(s) in this window predate the triage/cache columns (migration 0015) and are excluded from the funnel breakdown above -- they are only counted in raw_messages.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('replay-metrics failed:', err);
  process.exit(1);
});
