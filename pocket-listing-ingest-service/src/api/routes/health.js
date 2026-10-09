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
      service: 'pocket-listing-ingest-service',
      source_chat_ids: config.sourceChatIds,
      database,
    };
  });
}

module.exports = { registerHealthRoute };
