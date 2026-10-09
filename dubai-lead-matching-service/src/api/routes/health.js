'use strict';

// GET /health (TZ 75). Never makes a live OpenAI call -- "configured" only
// reflects whether a key is present, not whether it's valid/has quota.
function registerHealthRoute(app, { config, pool }) {
  app.get('/health', async (request, reply) => {
    let database = 'ok';
    try {
      await pool.query('SELECT 1');
    } catch (err) {
      database = 'error';
      request.log.warn({ err }, 'health check: database unreachable');
    }

    reply.send({
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      openai: config.openaiApiKey ? 'configured' : 'missing',
      matcher_version: config.matcherVersion,
    });
  });
}

module.exports = { registerHealthRoute };
