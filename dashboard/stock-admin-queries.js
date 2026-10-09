'use strict';

// Write-side queries for /stock (2026-10-07): an operator-facing status
// toggle and full-field edit, so a bad/incomplete stock row (wrong area,
// missing price, stuck NEEDS_REVIEW/INACTIVE) can be corrected from the
// dashboard instead of a direct DB query. Parallel naming to the existing
// dashboard/broker-admin-queries.js (admin/write operations the dashboard
// itself performs, as opposed to dashboard/queries.js's read-only layer).
//
// Scoped to the two markets with a real matcher and a real stock_inventory
// a human edits directly (matching_dubai, matching_abu_dhabi) -- the
// Joker-fed markets' stock is owned by the Joker sync pipeline and would
// just be overwritten on the next sync, so they are never writable here.
const { coerceNumeric } = require('../src/core/sync-normalize');

const STOCK_WRITABLE_SCHEMAS = new Set(['matching_dubai', 'matching_abu_dhabi']);

function assertValidSchema(schema) {
  if (!STOCK_WRITABLE_SCHEMAS.has(schema)) {
    throw new Error(`stock-admin-queries: schema "${schema}" is not in the writable allow-list`);
  }
}

async function updateStockStatus(pool, { schema, stockId, status }) {
  assertValidSchema(schema);
  const trimmed = typeof status === 'string' ? status.trim() : '';
  if (!trimmed) {
    return { ok: false, error: 'Статус не может быть пустым.' };
  }
  const { rowCount } = await pool.query(
    `UPDATE ${schema}.stock_inventory SET status = $1, synced_at = now() WHERE stock_id = $2`,
    [trimmed, stockId]
  );
  if (!rowCount) {
    return { ok: false, error: `Объект ${stockId} не найден.` };
  }
  return { ok: true };
}

// column -> coercion type. Deliberately excludes stock_id (primary key,
// referenced by match_results -- never editable), synced_at/stock_source
// (sync bookkeeping/provenance, not a real-estate fact to hand-edit).
const EDITABLE_FIELDS = {
  area: 'text',
  building: 'text',
  project_community: 'text',
  property_type: 'text',
  transaction_type: 'text',
  furnishing: 'text',
  view: 'text',
  broker: 'text',
  broker_contact: 'text',
  notes: 'text',
  city: 'text',
  bedrooms: 'int',
  bathrooms: 'numeric',
  selling_price: 'numeric',
  annual_rent: 'numeric',
  size_sqft: 'numeric',
  plot_size_sqft: 'numeric',
  status: 'text',
};

// stock_inventory.status/transaction_type are NOT NULL -- an empty
// submission for either must be rejected, never silently written as NULL
// (which would throw a real DB error) or as '' (a value that would then
// quietly fail every status/transaction_type-scoped match/filter).
const REQUIRED_FIELDS = new Set(['status', 'transaction_type']);

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

async function getStockRow(pool, { schema, stockId }) {
  assertValidSchema(schema);
  const { rows } = await pool.query(`SELECT * FROM ${schema}.stock_inventory WHERE stock_id = $1`, [stockId]);
  return rows[0] || null;
}

async function updateStockFields(pool, { schema, stockId, fields }) {
  assertValidSchema(schema);
  const setClauses = [];
  const params = [];

  for (const [key, type] of Object.entries(EDITABLE_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const value = coerceField(type, fields[key]);
    if (value === null && REQUIRED_FIELDS.has(key)) {
      return { ok: false, error: key === 'status' ? 'Статус не может быть пустым.' : 'Тип сделки не может быть пустым.' };
    }
    params.push(value);
    setClauses.push(`${key} = $${params.length}`);
  }

  if (!setClauses.length) {
    return { ok: false, error: 'Нет полей для обновления.' };
  }

  params.push(stockId);
  try {
    const { rowCount } = await pool.query(
      `UPDATE ${schema}.stock_inventory SET ${setClauses.join(', ')}, synced_at = now() WHERE stock_id = $${params.length}`,
      params
    );
    if (!rowCount) {
      return { ok: false, error: `Объект ${stockId} не найден.` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Не удалось сохранить: ${err.message}` };
  }
}

module.exports = {
  STOCK_WRITABLE_SCHEMAS,
  EDITABLE_FIELDS,
  updateStockStatus,
  getStockRow,
  updateStockFields,
};
