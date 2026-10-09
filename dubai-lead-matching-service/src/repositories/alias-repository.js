'use strict';

// Reuses the existing, already-tested repository/domain functions rather
// than a parallel SQL implementation (TZ 66).
const { fetchEnabledAliases } = require('../../../src/db/aliasRepository');
const { buildAliasIndex } = require('../../../src/core/aliases');

async function loadAliasIndex(pool) {
  const rows = await fetchEnabledAliases(pool);
  return buildAliasIndex(rows);
}

module.exports = { loadAliasIndex };
