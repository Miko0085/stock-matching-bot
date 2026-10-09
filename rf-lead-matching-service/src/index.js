'use strict';

const { buildServer } = require('./api/server');
const { loadConfig } = require('./config');
const { scheduleRouteRejectCleanup, cleanupGenericRouteRejects } = require('../../src/db/route-reject-cleanup');

async function main() {
  const config = loadConfig();
  const app = buildServer({ config });

  await app.listen({ host: config.host, port: config.port });

  // 2026-10-06: prunes pure route-gate "noise" REJECTED rows (other
  // markets' traffic fanned into this service's webhook, correctly
  // rejected by source-routing.js) -- see src/db/route-reject-cleanup.js.
  // Retention is operator-configurable (route_reject_retention_days,
  // /settings?market=moscow); 0 disables it.
  const stopCleanup = scheduleRouteRejectCleanup(app.rfDeps.pool, {
    schema: 'matching_moscow',
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
  console.error('rf-lead-matching-service failed to start:', err);
  process.exit(1);
});
