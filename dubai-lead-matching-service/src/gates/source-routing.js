'use strict';

// Source lookup / monitoring gate (AGENTS.md section 0's required shared
// runtime order: "... -> source lookup -> monitoring_enabled? -> source
// route -> DUBAI | RF | SAUDI | ABU_DHABI | AUTO | NONE, any non-empty
// combination of the four real labels"). ingest.* is shared transport/
// source-control data (AGENTS.md's DB ownership table), so this Dubai
// contour service reading it directly is allowed -- it must never write
// Dubai-specific matching data into ingest.* and must never read
// matching_rf.*/matching_saudi.*/matching_abu_dhabi.* (kept entirely
// separate per section 0's hard rules).
//
// Multi-route selection (2026-10-06, migration 0041): `route_mode` (one
// value) became `route_modes` (an array) so one source can be routed to
// any combination of real markets at once, not just the old hardcoded
// BOTH=[DUBAI,RF] pair -- eligibility is now array membership, not scalar
// equality. AUTO/NONE remain mutually-exclusive sentinels (DB CHECK +
// src/sources/source-repository.js's validateRouteModes both enforce a
// row is never AUTO/NONE mixed with a real label).
//
// Three contours are now real (Dubai, RF, Abu Dhabi); SAUDI remains a
// label with no matching service behind it yet (no saudi-lead-matching-
// service). AUTO has no real deterministic market classifier built yet --
// until one exists, AUTO is treated the same as DUBAI here: an explicit,
// disclosed interim default (never a silent guess) so a source an
// operator marks AUTO isn't unexpectedly dropped just because the real
// classifier doesn't exist yet. A routeModes set that doesn't include
// DUBAI (and isn't AUTO) is a real, deliberate rejection: this service
// must never process a source not routed to it (section 0: "A Dubai
// matcher MUST NEVER query RF stock/tables", extended the same way to
// every other contour).
function isDubaiEligible(routeModes) {
  return Array.isArray(routeModes) && (routeModes.includes('DUBAI') || routeModes.includes('AUTO'));
}

// No ingest.sources row at all (never synced, or synced under a
// different account_id than this message carries) fails CLOSED, not
// open: AGENTS.md section 0 is explicit that env allowlists are
// bootstrap/fallback only, and nothing should default to "process it
// anyway" just because the catalog doesn't know about this source yet.
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
  if (!isDubaiEligible(routeModes)) {
    // Collapses the old per-other-contour reasons
    // (source_routed_to_rf_contour / _saudi_contour / _abu_dhabi_contour)
    // into one generic reason, matching RF's/Abu Dhabi's own gates'
    // naming -- with arrays, "routed to the others" can now mean more
    // than one market at once, so naming just one of them would be
    // misleading. src/db/route-reject-cleanup.js's own allow-list was
    // updated in the same change.
    return { found: true, eligible: false, monitoringEnabled, routeModes, reason: 'not_dubai_eligible' };
  }
  return { found: true, eligible: true, monitoringEnabled, routeModes, reason: null };
}

module.exports = { lookupSourceRoute, isDubaiEligible };
