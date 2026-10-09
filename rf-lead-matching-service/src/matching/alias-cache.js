'use strict';

// Moscow's alias loader -- feeds the SAME shared, market-agnostic engine
// UAE uses (src/core/aliases.js's buildAliasIndex/resolveAlias, already
// living in the shared root src/, not lead-matching-service/, so this
// import is not a cross-contour violation). The table shape genuinely
// differs from matching_dubai.matching_aliases (alias_type/alias_normalized/
// canonical_value vs type/alias/canonical/parent_area, and no `enabled`
// column -- migration 0029 never added one, every seeded alias is simply
// always active), so this adapter, not the loader itself, is new code.
const { buildAliasIndex, resolveAlias } = require('../../../src/core/aliases');

async function fetchEnabledAliases(pool) {
  const { rows } = await pool.query(
    `SELECT alias_type, alias_normalized, canonical_value FROM matching_moscow.location_aliases`
  );
  // Adapt to buildAliasIndex's expected row shape -- alias_normalized is
  // already normalized, but re-normalizing it is a harmless no-op
  // (normalizeAliasKey is idempotent on already-clean text).
  return rows.map((r) => ({
    type: r.alias_type,
    alias: r.alias_normalized,
    canonical: r.canonical_value,
    parent_area: null,
    enabled: true,
  }));
}

async function loadAliasIndex(pool) {
  const rows = await fetchEnabledAliases(pool);
  return buildAliasIndex(rows);
}

module.exports = { fetchEnabledAliases, loadAliasIndex, resolveAlias };
