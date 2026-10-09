'use strict';

// Sibling of src/db/stockRepository.js (hardcoded to matching_dubai),
// targeting matching_abu_dhabi -- same sheet-era column contract (the
// exact shape recovered from the deleted n8n stock-sync code, ADR-040),
// since Abu Dhabi's Google Sheets sync mirrors Dubai's original one.

const UPSERT_SQL = `
  INSERT INTO matching_abu_dhabi.stock_inventory (
    stock_id, status, transaction_type, city, area, project_community, building,
    bedrooms, bedrooms_label, bathrooms, property_type, selling_price, annual_rent,
    size_sqft, plot_size_sqft, furnishing, view, broker, broker_contact,
    notes, source_updated_at, synced_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
    $18, $19, $20, $21, now()
  )
  ON CONFLICT (stock_id) DO UPDATE SET
    status = EXCLUDED.status,
    transaction_type = EXCLUDED.transaction_type,
    city = EXCLUDED.city,
    area = EXCLUDED.area,
    project_community = EXCLUDED.project_community,
    building = EXCLUDED.building,
    bedrooms = EXCLUDED.bedrooms,
    bedrooms_label = EXCLUDED.bedrooms_label,
    bathrooms = EXCLUDED.bathrooms,
    property_type = EXCLUDED.property_type,
    selling_price = EXCLUDED.selling_price,
    annual_rent = EXCLUDED.annual_rent,
    size_sqft = EXCLUDED.size_sqft,
    plot_size_sqft = EXCLUDED.plot_size_sqft,
    furnishing = EXCLUDED.furnishing,
    view = EXCLUDED.view,
    broker = EXCLUDED.broker,
    broker_contact = EXCLUDED.broker_contact,
    notes = EXCLUDED.notes,
    source_updated_at = EXCLUDED.source_updated_at,
    synced_at = now()
`;

async function upsertStock(client, row) {
  await client.query(UPSERT_SQL, [
    row.stock_id,
    row.status,
    row.transaction_type,
    row.city,
    row.area,
    row.project_community,
    row.building,
    row.bedrooms,
    row.bedrooms_label,
    row.bathrooms,
    row.property_type,
    row.selling_price,
    row.annual_rent,
    row.size_sqft,
    row.plot_size_sqft,
    row.furnishing,
    row.view,
    row.broker,
    row.broker_contact,
    row.notes,
    row.source_updated_at,
  ]);
}

async function upsertStockRows(client, rows) {
  for (const row of rows) {
    await upsertStock(client, row);
  }
}

async function fetchActiveStock(client, { transactionTypes = ['SALE'] } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM matching_abu_dhabi.stock_inventory WHERE status = 'ACTIVE' AND transaction_type = ANY($1)`,
    [transactionTypes]
  );
  return rows;
}

module.exports = { upsertStock, upsertStockRows, fetchActiveStock };
