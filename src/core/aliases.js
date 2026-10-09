'use strict';

const { normalizeAliasKey } = require('./normalize');

// Builds a lookup index from matching_aliases rows:
//   { [type]: Map(normalizedKey -> { canonical, parentArea }) }
// Both the alias itself and its canonical value are indexed so a raw value
// that already matches the canonical spelling resolves without needing a
// redundant self-referencing alias row.
function buildAliasIndex(aliasRows = []) {
  const index = {};
  for (const row of aliasRows) {
    if (!row || row.enabled === false) continue;
    const type = row.type;
    const canonical = row.canonical;
    if (!type || !canonical) continue;
    if (!index[type]) index[type] = new Map();

    const aliasKey = normalizeAliasKey(row.alias);
    if (aliasKey && !index[type].has(aliasKey)) {
      index[type].set(aliasKey, { canonical, parentArea: row.parent_area || null });
    }

    const canonicalKey = normalizeAliasKey(canonical);
    if (canonicalKey && !index[type].has(canonicalKey)) {
      index[type].set(canonicalKey, { canonical, parentArea: row.parent_area || null });
    }
  }
  return index;
}

// Normalize -> exact alias lookup -> canonical. Never fuzzy-matches. When the
// raw value cannot be resolved it is retained as-is so the caller can still
// attempt a direct comparison and diagnose the miss later.
function resolveAlias(type, rawValue, index) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return { input: rawValue, value: null, normalized: null, resolved: false, present: false };
  }

  const key = normalizeAliasKey(rawValue);
  const bucket = index && index[type];
  const hit = bucket ? bucket.get(key) : undefined;

  if (hit) {
    return {
      input: rawValue,
      value: hit.canonical,
      normalized: normalizeAliasKey(hit.canonical),
      parentArea: hit.parentArea || null,
      resolved: true,
      present: true,
    };
  }

  return {
    input: rawValue,
    value: rawValue,
    normalized: key,
    resolved: false,
    present: true,
  };
}

module.exports = { buildAliasIndex, resolveAlias };
