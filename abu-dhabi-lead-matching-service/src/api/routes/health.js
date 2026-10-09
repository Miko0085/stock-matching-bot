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
      service: 'abu-dhabi-lead-matching-service',
      contour: 'ABU_DHABI',
      matcher_version: config.matcherVersion,
      matching_implemented: true,
      database,
    };
  });
}

module.exports = { registerHealthRoute };
