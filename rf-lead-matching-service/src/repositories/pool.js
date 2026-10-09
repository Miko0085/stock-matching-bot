'use strict';

// Reuses the exact same thin pg.Pool factory as the Dubai service (pure
// infra, no domain code) -- NOT a shared domain repository. This service
// must only ever query matching_rf.* through its own repositories.
const { createPool } = require('../../../src/db/pool');

module.exports = { createPool };
