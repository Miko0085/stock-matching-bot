'use strict';

const { makeStockRepository } = require('./stock-repository');
const { buildCanonicalRegistry } = require('../matching/location-dictionary');

// Mirrors alias-repository.js's loadAliasIndex() shape, but for the
// stock-derived canonical registry layer (spec sections 6-8): read the
// distinct area/project_community/building values straight from live
// stock, build the lookup once, cache it the same TTL-bounded way as the
// alias index (see services/alias-cache.js, reused as-is in server.js).
async function loadCanonicalRegistry(pool) {
  const rows = await makeStockRepository(pool).getDistinctLocationRows();
  return buildCanonicalRegistry(rows);
}

module.exports = { loadCanonicalRegistry };
