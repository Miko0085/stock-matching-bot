'use strict';

// Write-side queries for /stock on the four Joker-fed, stock-visibility-
// only markets (Moscow/Oman/Saudi/Turkey) -- 2026-10-07, extending the
// Dubai/Abu Dhabi editing feature (dashboard/stock-admin-queries.js) to
// "all regions" per operator request. Deliberately a SEPARATE module, not
// a generalized shared one: this schema's shape (joker_object_id BIGINT
// identity, district/complex/rooms/agent_* fields, no text `status`
// column at all) is genuinely different from Dubai's, and AGENTS.md
// section 0 forbids forcing one market's fields into another's shape.
//
// Two important differences from the Dubai/Abu Dhabi editor:
//  1. There is no `status` column here. The nearest equivalent to
//     "activate/deactivate" is `include_in_matching` -- explicitly a
//     human-curator override (src/joker/joker-stock-repository.js's own
//     UPSERT never re-sets it once a row exists), unlike `available`,
//     which the sync pipeline fully owns and would just overwrite back on
//     the next run. Only `include_in_matching` is exposed as a toggle
//     here; `available` is deliberately never editable.
//  2. Every OTHER editable field (price, bedrooms, district, agent
//     contact, etc.) IS re-synced from Joker on every run -- a manual
//     correction here is a between-syncs fix, not a permanent override,
//     same caveat that already implicitly applies to Dubai's Google-
//     Sheets-sourced fields.
const { coerceNumeric } = require('../src/core/sync-normalize');

const JOKER_WRITABLE_SCHEMAS = new Set(['matching_moscow', 'matching_oman', 'matching_saudi', 'matching_turkey']);

function assertValidSchema(schema) {
  if (!JOKER_WRITABLE_SCHEMAS.has(schema)) {
    throw new Error(`joker-stock-admin-queries: schema "${schema}" is not in the writable allow-list`);
  }
}

async function updateIncludeInMatching(pool, { schema, jokerObjectId, includeInMatching }) {
  assertValidSchema(schema);
  const { rowCount } = await pool.query(
    `UPDATE ${schema}.stock_inventory SET include_in_matching = $1 WHERE joker_object_id = $2`,
    [Boolean(includeInMatching), jokerObjectId]
  );
  if (!rowCount) {
    return { ok: false, error: `Объект ${jokerObjectId} не найден.` };
  }
  return { ok: true };
}

// column -> coercion type. Excludes id/joker_object_id (identity),
// joker_url (external link, not a fact about the unit), available (sync-
// owned, see module comment), raw_payload/synced_at (bookkeeping),
// rooms_sentinel/property_type_excluded/property_type (all DERIVED by the
// sync's own normalization from rooms_raw/property_type_raw -- editing
// the raw field and re-syncing is the correct way to fix these, not
// hand-editing the derived one, which the next sync would silently
// recompute over anyway).
const EDITABLE_FIELDS = {
  agent_name: 'text',
  agent_phone: 'text',
  agent_email: 'text',
  property_type_raw: 'text',
  deal_type: 'text',
  city: 'text',
  district: 'text',
  complex: 'text',
  rooms: 'int',
  bedrooms: 'int',
  floor: 'int',
  floors_total: 'int',
  readiness_year: 'int',
  readiness_quarter: 'int',
  area_sqm: 'numeric',
  price: 'numeric',
};

function coerceField(type, raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (trimmed === '' || trimmed === undefined) return null;
  if (type === 'int') {
    const n = Number.parseInt(trimmed, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'numeric') {
    return coerceNumeric(trimmed);
  }
  return trimmed;
}

async function getStockRow(pool, { schema, jokerObjectId }) {
  assertValidSchema(schema);
  const { rows } = await pool.query(`SELECT * FROM ${schema}.stock_inventory WHERE joker_object_id = $1`, [jokerObjectId]);
  return rows[0] || null;
}

async function updateStockFields(pool, { schema, jokerObjectId, fields }) {
  assertValidSchema(schema);
  const setClauses = [];
  const params = [];

  for (const [key, type] of Object.entries(EDITABLE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    params.push(coerceField(type, fields[key]));
    setClauses.push(`${key} = $${params.length}`);
  }

  if (!setClauses.length) {
    return { ok: false, error: 'Нет полей для обновления.' };
  }

  params.push(jokerObjectId);
  try {
    const { rowCount } = await pool.query(
      `UPDATE ${schema}.stock_inventory SET ${setClauses.join(', ')} WHERE joker_object_id = $${params.length}`,
      params
    );
    if (!rowCount) {
      return { ok: false, error: `Объект ${jokerObjectId} не найден.` };
    }
    return { ok: true };
  } catch (err) {
    // readiness_quarter has a real CHECK (1-4 or null) constraint -- a bad
    // manual value must surface as a friendly validation error, not a 500.
    return { ok: false, error: `Не удалось сохранить: ${err.message}` };
  }
}

module.exports = {
  JOKER_WRITABLE_SCHEMAS,
  EDITABLE_FIELDS,
  updateIncludeInMatching,
  getStockRow,
  updateStockFields,
};
