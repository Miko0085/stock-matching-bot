#!/usr/bin/env node
'use strict';

// Matching-correctness spec sections 42-45: a STRICTLY READ-ONLY diagnostic
// CLI for one historical request. It never:
//   - calls OpenAI (no classification/parsing re-run -- it reads the
//     ALREADY-PERSISTED structured request from matching_dubai.match_runs)
//   - inserts/updates matching_dubai.match_runs or matching_dubai.match_results
//   - sends a Telegram message
//   - writes matching_aliases or matching_dubai.stock_inventory
//   - claims an ingest event
//   - writes any other production state
// Every DB call it makes is a plain SELECT (matchRequest()'s injected
// fetchCandidates/checkLocationExists, and stockRepo.getActiveStockCount --
// the exact same read-only functions the live service already uses, never
// a parallel implementation).
//
// Because it re-runs matchRequest() against CURRENT live stock rather than
// replaying the original message, its outcome can legitimately differ from
// what was persisted at write-time if stock has changed since -- this is
// intentional and clearly labeled, never hidden.
//
// Usage:
//   node scripts/diagnose-request.js --source-message-id=telegram:123:456
//   node scripts/diagnose-request.js --match-run-id=4821

require('dotenv').config();
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/repositories/pool');
const { loadAliasIndex } = require('../src/repositories/alias-repository');
const { loadCanonicalRegistry } = require('../src/repositories/canonical-registry-repository');
const { makeStockRepository } = require('../src/repositories/stock-repository');
const { buildLocationDictionary } = require('../src/matching/location-dictionary');
const { matchRequest } = require('../src/matching/matcher');
const { buildMatchDiagnostics } = require('../src/matching/diagnostics');

function parseArgs(argv) {
  const sourceArg = argv.find((a) => a.startsWith('--source-message-id='));
  const runArg = argv.find((a) => a.startsWith('--match-run-id='));
  if (!sourceArg && !runArg) {
    console.error('Usage: node scripts/diagnose-request.js --source-message-id=<id> | --match-run-id=<id>');
    process.exit(1);
  }
  return {
    sourceMessageId: sourceArg ? sourceArg.split('=').slice(1).join('=') : null,
    matchRunId: runArg ? Number(runArg.split('=')[1]) : null,
  };
}

// Read-only lookup. For --source-message-id, mirrors the Dashboard's
// canonical-outcome convention (dashboard/summary-queries.js): prefer the
// latest non-DUPLICATE row, fall back to the latest row if every row for
// that message is DUPLICATE -- so the CLI diagnoses the same "canonical"
// outcome an operator would see on the Dashboard, not an arbitrary retry.
async function fetchMatchRun(pool, { sourceMessageId, matchRunId }) {
  if (matchRunId !== null) {
    const { rows } = await pool.query('SELECT * FROM matching_dubai.match_runs WHERE id = $1', [matchRunId]);
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM matching_dubai.match_runs
     WHERE source_message_id = $1
     ORDER BY (result_status <> 'DUPLICATE') DESC, created_at DESC
     LIMIT 1`,
    [sourceMessageId]
  );
  return rows[0] || null;
}

function printSection(title) {
  console.log(`\n${title}`);
  console.log('='.repeat(title.length));
}

function fmtList(values) {
  return values && values.length ? values.join(', ') : '(none)';
}

async function main() {
  const { sourceMessageId, matchRunId } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const pool = createPool({ DATABASE_URL: config.databaseUrl });

  try {
    const run = await fetchMatchRun(pool, { sourceMessageId, matchRunId });
    if (!run) {
      console.error(`No matching_dubai.match_runs row found for ${matchRunId !== null ? `match_run_id=${matchRunId}` : `source_message_id=${sourceMessageId}`}.`);
      process.exitCode = 1;
      return;
    }

    printSection(`MATCHING DIAGNOSTIC — request ${run.source_message_id} (match_run_id=${run.id})`);
    console.log(`Matcher version:     ${run.matcher_version}`);
    console.log(`Result status:       ${run.result_status}`);
    console.log(`No-match reason:     ${run.no_match_reason || '(none)'}`);
    console.log(`Created at:          ${run.created_at}`);

    if (run.matcher_version !== config.matcherVersion) {
      console.log(`\nThis is a ${run.matcher_version} row -- the current-matcher hard-filter funnel and StructuredRequest`);
      console.log('schema this CLI understands do not apply to it. No further diagnosis is possible here.');
      return;
    }

    if (!run.normalized_request) {
      console.log('\nThis row has no persisted StructuredRequest (normalized_request is NULL) -- it never reached');
      console.log('the matcher (REJECTED / DUPLICATE / PARSER_ERROR / event-level duplicate). Nothing to diagnose.');
      return;
    }

    const structuredRequest = run.normalized_request;

    printSection('REQUEST');
    console.log(`Original text:       ${run.original_text || '(none)'}`);
    console.log(`Transaction:         ${structuredRequest.transaction_type || '(none)'}`);
    console.log(`Project:             ${structuredRequest.project || '(none)'}`);
    console.log(`Building:            ${structuredRequest.building || '(none)'}`);
    console.log(`Property type:       ${structuredRequest.property_type || '(none)'}`);
    console.log(`Bedrooms:            ${structuredRequest.bedrooms_min ?? '-'} to ${structuredRequest.bedrooms_max ?? '-'}`);
    console.log(`Budget:              ${structuredRequest.budget_min ?? '-'} to ${structuredRequest.budget_max ?? '-'}`);
    console.log(`Furnishing:          ${structuredRequest.furnishing || '(none)'}`);

    // Read-only re-resolution against CURRENT live aliases/stock (spec
    // sections 5-9) -- never re-classifies the message, only re-derives
    // location resolution status for the ALREADY-PERSISTED area/project/
    // building strings. A historical row predating the multi-area schema
    // has no `.areas` array -- falls back to the single `.area` field.
    const [aliasIndex, canonicalRegistry, activeStockCount] = await Promise.all([
      loadAliasIndex(pool),
      loadCanonicalRegistry(pool),
      makeStockRepository(pool).getActiveStockCount(),
    ]);
    const dictionary = buildLocationDictionary({ aliasIndex, canonicalRegistry });

    const rawAreas = Array.isArray(structuredRequest.areas) && structuredRequest.areas.length > 0
      ? structuredRequest.areas
      : (structuredRequest.area ? [structuredRequest.area] : []);
    const areaOptions = rawAreas.map((raw) => dictionary.resolve('area', raw));
    const project = dictionary.resolve('project', structuredRequest.project);
    const building = dictionary.resolve('building', structuredRequest.building);

    const resolution = {
      areaOptions,
      projectProvided: Boolean(structuredRequest.project),
      projectResolved: project.resolved,
      buildingProvided: Boolean(structuredRequest.building),
      buildingResolved: building.resolved,
      propertyTypeResolved: true, // property_type has no alias-resolution concept relevant to location diagnostics
    };

    printSection('LOCATION DICTIONARY (re-resolved against CURRENT live data)');
    if (areaOptions.length === 0) {
      console.log('No area named on this request.');
    } else {
      for (const option of areaOptions) {
        console.log(`  ${option.resolved ? '✓' : '✗'} "${option.raw}" -> ${option.resolved ? `${option.canonical} (via ${option.resolution_source})` : 'NOT RECOGNIZED'}`);
      }
    }
    if (structuredRequest.project) console.log(`  Project "${structuredRequest.project}": ${project.resolved ? `resolved via ${project.resolution_source}` : 'NOT RECOGNIZED'}`);
    if (structuredRequest.building) console.log(`  Building "${structuredRequest.building}": ${building.resolved ? `resolved via ${building.resolution_source}` : 'NOT RECOGNIZED'}`);

    const stockRepo = makeStockRepository(pool);
    const outcome = await matchRequest({
      structuredRequest: { ...structuredRequest, building: building.value, project: project.value },
      resolution,
      config,
      fetchCandidates: stockRepo.fetchCandidates,
      checkLocationExists: stockRepo.checkLocationExists,
      originalText: null,
    });

    console.log(`\nRe-run against CURRENT stock: ${outcome.status}${outcome.noMatchReason ? ` (${outcome.noMatchReason})` : ''}`);
    if (outcome.status !== run.result_status) {
      console.log(`NOTE: this differs from the PERSISTED outcome (${run.result_status}) -- stock has likely changed since this request was originally processed.`);
    }

    const diagnostics = await buildMatchDiagnostics({
      structuredRequest,
      matchOutcome: outcome,
      activeStockCount,
      config,
      runFunnelQuery: stockRepo.fetchCandidates,
    });

    printSection('DATA SUFFICIENCY');
    console.log(`Provided fields:              ${fmtList(diagnostics.request.provided_fields)}`);
    console.log(`Missing for auto-matching:    ${fmtList(diagnostics.request.missing_required_fields)}`);

    printSection('STOCK FUNNEL');
    console.log(`ACTIVE (citywide):   ${diagnostics.stock.active}`);
    console.log(`after_location:      ${diagnostics.stock.after_location}`);
    console.log(`after_transaction:   ${diagnostics.stock.after_transaction}`);
    console.log(`after_property_type: ${diagnostics.stock.after_property_type}`);
    console.log(`after_bedrooms:      ${diagnostics.stock.after_bedrooms}`);
    console.log(`after_budget:        ${diagnostics.stock.after_budget}`);
    console.log(`after_bathrooms:     ${diagnostics.stock.after_bathrooms}`);
    console.log(`after_size:          ${diagnostics.stock.after_size}`);
    console.log(`after_plot_size:     ${diagnostics.stock.after_plot_size}`);
    console.log(`after_furnishing:    ${diagnostics.stock.after_furnishing}`);

    printSection('DATA GAPS (missing stock data vs. explicit mismatch)');
    const gapFields = Object.keys(diagnostics.missing_stock_data);
    if (gapFields.length === 0) {
      console.log('(no stated criterion had a missing-vs-mismatch ambiguity)');
    } else {
      for (const field of gapFields) {
        const d = diagnostics.missing_stock_data[field];
        console.log(`  ${field}: ${d.candidate_rows_before} candidate(s) before this stage -- ${d.missing_value_rows} missing data, ${d.explicit_mismatch_rows} explicit mismatch`);
      }
    }

    printSection('FIRST ZERO STAGE');
    console.log(diagnostics.first_zero_stage || '(never reached zero -- candidates survived every stated stage)');

    printSection('FIRST DATA GAP STAGE');
    console.log(diagnostics.first_data_gap_stage || '(none -- no stage was zeroed out primarily by missing stock data)');

    printSection('FINAL DIAGNOSIS');
    if (outcome.status === 'MATCH') {
      console.log(`MATCH — ${outcome.matches.length} candidate(s) survived every hard filter.`);
    } else if (diagnostics.first_data_gap_stage) {
      const gap = diagnostics.missing_stock_data[diagnostics.first_data_gap_stage];
      console.log(`NO_MATCH -- the funnel was zeroed out at "${diagnostics.first_data_gap_stage}", where ${gap.missing_value_rows} of ${gap.candidate_rows_before}`);
      console.log(`candidate(s) had no recorded value at all (vs. ${gap.explicit_mismatch_rows} with a confirmed, explicit mismatch).`);
      console.log('At least part of this NO_MATCH is a data completeness gap, not purely a matching-logic result -- see DATA GAPS above.');
    } else if (diagnostics.location.unresolved.length > 0) {
      console.log(`Location(s) not recognized: ${fmtList(diagnostics.location.unresolved)} -- an ALIAS_GAP, not a proven stock gap.`);
    } else {
      console.log(`${outcome.status}${outcome.noMatchReason ? ` (${outcome.noMatchReason})` : ''} -- a genuine result given current stock and the request as stated.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('diagnose-request failed:', err);
  process.exit(1);
});
