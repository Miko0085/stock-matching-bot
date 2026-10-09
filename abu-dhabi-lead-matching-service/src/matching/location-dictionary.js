'use strict';

const { resolveAlias } = require('../../../src/core/aliases');
const { normalizeAliasKey } = require('../../../src/core/normalize');

// The "location dictionary" (spec sections 5-9): ONE reusable resolver that
// tells a raw area/project/building name what it MEANS, without ever
// inventing a synonym. It layers two sources, in priority order:
//
//   1. `alias` -- an explicit row in matching_abu_dhabi.matching_aliases (the existing
//      engine, src/core/aliases.js -- reused verbatim, not rewritten).
//   2. `canonical` -- the raw value already equals a real, distinct value
//      seen in matching_abu_dhabi.stock_inventory (area / project_community /
//      building), even though NO alias row mentions it. This is the fix for
//      the confirmed gap (spec section 8): 41/94 ACTIVE stock rows have a
//      project_community, but matching_aliases has zero type='project' rows
//      -- without this layer, every one of those real project names would
//      wrongly resolve as "unrecognized."
//
// Neither layer ever fuzzy-matches, and this module never writes anything
// back to matching_aliases -- the canonical layer is read-only, derived
// from stock data at cache-refresh time (see repositories/
// canonical-registry-repository.js), never persisted as a fake alias row.
function buildCanonicalRegistry(stockRows = []) {
  const registry = { area: new Map(), project: new Map(), building: new Map() };
  const fieldByType = { area: 'area', project: 'project_community', building: 'building' };

  for (const row of stockRows) {
    if (!row) continue;
    for (const type of Object.keys(fieldByType)) {
      const value = row[fieldByType[type]];
      if (!value) continue;
      const key = normalizeAliasKey(value);
      if (!key || registry[type].has(key)) continue;
      // A project/building's own row also carries the area it sits in --
      // useful diagnostic context (e.g. "this project is in Dubai Marina"),
      // never used to broaden a request (TZ P0.2 / spec section 9).
      registry[type].set(key, { canonical: value, parentArea: row.area || null });
    }
  }

  return registry;
}

function resolveFromRegistry(type, rawValue, canonicalRegistry) {
  const bucket = canonicalRegistry && canonicalRegistry[type];
  if (!bucket) return null;
  const key = normalizeAliasKey(rawValue);
  return bucket.get(key) || null;
}

// Builds the composed resolver. `resolve(type, raw)` returns:
//   { raw, type, canonical, resolved, resolution_source: 'alias'|'canonical'|null, parent_area }
// `resolved: false` always means "genuinely unrecognized by either layer" --
// callers must never treat an unresolved raw term as if it were canonical.
function buildLocationDictionary({ aliasIndex = {}, canonicalRegistry = {} } = {}) {
  function resolve(type, rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      return { raw: rawValue, type, canonical: null, value: null, resolved: false, resolution_source: null, parent_area: null };
    }

    const aliasResult = resolveAlias(type, rawValue, aliasIndex);
    if (aliasResult.resolved) {
      return {
        raw: rawValue,
        type,
        canonical: aliasResult.value,
        value: aliasResult.value,
        resolved: true,
        resolution_source: 'alias',
        parent_area: aliasResult.parentArea || null,
      };
    }

    const registryHit = resolveFromRegistry(type, rawValue, canonicalRegistry);
    if (registryHit) {
      return {
        raw: rawValue,
        type,
        canonical: registryHit.canonical,
        value: registryHit.canonical,
        resolved: true,
        resolution_source: 'canonical',
        parent_area: registryHit.parentArea || null,
      };
    }

    // Unrecognized by either layer -- `value` still carries the raw text
    // (mirrors resolveAlias()'s existing contract) so callers can fall back
    // to an exact-text existence check against stock, but `canonical` stays
    // null and `resolved` stays false: never mistake this for a proven
    // match (final principle 8: "no alias must never be disguised as
    // proven no-stock" -- the inverse also holds, an unresolved raw value
    // must never be disguised as a confirmed canonical one).
    return { raw: rawValue, type, canonical: null, value: rawValue, resolved: false, resolution_source: null, parent_area: null };
  }

  return { resolve };
}

module.exports = { buildCanonicalRegistry, buildLocationDictionary };
