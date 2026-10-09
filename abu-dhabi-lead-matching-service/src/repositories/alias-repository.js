'use strict';

// Reuses the existing, already-tested repository/domain functions rather
// than a parallel SQL implementation -- BY ANALOGY with
// dubai-lead-matching-service's own alias-repository.js, pointed at
// src/db/abuDhabiAliasRepository.js (matching_abu_dhabi) instead.
const { fetchEnabledAliases } = require('../../../src/db/abuDhabiAliasRepository');
const { buildAliasIndex } = require('../../../src/core/aliases');

async function loadAliasIndex(pool) {
  const rows = await fetchEnabledAliases(pool);
  return buildAliasIndex(rows);
}

module.exports = { loadAliasIndex };
