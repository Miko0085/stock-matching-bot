'use strict';

// Reuses the exact same pool factory as nika-matching-pilot-starter's n8n
// tooling (TZ 64: "не создавать отдельный PostgreSQL") -- one shared
// `matching` schema, same connection convention, no parallel DB client
// implementation invented for this service.
const { createPool } = require('../../../src/db/pool');

module.exports = { createPool };
