'use strict';

const { buildServer } = require('./api/server');
const { loadConfig } = require('./config');

async function main() {
  const config = loadConfig();
  const app = buildServer({ config });

  await app.listen({ host: config.host, port: config.port });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('pocket-listing-ingest-service failed to start:', err);
  process.exit(1);
});
