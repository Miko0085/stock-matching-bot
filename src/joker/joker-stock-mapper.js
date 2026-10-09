'use strict';

// Maps one raw Joker `/objects` payload (full=1 shape, see
// docs/JOKER_API_DISCOVERY.md) into a matching_<market>.stock_inventory row.
// Pure function, no DB/HTTP -- every field path here matches a real,
// confirmed-live Joker object shape.

const {
  normalizeComplex,
  normalizeDistrict,
  normalizeRooms,
  parseAreaSqm,
  normalizeReadiness,
  normalizePropertyType,
} = require('./joker-normalize');

function paramValue(obj, key) {
  return obj.params && obj.params[key] ? obj.params[key].value : null;
}

// `development`/`complex` are usually null (confirmed live -- see
// JOKER_API_DISCOVERY.md); `params['building-name']` is the field that's
// actually populated on real new-build listings. First non-empty wins.
function complexNameOf(obj) {
  const raw =
    (typeof obj.development === 'string' && obj.development) ||
    (obj.development && obj.development.name) ||
    (typeof obj.complex === 'string' && obj.complex) ||
    (obj.complex && obj.complex.name) ||
    paramValue(obj, 'building-name') ||
    null;
  return raw;
}

function mapJokerObjectToStockRow(obj) {
  const propertyType = normalizePropertyType(obj.type);
  const district = normalizeDistrict(obj.district || obj.microdistrict || null);
  const complexRaw = complexNameOf(obj);
  const complex = normalizeComplex(complexRaw);
  const rooms = normalizeRooms(paramValue(obj, 'rooms'));
  const readiness = normalizeReadiness({
    builtYear: paramValue(obj, 'built-year'),
    readyQuarter: paramValue(obj, 'ready-quarter'),
  });
  const bedroomsRaw = paramValue(obj, 'BedroomsCount');
  const bedrooms = bedroomsRaw !== null && Number.isFinite(Number(bedroomsRaw)) ? Number(bedroomsRaw) : null;
  const floorRaw = paramValue(obj, 'floor');
  const floor = floorRaw !== null && Number.isFinite(Number(floorRaw)) ? Number(floorRaw) : null;
  const floorsTotalRaw = paramValue(obj, 'floors-total');
  const floorsTotal = floorsTotalRaw !== null && Number.isFinite(Number(floorsTotalRaw)) ? Number(floorsTotalRaw) : null;
  const price = obj.price !== null && obj.price !== undefined && Number.isFinite(Number(obj.price)) ? Number(obj.price) : null;

  return {
    jokerObjectId: obj.id,
    jokerUrl: obj.url || null,

    dealType: obj.deal_type || null,

    propertyTypeRaw: obj.type || null,
    propertyType: propertyType.code,
    propertyTypeExcluded: propertyType.excluded,

    city: obj.city || null,
    districtRaw: obj.district || obj.microdistrict || null,
    district: district.display,
    complexRaw,
    complex: complex.display,

    roomsRaw: paramValue(obj, 'rooms'),
    rooms: rooms.rooms,
    roomsSentinel: rooms.sentinel,
    bedrooms,

    areaSqm: parseAreaSqm(paramValue(obj, 'area')),
    floor,
    floorsTotal,

    price,

    readinessYear: readiness.readinessYear,
    readinessQuarter: readiness.readinessQuarter,

    agentId: (obj.agent && obj.agent.id) || null,
    agentName: (obj.agent && obj.agent.name) || null,
    agentPhone: (obj.agent && obj.agent.phone) || null,
    agentEmail: (obj.agent && obj.agent.email) || null,

    rawPayload: obj,
  };
}

module.exports = { mapJokerObjectToStockRow };
