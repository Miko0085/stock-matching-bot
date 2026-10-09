'use strict';

const Fastify = require('fastify');

const { loadConfig } = require('../config');
const { createPool } = require('../repositories/pool');
const ingestLogRepo = require('../repositories/ingest-log-repository');
const stockRepo = require('../repositories/stock-repository');
const { classifyAndParse } = require('../parser/openai-client');

const { requireApiKey } = require('./auth');
const { registerHealthRoute } = require('./routes/health');
const { registerWebhookRoutes } = require('./routes/webhooks');

function buildServer(overrides = {}) {
  const config = overrides.config || loadConfig();
  const pool = overrides.pool || createPool({ DATABASE_URL: config.databaseUrl });

  const deps = {
    config,
    pool,
    ingestLogRepo: overrides.ingestLogRepo || ingestLogRepo,
    stockRepo: overrides.stockRepo || stockRepo,
    classifyAndParse: overrides.classifyAndParse || classifyAndParse,
  };

  const app = Fastify({ logger: { level: config.logLevel } });

  const auth = requireApiKey(config);
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    await auth(request, reply);
  });

  registerHealthRoute(app, { config, pool });
  registerWebhookRoutes(app, { deps });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route: ${request.method} ${request.url}` } });
  });

  app.decorate('pocketListingDeps', deps);
  return app;
}

module.exports = { buildServer };
