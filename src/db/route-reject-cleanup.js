'use strict';

// Shared housekeeping utility (transport/maintenance-level, NOT matching
// semantics -- allowed to be shared across contours per AGENTS.md section 0,
// same reasoning as src/db/pool.js and config-repository.js's schema-
// parameterized binding) for pruning the pure ROUTE-GATE "noise" rows every
// matcher's match_runs table accumulates from the shared fan-out ingress:
// every raw Telegram/WhatsApp event is forwarded to every contour's webhook,
// and each contour's own source-routing gate rejects (and persists) the
// ~99% that belong to a different market. That persisted row has zero
// debugging value once past initial verification (AGENTS.md section 7 only
// requires NO_MATCH -- a real content-level outcome -- to stay in Postgres
// for debugging; it says nothing about route-gate noise from other
// markets' traffic). Found 2026-10-06: RF alone had accumulated 119k such
// rows in one week.
//
// Deliberately NEVER touches a real content-level outcome (MATCH/
// STRONG_MATCH/NO_MATCH/INSUFFICIENT_CRITERIA/PARSER_ERROR/NOT_IMPLEMENTED,
// or a REJECTED row caused by the BLACKLIST/buyer-signal gate, or a
// DUPLICATE row) -- only rows whose rejection reason is PURELY about which
// contour a source is routed to, which carries no market-specific
// diagnostic information at all once confirmed.
//
// Two shapes exist because the two active matchers store the route-
// rejection reason differently (not a redesign opportunity here, just a
// fact to read around): RF's and Abu Dhabi's own pipelines (BY ANALOGY with
// each other) store it in `reason` as 'ROUTE_REJECT: <reason>'; Dubai's
// older pipeline stores the bare reason directly in `no_match_reason`
// alongside its own, separately-meaningful content-gate reasons -- so
// Dubai's cleanup must match an explicit allow-list of route-gate reasons
// (src/gates/source-routing.js's own exhaustive set), never a blanket
// "every REJECTED row", or it would delete real triage/blacklist history.

// 2026-10-06 (multi-route selection, migration 0041): Dubai's gate used to
// have one reason per OTHER contour (source_routed_to_rf_contour /
// _saudi_contour / _abu_dhabi_contour), each naming exactly which single
// other market a source was routed to. With `route_modes` now an array, a
// source can be routed to more than one other market at once, so naming
// just one would be misleading -- Dubai's gate collapsed all three into
// one generic `not_dubai_eligible`, matching the naming convention RF's/
// Abu Dhabi's own gates already used. Updated here in the same change so
// this allow-list doesn't silently stop recognizing Dubai's route-gate
// noise.
const DUBAI_ROUTE_REJECT_REASONS = [
  'source_not_catalogued',
  'source_monitoring_disabled',
  'source_route_none',
  'not_dubai_eligible',
];

async function getRetentionDays(pool, schema) {
  const { rows } = await pool.query(
    `SELECT value_text FROM ${schema}.runtime_settings WHERE key = 'route_reject_retention_days'`
  );
  if (!rows.length) return null;
  const n = Number(rows[0].value_text);
  return Number.isFinite(n) ? n : null;
}

// RF / Abu Dhabi shape: reason = 'ROUTE_REJECT: <bare reason>'.
async function cleanupGenericRouteRejects(pool, schema) {
  const retentionDays = await getRetentionDays(pool, schema);
  if (!retentionDays || retentionDays <= 0) return { skipped: true, retentionDays };
  const { rowCount } = await pool.query(
    `DELETE FROM ${schema}.match_runs
     WHERE result_status = 'REJECTED'
       AND reason LIKE 'ROUTE_REJECT:%'
       AND created_at < now() - ($1 || ' days')::interval`,
    [retentionDays]
  );
  return { skipped: false, retentionDays, deleted: rowCount };
}

// Dubai shape: the bare reason lands in no_match_reason instead.
async function cleanupDubaiStyleRouteRejects(pool, schema) {
  const retentionDays = await getRetentionDays(pool, schema);
  if (!retentionDays || retentionDays <= 0) return { skipped: true, retentionDays };
  const { rowCount } = await pool.query(
    `DELETE FROM ${schema}.match_runs
     WHERE result_status = 'REJECTED'
       AND no_match_reason = ANY($1)
       AND created_at < now() - ($2 || ' days')::interval`,
    [DUBAI_ROUTE_REJECT_REASONS, retentionDays]
  );
  return { skipped: false, retentionDays, deleted: rowCount };
}

// Runs once immediately (after a short startup delay, so a fresh deploy
// doesn't wait a full interval before its first pass) and then on a fixed
// interval. Every tick re-reads route_reject_retention_days from the DB, so
// an operator's change via Settings -> Apply takes effect on the next tick
// without a service restart. Failures are logged and swallowed -- a
// transient DB hiccup here must never crash the matching service.
function scheduleRouteRejectCleanup(pool, { schema, cleanupFn, log = console, intervalMs = 60 * 60 * 1000, startupDelayMs = 30 * 1000 }) {
  async function tick() {
    try {
      const result = await cleanupFn(pool, schema);
      if (result.skipped) {
        log.info?.({ schema, ...result }, 'route_reject_cleanup_skipped') ?? log.log?.(`[route-reject-cleanup] ${schema}: disabled (retention <= 0)`);
      } else if (result.deleted > 0) {
        log.info?.({ schema, ...result }, 'route_reject_cleanup_ran') ?? log.log?.(`[route-reject-cleanup] ${schema}: deleted ${result.deleted} row(s), retention=${result.retentionDays}d`);
      }
    } catch (err) {
      log.error?.({ schema, err: err.message }, 'route_reject_cleanup_failed') ?? log.error?.(`[route-reject-cleanup] ${schema} FAILED:`, err.message);
    }
  }
  const startupTimer = setTimeout(tick, startupDelayMs);
  const interval = setInterval(tick, intervalMs);
  return () => {
    clearTimeout(startupTimer);
    clearInterval(interval);
  };
}

module.exports = {
  DUBAI_ROUTE_REJECT_REASONS,
  getRetentionDays,
  cleanupGenericRouteRejects,
  cleanupDubaiStyleRouteRejects,
  scheduleRouteRejectCleanup,
};
