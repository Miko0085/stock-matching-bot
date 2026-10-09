'use strict';

const { normalizeText, normalizeAliasKey, normalizeBedrooms, bedroomsLabel } = require('./normalize');

// Maps the original stock export's status vocabulary onto the pilot's
// ACTIVE/non-ACTIVE runtime scope. Anything not explicitly "live"/"pocket"
// (including takendown / takendown_validation_failed) passes through
// uppercased so it is still recorded and reconcilable, but never equals
// 'ACTIVE' and therefore never enters realtime matching.
function normalizeStockStatus(rawStatus) {
  const text = normalizeText(rawStatus);
  if (text === 'live' || text === 'pocket' || text === 'active') return 'ACTIVE';
  if (!text) return 'UNKNOWN';
  return text.toUpperCase();
}

// Strips everything except digits/decimal-point/leading-minus -- not just
// commas/whitespace. Found 2026-10-06 syncing real Abu Dhabi data: Google
// Sheets' FORMATTED_VALUE render option (the API's default, and what
// src/google-sheets/sheets-client.js reads) returns a currency-formatted
// cell as its DISPLAY STRING, e.g. "8 100 000 AED" or "1,243" -- the old
// comma/whitespace-only strip left "8100000AED", which Number() rejects
// outright (silently became null for every priced row). A thousands-
// separator space and a currency-suffix letter are both just as much
// "not a digit" as a comma, so strip the same broad way.
function coerceNumeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// source_updated_at lands in a TIMESTAMPTZ column -- a literal non-date
// string (confirmed real case: an export tool left the literal word
// "export" in this column for every row, with the real date shifted into
// an unrelated extra column) must become NULL, never reach the INSERT as
// unparseable text and fail the whole batch.
function coerceDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? text : null;
}

// Validates + normalizes one raw Stock Inventory sheet row. Never throws —
// bad rows are reported via `errors` so the sync can skip them and continue.
function validateStockRow(raw) {
  const errors = [];
  const source = raw && typeof raw === 'object' ? raw : {};
  const stockId = source.stock_id !== undefined && source.stock_id !== null
    ? String(source.stock_id).trim()
    : '';

  if (!stockId) {
    errors.push('missing_stock_id');
    return { value: null, errors };
  }

  const bedrooms = normalizeBedrooms(source.bedrooms);

  const value = {
    stock_id: stockId,
    status: normalizeStockStatus(source.status),
    transaction_type: source.transaction_type
      ? normalizeText(source.transaction_type).toUpperCase()
      : null,
    city: source.city || null,
    area: source.area || null,
    project_community: source.project_community || null,
    building: source.building || null,
    bedrooms,
    bedrooms_label: source.bedrooms_label || bedroomsLabel(bedrooms),
    bathrooms: coerceNumeric(source.bathrooms),
    property_type: source.property_type || null,
    selling_price: coerceNumeric(source.selling_price),
    annual_rent: coerceNumeric(source.annual_rent),
    size_sqft: coerceNumeric(source.size_sqft),
    plot_size_sqft: coerceNumeric(source.plot_size_sqft),
    furnishing: source.furnishing || null,
    view: source.view || null,
    broker: source.broker || null,
    broker_contact: source.broker_contact || null,
    notes: source.notes || null,
    source_updated_at: coerceDate(source.source_updated_at),
  };

  return { value, errors };
}

// Last row wins for a duplicate stock_id — deterministic and matches how a
// human editing a spreadsheet expects a later row to override an earlier one.
function dedupeStockRows(rows) {
  const byId = new Map();
  const duplicates = [];
  for (const row of rows) {
    if (byId.has(row.stock_id)) duplicates.push(row.stock_id);
    byId.set(row.stock_id, row);
  }
  return { rows: [...byId.values()], duplicates };
}

function validateAliasRow(raw) {
  const errors = [];
  const source = raw && typeof raw === 'object' ? raw : {};
  const type = source.type ? normalizeText(source.type) : '';
  const alias = source.alias ? String(source.alias).trim() : '';
  const canonical = source.canonical ? String(source.canonical).trim() : '';

  if (!type || !alias || !canonical) {
    errors.push('missing_required_field');
    return { value: null, errors };
  }

  const value = {
    type,
    alias,
    alias_normalized: normalizeAliasKey(alias),
    canonical,
    canonical_normalized: normalizeAliasKey(canonical),
    parent_area: source.parent_area || null,
    enabled: source.enabled === undefined || source.enabled === null
      ? true
      : Boolean(source.enabled) && normalizeText(source.enabled) !== 'false',
  };

  return { value, errors };
}

// Last row wins for a duplicate (type, alias_normalized) pair.
function dedupeAliasRows(rows) {
  const byKey = new Map();
  const duplicates = [];
  for (const row of rows) {
    const key = `${row.type}::${row.alias_normalized}`;
    if (byKey.has(key)) duplicates.push(key);
    byKey.set(key, row);
  }
  return { rows: [...byKey.values()], duplicates };
}

module.exports = {
  normalizeStockStatus,
  coerceNumeric,
  coerceDate,
  validateStockRow,
  dedupeStockRows,
  validateAliasRow,
  dedupeAliasRows,
};
