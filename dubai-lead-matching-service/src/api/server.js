'use strict';

const Fastify = require('fastify');

const { loadConfig } = require('../config');
const { createPool } = require('../repositories/pool');
const { loadAliasIndex } = require('../repositories/alias-repository');
const { loadCanonicalRegistry } = require('../repositories/canonical-registry-repository');
const { makeStockRepository } = require('../repositories/stock-repository');
const { buildLocationDictionary } = require('../matching/location-dictionary');
const matchRepo = require('../repositories/match-repository');
const aiUsageRepo = require('../repositories/ai-usage-repository');
const eventDedupRepo = require('../repositories/event-dedup-repository');
const interpretationCacheRepo = require('../repositories/interpretation-cache-repository');
const { classifyAndParse } = require('../parser/openai-client');
const { createAliasCache } = require('../services/alias-cache');
const { loadActiveV2Config } = require('../repositories/config-repository');
const { evaluateShadowGate, evaluateAuthoritativeGate, recordGateFallback } = require('../services/shadow-evaluator');
const { lookupSourceRoute } = require('../gates/source-routing');

const { requireApiKey } = require('./auth');
const { registerHealthRoute } = require('./routes/health');
const { registerWebhookRoutes } = require('./routes/webhooks');
const { registerMatchRoute } = require('./routes/match');

// Builds the Fastify app with all dependencies wired via plain function
// injection (TZ 32: the matching core knows nothing about Postgres/OpenAI
// directly -- everything it needs is handed to it as a function). Accepts
// overrides so tests can swap in fakes (an in-memory pool, a mock
// classifyAndParse) without touching a real database or OpenAI (TZ 86).
function buildServer(overrides = {}) {
  const config = overrides.config || loadConfig();
  const pool = overrides.pool || createPool({ DATABASE_URL: config.databaseUrl });
  const aliasCache = overrides.aliasCache || createAliasCache({ loader: () => loadAliasIndex(pool) });
  // Same generic TTL-bounded cache factory as aliasCache -- it isn't
  // actually alias-specific, just named after its first use (see
  // services/alias-cache.js). Refreshes independently of the alias cache
  // since it's sourced from stock, not matching_aliases.
  const canonicalRegistryCache = overrides.canonicalRegistryCache || createAliasCache({ loader: () => loadCanonicalRegistry(pool) });
  // Nika Matching V2, Phase 3: the ACTIVE (applied, never draft) config
  // Phase 1/1.1/2 already persist, cached with the same generic,
  // TTL-bounded factory as the alias/canonical caches above -- reused
  // exactly per the Phase 3 instructions ("Use the existing config
  // repository where appropriate... Avoid a fresh DB roundtrip per
  // individual rule... do not over-engineer caching in Phase 3"). A 60s
  // staleness window is acceptable here: this only feeds the SHADOW gate,
  // never a live decision, so a config Apply taking up to a minute to be
  // reflected in shadow telemetry has no production consequence.
  const v2ConfigCache = overrides.v2ConfigCache || createAliasCache({ loader: () => loadActiveV2Config(pool) });

  const deps = {
    config,
    pool,
    stockRepo: overrides.stockRepo || makeStockRepository(pool),
    matchRepo: overrides.matchRepo || matchRepo,
    aiUsageRepo: overrides.aiUsageRepo || aiUsageRepo,
    eventDedupRepo: overrides.eventDedupRepo || eventDedupRepo,
    interpretationCacheRepo: overrides.interpretationCacheRepo || interpretationCacheRepo,
    classifyAndParse: overrides.classifyAndParse || classifyAndParse,
    getAliasIndex: () => aliasCache.get(),
    getLocationDictionary: async () => {
      const [aliasIndex, canonicalRegistry] = await Promise.all([aliasCache.get(), canonicalRegistryCache.get()]);
      return buildLocationDictionary({ aliasIndex, canonicalRegistry });
    },
    getActiveV2Config: () => v2ConfigCache.get(),
    logEvent: overrides.logEvent || ((fields) => app.log.info(fields, 'lead_matching_pipeline')),
  };

  // Assigned AFTER `deps` exists: evaluateShadowGate's own signature takes
  // `deps` as a parameter (it reads deps.pool and calls
  // deps.getActiveV2Config()), so this is a deliberate self-referencing
  // closure -- see services/shadow-evaluator.js. `overrides.evaluateShadowGate
  // === null` (explicitly, not just falsy/undefined) lets a test opt OUT of
  // shadow evaluation entirely; anything else defaults to wiring it in, since
  // real production behavior should always run Phase 3 shadow instrumentation.
  deps.evaluateShadowGate = overrides.evaluateShadowGate === null
    ? undefined
    : (overrides.evaluateShadowGate || evaluateShadowGate);

  // Phase 4: same optional-via-deps convention as evaluateShadowGate above
  // -- `overrides.evaluateAuthoritativeGate === null` (or
  // `recordGateFallback === null`) lets a test opt out explicitly;
  // anything else wires in the real implementation, since real production
  // traffic should always be able to honor an operator turning cutover on.
  deps.evaluateAuthoritativeGate = overrides.evaluateAuthoritativeGate === null
    ? undefined
    : (overrides.evaluateAuthoritativeGate || evaluateAuthoritativeGate);
  deps.recordGateFallback = overrides.recordGateFallback === null
    ? undefined
    : (overrides.recordGateFallback || recordGateFallback);

  // Source lookup / monitoring gate (AGENTS.md section 0's required
  // shared runtime order) -- same optional-via-deps convention: an
  // existing test's deps object built before this gate existed doesn't
  // set it, so processClaimedWebhook() treats every message as eligible,
  // unchanged from before. Real production traffic always gets the real,
  // DB-backed check. `overrides.lookupSourceRoute === null` lets a test
  // opt out explicitly.
  deps.lookupSourceRoute = overrides.lookupSourceRoute === null
    ? undefined
    : (overrides.lookupSourceRoute || lookupSourceRoute);

  const app = Fastify({ logger: { level: config.logLevel } });

  const auth = requireApiKey(config);
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    await auth(request, reply);
  });

  registerHealthRoute(app, { config, pool });
  registerWebhookRoutes(app, { deps });
  registerMatchRoute(app, { deps });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route: ${request.method} ${request.url}` } });
  });

  app.decorate('lmsDeps', deps);
  return app;
}

module.exports = { buildServer };
