'use strict';

// Abu Dhabi's source-routing gate -- BY ANALOGY with dubai-lead-matching-
// service/src/gates/source-routing.js's lookupSourceRoute() query shape
// (ingest.sources JOIN ingest.source_routes, shared transport/source-
// control data per AGENTS.md section 0's DB ownership table -- reading it
// here is allowed, writing Abu-Dhabi-specific matching data into it is
// not). New code, not a wrapper: eligibility differs (ABU_DHABI only
// today, no AUTO) and this file must never require()
// dubai-lead-matching-service (tests/unit/pipeline.test.js's isolation
// check covers pipeline.js only, but this gate is the routing decision
// itself and should stay independently correct regardless).
//
// Multi-route selection (2026-10-06, migration 0041): `route_mode` (one
// value) became `route_modes` (an array) -- a source can now be routed to
// any combination of real markets at once (e.g. [DUBAI, ABU_DHABI]), so
// eligibility is array membership, not scalar equality.
//
// Deliberately NOT eligible for AUTO (2026-10-06, bootstrap stage, same as
// SAUDI/RF were before their own contours matured): AUTO defaults to
// Dubai (the existing precedent) until a real deterministic market
// classifier exists -- giving AUTO a share of Abu Dhabi traffic as a side
// effect of this gate's existence would be the same silent-guess mistake
// AGENTS.md section 0 already warns against.
// Zero existing sources are pre-assigned ABU_DHABI (confirmed live before
// migration 0037) -- an operator assigns sources manually in /sources.
function isAbuDhabiEligible(routeModes) {
  return Array.isArray(routeModes) && routeModes.includes('ABU_DHABI');
}

async function lookupSourceRoute(pool, { provider, accountId, chatId }) {
  const { rows } = await pool.query(
    `SELECT sr.monitoring_enabled, sr.route_modes
     FROM ingest.sources s
     JOIN ingest.source_routes sr ON sr.source_id = s.id
     WHERE s.provider = $1 AND s.account_id = $2 AND s.external_source_id = $3`,
    [provider, accountId || '', chatId || '']
  );

  if (!rows.length) {
    return { found: false, eligible: false, monitoringEnabled: false, routeModes: ['NONE'], reason: 'source_not_catalogued' };
  }

  const { monitoring_enabled: monitoringEnabled, route_modes: routeModes } = rows[0];
  if (!monitoringEnabled) {
    return { found: true, eligible: false, monitoringEnabled, routeModes, reason: 'source_monitoring_disabled' };
  }
  if (routeModes.includes('NONE')) {
    return { found: true, eligible: false, monitoringEnabled, routeModes, reason: 'source_route_none' };
  }
  if (!isAbuDhabiEligible(routeModes)) {
    // Dubai/RF/SAUDI-labeled, or AUTO -- not this contour's traffic.
    return { found: true, eligible: false, monitoringEnabled, routeModes, reason: 'not_abu_dhabi_eligible' };
  }
  return { found: true, eligible: true, monitoringEnabled, routeModes, reason: null };
}

module.exports = { lookupSourceRoute, isAbuDhabiEligible };
