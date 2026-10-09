'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapJokerObjectToStockRow } = require('../../src/joker/joker-stock-mapper');

// Shape confirmed live (docs/JOKER_API_DISCOVERY.md + this session's audit)
// against real object 26334 (Грибкова Юлия), sanitized: no real PII beyond
// what's already an operational contact shown elsewhere in this dashboard.
function realObjectFixture(overrides = {}) {
  return {
    id: 26334,
    url: 'https://moscow.nikaestate.ru/catalog/sale/vtorichka/object/26334',
    type: 'Квартиры - вторичное жильё',
    deal_type: 'sale',
    region: 'Москва',
    city: 'Москва',
    district: 'Басманный',
    microdistrict: null,
    price: '156000000',
    development: null,
    complex: null,
    agent: { id: 245, name: 'Грибкова Юлия', phone: '+79654128553', email: 'j.gribkova@nikaestate.ru', position: null },
    params: {
      rooms: { name: 'Количество комнат', value: '4' },
      BedroomsCount: { name: 'Количество спален', value: '3' },
      area: { name: 'Общая площадь', value: '155.6 м²' },
      floor: { name: 'Этаж', value: '3' },
      'floors-total': { name: 'Этажей в доме', value: '11' },
    },
    ...overrides,
  };
}

test('mapJokerObjectToStockRow: maps a real residential object end to end', () => {
  const row = mapJokerObjectToStockRow(realObjectFixture());
  assert.equal(row.jokerObjectId, 26334);
  assert.equal(row.jokerUrl, 'https://moscow.nikaestate.ru/catalog/sale/vtorichka/object/26334');
  assert.equal(row.dealType, 'sale');
  assert.equal(row.propertyType, 'VTORICHKA');
  assert.equal(row.propertyTypeExcluded, false);
  assert.equal(row.city, 'Москва');
  assert.equal(row.district, 'Басманный');
  assert.equal(row.rooms, 4);
  assert.equal(row.roomsSentinel, null);
  assert.equal(row.bedrooms, 3);
  assert.equal(row.areaSqm, 155.6);
  assert.equal(row.floor, 3);
  assert.equal(row.floorsTotal, 11);
  assert.equal(row.price, 156000000);
  assert.equal(row.agentId, 245);
  assert.equal(row.agentName, 'Грибкова Юлия');
  assert.equal(row.agentPhone, '+79654128553');
  assert.equal(row.agentEmail, 'j.gribkova@nikaestate.ru');
  assert.deepEqual(row.rawPayload, realObjectFixture());
});

test('mapJokerObjectToStockRow: ЖК/complex name falls back to params["building-name"] when development/complex are null (the common real case)', () => {
  const obj = realObjectFixture({
    development: null,
    complex: null,
    params: { ...realObjectFixture().params, 'building-name': { name: 'Название комплекса', value: 'ЖК «Событие»' } },
  });
  const row = mapJokerObjectToStockRow(obj);
  assert.equal(row.complex, 'Событие');
  assert.equal(row.complexRaw, 'ЖК «Событие»');
});

test('mapJokerObjectToStockRow: commercial property type is marked excluded, code stays null', () => {
  const row = mapJokerObjectToStockRow(realObjectFixture({ type: 'Коммерческая недвижимость' }));
  assert.equal(row.propertyType, null);
  assert.equal(row.propertyTypeExcluded, true);
  assert.equal(row.propertyTypeRaw, 'Коммерческая недвижимость');
});

test('mapJokerObjectToStockRow: a garage listing with the broken "М{2}" area unit and no rooms/floor params still maps without throwing', () => {
  const garage = {
    id: 26730,
    url: 'https://moscow.nikaestate.ru/catalog/sale/garage/object/26730',
    type: 'Гараж',
    deal_type: 'sale',
    region: 'Москва',
    city: 'Москва',
    district: null,
    microdistrict: null,
    price: '6000000',
    development: null,
    complex: null,
    agent: { id: 245, name: 'Грибкова Юлия', phone: '+79654128553', email: 'j.gribkova@nikaestate.ru' },
    params: { area: { name: 'Площадь', value: '28 М{2}' } },
  };
  const row = mapJokerObjectToStockRow(garage);
  assert.equal(row.propertyType, 'GARAGE');
  assert.equal(row.areaSqm, 28);
  assert.equal(row.rooms, null);
  assert.equal(row.floor, null);
});

test('mapJokerObjectToStockRow: a studio (rooms="Студия") sets the STUDIO sentinel, not a numeric room count', () => {
  const obj = realObjectFixture({ params: { ...realObjectFixture().params, rooms: { value: 'Студия' } } });
  const row = mapJokerObjectToStockRow(obj);
  assert.equal(row.rooms, null);
  assert.equal(row.roomsSentinel, 'STUDIO');
});

test('mapJokerObjectToStockRow: readiness splits built-year and ready-quarter correctly, never confusing one for the other', () => {
  const obj = realObjectFixture({
    params: { ...realObjectFixture().params, 'ready-quarter': { value: '1' } },
  });
  const row = mapJokerObjectToStockRow(obj);
  assert.equal(row.readinessQuarter, 1);
  assert.equal(row.readinessYear, null);
});

test('mapJokerObjectToStockRow: an object missing every params field (e.g. a land plot) never throws', () => {
  const land = {
    id: 27046,
    url: 'https://moscow.nikaestate.ru/catalog/sale/zemelnye_uchastki/object/27046',
    type: 'Земельные участки',
    deal_type: 'sale',
    region: 'Москва',
    city: 'Химки',
    district: null,
    microdistrict: null,
    price: '300000000',
    development: null,
    complex: null,
    agent: { id: 245, name: 'Грибкова Юлия', phone: null, email: null },
    params: {},
  };
  const row = mapJokerObjectToStockRow(land);
  assert.equal(row.propertyType, 'LAND');
  assert.equal(row.rooms, null);
  assert.equal(row.areaSqm, null);
  assert.equal(row.floor, null);
  assert.equal(row.floorsTotal, null);
});
