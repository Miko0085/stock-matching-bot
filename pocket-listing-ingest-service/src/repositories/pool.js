'use strict';

// Reuses the exact same thin pg.Pool factory as the Dubai/Abu Dhabi
// services (pure infra, no domain code).
const { createPool } = require('../../../src/db/pool');

module.exports = { createPool };
