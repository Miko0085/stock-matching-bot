'use strict';

const UPSERT_SQL = `
  INSERT INTO matching_dubai.matching_aliases (
    type, alias, alias_normalized, canonical, canonical_normalized, parent_area, enabled, synced_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
  ON CONFLICT (type, alias_normalized) DO UPDATE SET
    alias = EXCLUDED.alias,
    canonical = EXCLUDED.canonical,
    canonical_normalized = EXCLUDED.canonical_normalized,
    parent_area = EXCLUDED.parent_area,
    enabled = EXCLUDED.enabled,
    synced_at = now()
`;

async function upsertAlias(client, row) {
  await client.query(UPSERT_SQL, [
    row.type,
    row.alias,
    row.alias_normalized,
    row.canonical,
    row.canonical_normalized,
    row.parent_area,
    row.enabled,
  ]);
}

async function upsertAliasRows(client, rows) {
  for (const row of rows) {
    await upsertAlias(client, row);
  }
}

async function fetchEnabledAliases(client) {
  const { rows } = await client.query(
    'SELECT type, alias, canonical, parent_area, enabled FROM matching_dubai.matching_aliases WHERE enabled = true'
  );
  return rows;
}

module.exports = { upsertAlias, upsertAliasRows, fetchEnabledAliases };
