'use strict';

// Moscow's source-routing gate -- BY ANALOGY with dubai-lead-matching-
// service/src/gates/source-routing.js's lookupSourceRoute() query shape
// (ingest.sources JOIN ingest.source_routes, shared transport/source-
// control data per AGENTS.md section 0's DB ownership table -- reading it
// here is allowed, writing Dubai/RF-specific matching data into it is not).
// New code, not a wrapper: eligibility differs (RF here, vs DUBAI/AUTO
// there) and this file must never require() dubai-lead-matching-service
// (tests/unit/pipeline.test.js's isolation check covers pipeline.js
// only today, but this gate is the routing decision itself and should
// stay independently correct regardless).
//
// Multi-route selection (2026-10-06, migration 0041): `route_mode` (one
// value) became `route_modes` (an array) -- a source can now be routed to
// any combination of real markets at once (e.g. [RF, ABU_DHABI]), so
// eligibility is array membership, not the old `=== 'BOTH'` special case
// (BOTH is retired as a stored value; being in the array IS the "also
// routed elsewhere" signal now).
//
// AUTO is deliberately NOT eligible here: the existing precedent (see the
// Dubai file's own comment) is that AUTO defaults to the Dubai contour
// until a real deterministic market classifier exists -- this must not
// silently start giving RF a share of AUTO-routed traffic as a side
// effect of finally building a real RF gate.
function isRfEligible(routeModes) {
  return Array.isArray(routeModes) && routeModes.includes('RF');
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
  if (!isRfEligible(routeModes)) {
    // Dubai-only, SAUDI/ABU_DHABI-only, or AUTO -- not this contour's traffic.
    return { found: true, eligible: false, monitoringEnabled, routeModes, reason: 'not_rf_eligible' };
  }
  return { found: true, eligible: true, monitoringEnabled, routeModes, reason: null };
}

module.exports = { lookupSourceRoute, isRfEligible };
