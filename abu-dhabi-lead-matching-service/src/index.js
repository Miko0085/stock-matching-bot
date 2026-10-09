'use strict';

const { buildServer } = require('./api/server');
const { loadConfig } = require('./config');
const { scheduleRouteRejectCleanup, cleanupGenericRouteRejects } = require('../../src/db/route-reject-cleanup');

async function main() {
  const config = loadConfig();
  const app = buildServer({ config });

  await app.listen({ host: config.host, port: config.port });

  // 2026-10-06: prunes pure route-gate "noise" REJECTED rows -- see
  // src/db/route-reject-cleanup.js and rf-lead-matching-service's own
  // index.js (same pattern, BY ANALOGY). Operator-configurable via
  // route_reject_retention_days (/settings?market=abu_dhabi); 0 disables.
  const stopCleanup = scheduleRouteRejectCleanup(app.abuDhabiDeps.pool, {
    schema: 'matching_abu_dhabi',
    cleanupFn: cleanupGenericRouteRejects,
    log: app.log,
  });

  const shutdown = async () => {
    stopCleanup();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('abu-dhabi-lead-matching-service failed to start:', err);
  process.exit(1);
});
