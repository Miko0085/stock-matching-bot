'use strict';

const { buildServer } = require('./api/server');
const { loadConfig } = require('./config');
const { scheduleRouteRejectCleanup, cleanupDubaiStyleRouteRejects } = require('../../src/db/route-reject-cleanup');

async function main() {
  const config = loadConfig();
  const app = buildServer({ config });

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`Lead Matching Service listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // 2026-10-06: prunes pure route-gate "noise" REJECTED rows (other
  // markets' traffic fanned into this service's webhook, correctly
  // rejected by source-routing.js). Dubai stores the bare reason in
  // no_match_reason (not a dedicated `reason` column like RF/Abu Dhabi),
  // alongside separately-meaningful content-gate reasons -- hence the
  // Dubai-specific cleanup function (explicit allow-list of route-gate
  // reasons only, see src/db/route-reject-cleanup.js). Operator-
  // configurable via route_reject_retention_days (/settings); 0 disables.
  const stopCleanup = scheduleRouteRejectCleanup(app.lmsDeps.pool, {
    schema: 'matching_dubai',
    cleanupFn: cleanupDubaiStyleRouteRejects,
    log: app.log,
  });

  const shutdown = async () => {
    stopCleanup();
    await app.close();
    await app.lmsDeps.pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { main };
