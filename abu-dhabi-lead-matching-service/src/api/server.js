'use strict';

const Fastify = require('fastify');

const { loadConfig } = require('../config');
const { createPool } = require('../repositories/pool');
const matchRepo = require('../repositories/match-repository');
const configRepo = require('../repositories/config-repository');
const interpretationCacheRepo = require('../repositories/interpretation-cache-repository');
const { makeStockRepository } = require('../repositories/stock-repository');
const sourceRoutingGate = require('../gates/source-routing');
const aliasRepo = require('../repositories/alias-repository');
const { classifyAndParse } = require('../parser/openai-client');
const telegramSender = require('../notifications/telegram-sender');

const { requireApiKey } = require('./auth');
const { registerHealthRoute } = require('./routes/health');
const { registerWebhookRoutes } = require('./routes/webhooks');

function buildServer(overrides = {}) {
  const config = overrides.config || loadConfig();
  const pool = overrides.pool || createPool({ DATABASE_URL: config.databaseUrl });

  const deps = {
    config,
    pool,
    matchRepo: overrides.matchRepo || matchRepo,
    configRepo: overrides.configRepo || configRepo,
    interpretationCacheRepo: overrides.interpretationCacheRepo || interpretationCacheRepo,
    stockRepo: overrides.stockRepo || makeStockRepository(pool),
    sourceRoutingGate: overrides.sourceRoutingGate || sourceRoutingGate,
    aliasRepo: overrides.aliasRepo || aliasRepo,
    classifyAndParse: overrides.classifyAndParse || classifyAndParse,
    telegramSender: overrides.telegramSender || telegramSender,
    logEvent: overrides.logEvent || ((fields) => app.log.info(fields, 'abu_dhabi_lead_matching_pipeline')),
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

  app.decorate('abuDhabiDeps', deps);
  return app;
}

module.exports = { buildServer };
