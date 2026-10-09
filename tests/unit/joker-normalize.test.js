'use strict';

// Pure normalization functions for Joker stock (src/joker/joker-normalize.js).
// Every case here is grounded in a real value observed live during the
// 2026-09-28 audit (docs/PER_MARKET_SERVICE_INDEPENDENCE_PLAN.md section
// 5.1.2), not a hypothetical.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeComplex,
  normalizeDistrict,
  normalizeRooms,
  parseAreaSqm,
  normalizeReadiness,
  normalizePropertyType,
} = require('../../src/joker/joker-normalize');

test('normalizeComplex: strips ЖК/МФК/Комплекс апартаментов prefixes, guillemets, and whitespace', () => {
  assert.deepEqual(normalizeComplex('ЖК «Событие»'), { key: 'событие', display: 'Событие' });
  assert.deepEqual(normalizeComplex('МФК «Neva Towers»'), { key: 'neva towers', display: 'Neva Towers' });
  assert.deepEqual(normalizeComplex('Комплекс апартаментов «Поклонная 9»'), { key: 'поклонная 9', display: 'Поклонная 9' });
});

test('normalizeComplex: strips a leading zero-width space (real byte confirmed in a live export)', () => {
  const withZeroWidth = '​Элитный комплекс «Резиденция Тверская»';
  assert.deepEqual(normalizeComplex(withZeroWidth), { key: 'резиденция тверская', display: 'Резиденция Тверская' });
});

test('normalizeComplex: strips trailing whitespace before the CSV comma (confirmed on "ЖК «WILL TOWERS» ")', () => {
  assert.deepEqual(normalizeComplex('ЖК «WILL TOWERS» '), { key: 'will towers', display: 'WILL TOWERS' });
});

test('normalizeComplex: a complex with no generic prefix (e.g. "ЖК Victory Park Residences" already stripped by caller) still normalizes', () => {
  assert.deepEqual(normalizeComplex('ЖК Victory Park Residences'), { key: 'victory park residences', display: 'Victory Park Residences' });
});

test('normalizeComplex: null/empty input never throws, returns null key/display', () => {
  assert.deepEqual(normalizeComplex(null), { key: null, display: null });
  assert.deepEqual(normalizeComplex(''), { key: null, display: null });
});

test('normalizeDistrict: strips the "р-н" suffix so district and a buyer\'s "район" phrasing can share one alias key', () => {
  assert.deepEqual(normalizeDistrict('Одинцовский р-н'), { key: 'одинцовский', display: 'Одинцовский' });
  assert.deepEqual(normalizeDistrict('Наро-Фоминский р-н'), { key: 'наро-фоминский', display: 'Наро-Фоминский' });
});

test('normalizeDistrict: a plain Moscow district with no "р-н" suffix passes through unchanged', () => {
  assert.deepEqual(normalizeDistrict('Хамовники'), { key: 'хамовники', display: 'Хамовники' });
});

test('normalizeRooms: real non-numeric sentinels "Студия" and "Свободная планировка" get explicit flags, never silently become 0', () => {
  assert.deepEqual(normalizeRooms('Студия'), { rooms: null, sentinel: 'STUDIO' });
  assert.deepEqual(normalizeRooms('Свободная планировка'), { rooms: null, sentinel: 'FREE_PLAN' });
});

test('normalizeRooms: a numeric string parses to a number with no sentinel', () => {
  assert.deepEqual(normalizeRooms('4'), { rooms: 4, sentinel: null });
});

test('normalizeRooms: empty/null never throws', () => {
  assert.deepEqual(normalizeRooms(null), { rooms: null, sentinel: null });
  assert.deepEqual(normalizeRooms(''), { rooms: null, sentinel: null });
});

test('parseAreaSqm: parses "108 м²" and "950 м²"', () => {
  assert.equal(parseAreaSqm('108 м²'), 108);
  assert.equal(parseAreaSqm('950 м²'), 950);
});

test('parseAreaSqm: tolerates the real broken garage-listing unit literal "28 М{2}"', () => {
  assert.equal(parseAreaSqm('28 М{2}'), 28);
});

test('parseAreaSqm: parses a decimal area', () => {
  assert.equal(parseAreaSqm('120.4 м²'), 120.4);
});

test('parseAreaSqm: null/unparseable never throws', () => {
  assert.equal(parseAreaSqm(null), null);
  assert.equal(parseAreaSqm('нет данных'), null);
});

test('normalizeReadiness: a bare ready-quarter digit ("1"-"4") is never misread as a year', () => {
  assert.deepEqual(normalizeReadiness({ builtYear: null, readyQuarter: '1' }), { readinessYear: null, readinessQuarter: 1 });
  assert.deepEqual(normalizeReadiness({ builtYear: null, readyQuarter: '4' }), { readinessYear: null, readinessQuarter: 4 });
});

test('normalizeReadiness: a built-year with a "г." suffix parses to a plain 4-digit year', () => {
  assert.deepEqual(normalizeReadiness({ builtYear: '1915 г.', readyQuarter: null }), { readinessYear: 1915, readinessQuarter: null });
});

test('normalizeReadiness: a bare 4-digit built-year parses directly', () => {
  assert.deepEqual(normalizeReadiness({ builtYear: '2008', readyQuarter: null }), { readinessYear: 2008, readinessQuarter: null });
});

test('normalizeReadiness: an out-of-range quarter (e.g. "5") is rejected, not silently accepted', () => {
  assert.deepEqual(normalizeReadiness({ builtYear: null, readyQuarter: '5' }), { readinessYear: null, readinessQuarter: null });
});

test('normalizeReadiness: both absent never throws', () => {
  assert.deepEqual(normalizeReadiness({}), { readinessYear: null, readinessQuarter: null });
  assert.deepEqual(normalizeReadiness(), { readinessYear: null, readinessQuarter: null });
});

test('normalizePropertyType: commercial is excluded from buyer-facing matching', () => {
  assert.deepEqual(normalizePropertyType('Коммерческая недвижимость'), { code: null, excluded: true });
});

test('normalizePropertyType: the 5 real residential/land/garage categories each get a canonical code', () => {
  assert.equal(normalizePropertyType('Квартиры - вторичное жильё').code, 'VTORICHKA');
  assert.equal(normalizePropertyType('Квартиры в новостройках').code, 'NOVOSTROYKA');
  assert.equal(normalizePropertyType('Дома, дачи, коттеджи').code, 'HOUSE');
  assert.equal(normalizePropertyType('Земельные участки').code, 'LAND');
  assert.equal(normalizePropertyType('Гараж').code, 'GARAGE');
});

test('normalizePropertyType: an unrecognized/null type never throws', () => {
  assert.deepEqual(normalizePropertyType(null), { code: null, excluded: false });
  assert.deepEqual(normalizePropertyType('Совершенно новая категория'), { code: null, excluded: false });
});
