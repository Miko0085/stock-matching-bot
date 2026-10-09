'use strict';

function registerHealthRoute(app, { config, pool }) {
  app.get('/health', async () => {
    let database = 'unknown';
    try {
      await pool.query('SELECT 1');
      database = 'ok';
    } catch (err) {
      database = `error: ${err.message}`;
    }
    return {
      status: 'ok',
      service: 'rf-lead-matching-service',
      contour: 'RF',
      matcher_version: config.matcherVersion,
      matching_implemented: true,
      database,
    };
  });
}

module.exports = { registerHealthRoute };
