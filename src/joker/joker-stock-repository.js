'use strict';

// DB access for matching_<market>.stock_inventory / stock_sync_runs.
// `schema` is NEVER accepted from raw external input -- every entry point
// validates it against MARKET_SCHEMAS (src/joker/joker-market-router.js)
// before interpolating it into a query string, since Postgres has no way
// to bind a schema/table identifier as a query parameter.

const { MARKET_SCHEMAS } = require('./joker-market-router');

const VALID_SCHEMAS = new Set(Object.values(MARKET_SCHEMAS));

function assertValidSchema(schema) {
  if (!VALID_SCHEMAS.has(schema)) {
    throw new Error(`Refusing to query unrecognized schema "${schema}" -- not in the Joker market allow-list`);
  }
}

async function upsertStockRow(pool, schema, row) {
  assertValidSchema(schema);
  const { rows } = await pool.query(
    `INSERT INTO ${schema}.stock_inventory (
       joker_object_id, joker_url, available, deal_type,
       property_type_raw, property_type, property_type_excluded,
       city, district_raw, district, complex_raw, complex,
       rooms_raw, rooms, rooms_sentinel, bedrooms,
       area_sqm, floor, floors_total, price,
       readiness_year, readiness_quarter,
       agent_id, agent_name, agent_phone, agent_email,
       include_in_matching, raw_payload, synced_at
     ) VALUES ($1,$2,true,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,true,$26,now())
     ON CONFLICT (joker_object_id) DO UPDATE SET
       joker_url = EXCLUDED.joker_url,
       available = true,
       deal_type = EXCLUDED.deal_type,
       property_type_raw = EXCLUDED.property_type_raw,
       property_type = EXCLUDED.property_type,
       property_type_excluded = EXCLUDED.property_type_excluded,
       city = EXCLUDED.city,
       district_raw = EXCLUDED.district_raw,
       district = EXCLUDED.district,
       complex_raw = EXCLUDED.complex_raw,
       complex = EXCLUDED.complex,
       rooms_raw = EXCLUDED.rooms_raw,
       rooms = EXCLUDED.rooms,
       rooms_sentinel = EXCLUDED.rooms_sentinel,
       bedrooms = EXCLUDED.bedrooms,
       area_sqm = EXCLUDED.area_sqm,
       floor = EXCLUDED.floor,
       floors_total = EXCLUDED.floors_total,
       price = EXCLUDED.price,
       readiness_year = EXCLUDED.readiness_year,
       readiness_quarter = EXCLUDED.readiness_quarter,
       agent_id = EXCLUDED.agent_id,
       agent_name = EXCLUDED.agent_name,
       agent_phone = EXCLUDED.agent_phone,
       agent_email = EXCLUDED.agent_email,
       raw_payload = EXCLUDED.raw_payload,
       synced_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      row.jokerObjectId, row.jokerUrl, row.dealType, row.propertyTypeRaw, row.propertyType, row.propertyTypeExcluded,
      row.city, row.districtRaw, row.district, row.complexRaw, row.complex,
      row.roomsRaw, row.rooms, row.roomsSentinel, row.bedrooms,
      row.areaSqm, row.floor, row.floorsTotal, row.price,
      row.readinessYear, row.readinessQuarter,
      row.agentId, row.agentName, row.agentPhone, row.agentEmail,
      JSON.stringify(row.rawPayload),
    ]
  );
  return { id: rows[0].id, inserted: rows[0].inserted };
}

// Safe deactivation (never delete), same pattern as UAE's own stock sync
// and ingest.sources' markMissingSourcesUnavailable: any row whose
// joker_object_id was NOT seen in this sync run is marked unavailable.
async function markMissingUnavailable(pool, schema, seenJokerObjectIds) {
  assertValidSchema(schema);
  const ids = seenJokerObjectIds.length ? seenJokerObjectIds : [-1];
  const { rowCount } = await pool.query(
    `UPDATE ${schema}.stock_inventory SET available = false
     WHERE available = true AND joker_object_id <> ALL($1::bigint[])`,
    [ids]
  );
  return rowCount;
}

async function startSyncRun(pool, schema) {
  assertValidSchema(schema);
  const { rows } = await pool.query(
    `INSERT INTO ${schema}.stock_sync_runs (status) VALUES ('RUNNING') RETURNING id`
  );
  return rows[0].id;
}

async function completeSyncRun(pool, schema, runId, { objectsSeen, objectsUpserted, objectsMarkedUnavailable }) {
  assertValidSchema(schema);
  await pool.query(
    `UPDATE ${schema}.stock_sync_runs
     SET status = 'SUCCESS', completed_at = now(), objects_seen = $2, objects_upserted = $3, objects_marked_unavailable = $4
     WHERE id = $1`,
    [runId, objectsSeen, objectsUpserted, objectsMarkedUnavailable]
  );
}

async function failSyncRun(pool, schema, runId, err) {
  assertValidSchema(schema);
  await pool.query(
    `UPDATE ${schema}.stock_sync_runs SET status = 'FAILED', completed_at = now(), error = $2 WHERE id = $1`,
    [runId, String(err && err.message ? err.message : err)]
  );
}

module.exports = {
  VALID_SCHEMAS,
  assertValidSchema,
  upsertStockRow,
  markMissingUnavailable,
  startSyncRun,
  completeSyncRun,
  failSyncRun,
};
