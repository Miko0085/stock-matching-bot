'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stockTable, stockEditForm, STOCK_STATUS_OPTIONS, jokerStockTable, jokerStockEditForm } = require('../../dashboard/stock-view');

function makeRow(overrides = {}) {
  return {
    stock_id: 'STK-1',
    status: 'ACTIVE',
    area: 'Business Bay',
    building: 'Peninsula Four',
    bedrooms: 2,
    property_type: 'Apartment',
    size_sqft: 1200,
    view: 'Sea View',
    selling_price: 2500000,
    broker: 'John',
    broker_contact: '+971500000000',
    match_count: 3,
    strong_match_count: 0,
    latest_match: null,
    ...overrides,
  };
}

test('stockTable: renders an empty state when there are no rows', () => {
  assert.match(stockTable([], { market: 'uae' }), /Объектов пока нет/);
});

test('stockTable: each row has a status <select class="source-control"> posting to the right per-row status URL', () => {
  const html = stockTable([makeRow()], { market: 'uae' });
  assert.match(html, /<form class="inline source-control" method="post" action="\/stock\/STK-1\/status\?market=uae">/);
  assert.match(html, /<select name="status">/);
});

test('stockTable: the row\'s current status is selected in the dropdown', () => {
  const html = stockTable([makeRow({ status: 'NEEDS_REVIEW' })], { market: 'uae' });
  assert.match(html, /<option value="NEEDS_REVIEW" selected>NEEDS_REVIEW<\/option>/);
});

test('stockTable: an unusual/legacy status not in STOCK_STATUS_OPTIONS is still a selectable, selected option -- never silently misrepresented', () => {
  assert.ok(!STOCK_STATUS_OPTIONS.includes('SOLD'));
  const html = stockTable([makeRow({ status: 'SOLD' })], { market: 'uae' });
  assert.match(html, /<option value="SOLD" selected>SOLD<\/option>/);
  // The fixed options are still all present alongside it, just not selected.
  for (const s of STOCK_STATUS_OPTIONS) {
    assert.match(html, new RegExp(`<option value="${s}" >${s}</option>`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('stockTable: the pencil-icon edit link points at the correct /stock/:id/edit?market=... URL', () => {
  const html = stockTable([makeRow()], { market: 'abu_dhabi' });
  assert.match(html, /<a href="\/stock\/STK-1\/edit\?market=abu_dhabi" title="Редактировать объект">&#9998;<\/a>/);
});

test('stockTable: size_sqft and view are both rendered as columns (2026-10-08 fix -- they were on stock_inventory all along but never shown)', () => {
  const html = stockTable([makeRow({ size_sqft: 814, view: 'Full Park View' })], { market: 'uae' });
  assert.match(html, /<th>Площадь, sqft<\/th>/);
  assert.match(html, /<th>Вид<\/th>/);
  assert.match(html, /<td>814<\/td>/);
  assert.match(html, /<td>Full Park View<\/td>/);
});

test('stockTable: a null size_sqft/view renders as an empty cell, never the literal string "null"', () => {
  const html = stockTable([makeRow({ size_sqft: null, view: null })], { market: 'uae' });
  assert.ok(!html.includes('>null<'));
});

test('stockTable: stock_id values are URL/HTML-escaped in links (defense against an odd stock_id)', () => {
  const html = stockTable([makeRow({ stock_id: 'STK "1"' })], { market: 'uae' });
  assert.match(html, /\/stock\/STK%20%221%22\/status\?market=uae/);
  assert.match(html, /STK &quot;1&quot;/);
});

test('stockEditForm: renders one labeled input per editable field, pre-filled from the row', () => {
  const html = stockEditForm(makeRow({ transaction_type: 'SALE' }), { market: 'uae' });
  assert.match(html, /<input type="text" name="area" value="Business Bay">/);
  assert.match(html, /<input type="number" name="bedrooms" value="2">/);
  assert.match(html, /<input type="number" step="any" name="selling_price" value="2500000">/);
  assert.match(html, /<input type="text" name="transaction_type" value="SALE">/);
});

test('stockEditForm: a null field renders as an empty input, never the literal string "null"', () => {
  const html = stockEditForm(makeRow({ building: null }), { market: 'uae' });
  assert.match(html, /<input type="text" name="building" value="">/);
  assert.ok(!html.includes('value="null"'));
});

test('stockEditForm: stock_id is shown but is never a form field (primary key, never editable)', () => {
  const html = stockEditForm(makeRow(), { market: 'uae' });
  assert.match(html, /STK-1/);
  assert.ok(!html.includes('name="stock_id"'));
});

test('stockEditForm: submits to the correct per-stock edit URL for the given market', () => {
  const html = stockEditForm(makeRow(), { market: 'abu_dhabi' });
  assert.match(html, /<form method="post" action="\/stock\/STK-1\/edit\?market=abu_dhabi" class="edit-form">/);
});

test('stockEditForm: shows a success banner when saved=true', () => {
  const html = stockEditForm(makeRow(), { market: 'uae', saved: true });
  assert.match(html, /banner-ok/);
  assert.match(html, /Сохранено/);
});

test('stockEditForm: shows an error banner with the given message, never a generic one', () => {
  const html = stockEditForm(makeRow(), { market: 'uae', error: 'Статус не может быть пустым.' });
  assert.match(html, /banner-warning/);
  assert.match(html, /Статус не может быть пустым\./);
});

// ---- Joker-fed markets (Moscow/Oman/Saudi/Turkey) --------------------
// 2026-10-07, "all regions" request: a different shape (joker_object_id
// identity, no text `status` column -- include_in_matching is the nearest
// equivalent, see dashboard/joker-stock-admin-queries.js).

function makeJokerRow(overrides = {}) {
  return {
    joker_object_id: 555,
    joker_url: 'https://moscow.nikaestate.ru/objects/555',
    include_in_matching: true,
    agent_name: 'Иван Иванов',
    agent_phone: '+79990001122',
    property_type_raw: 'Квартира',
    city: 'Москва',
    district: 'Пресненский',
    complex: 'ЖК Пример',
    rooms: 2,
    rooms_sentinel: null,
    bedrooms: 1,
    area_sqm: 54.5,
    floor: 10,
    floors_total: 25,
    price: 25000000,
    readiness_year: 2027,
    readiness_quarter: 2,
    synced_at: null,
    ...overrides,
  };
}

test('jokerStockTable: renders an empty state when there are no rows', () => {
  assert.match(jokerStockTable([], { market: 'moscow' }), /Объектов пока нет/);
});

test('jokerStockTable: the first column links to the external joker_url, not an internal /stock/:id page (no match-history page exists for these markets)', () => {
  const html = jokerStockTable([makeJokerRow()], { market: 'moscow' });
  assert.match(html, /<a href="https:\/\/moscow\.nikaestate\.ru\/objects\/555">555<\/a>/);
});

test('jokerStockTable: the status-equivalent control is an include_in_matching select, keyed by joker_object_id, posting to the shared /stock/:id/status route -- same "Активен"/"Неактивен" wording as Dubai/Abu Dhabi\'s status dropdown (2026-10-07, consistency request)', () => {
  const html = jokerStockTable([makeJokerRow({ joker_object_id: 777, include_in_matching: true })], { market: 'oman' });
  assert.match(html, /<form class="inline source-control" method="post" action="\/stock\/777\/status\?market=oman">/);
  assert.match(html, /<option value="true" selected>Активен<\/option>/);
  assert.match(html, /<option value="false" >Неактивен<\/option>/);
});

test('jokerStockTable: include_in_matching=false selects the "Неактивен" option instead', () => {
  const html = jokerStockTable([makeJokerRow({ include_in_matching: false })], { market: 'moscow' });
  assert.match(html, /<option value="false" selected>Неактивен<\/option>/);
  assert.match(html, /<option value="true" >Активен<\/option>/);
});

test('jokerStockTable: the status column header is labeled "Статус", matching Dubai/Abu Dhabi\'s table, not a Joker-specific "В сопоставлении" label', () => {
  const html = jokerStockTable([makeJokerRow()], { market: 'moscow' });
  assert.match(html, /<th[^>]*>Статус<\/th>/);
});

test('jokerStockTable: the pencil-icon edit link uses joker_object_id, not stock_id', () => {
  const html = jokerStockTable([makeJokerRow({ joker_object_id: 321 })], { market: 'turkey' });
  assert.match(html, /<a href="\/stock\/321\/edit\?market=turkey" title="Редактировать объект">&#9998;<\/a>/);
});

test('jokerStockEditForm: renders Joker-shape fields (district/complex/agent_*), never Dubai field names like area/building/broker', () => {
  const html = jokerStockEditForm(makeJokerRow(), { market: 'moscow' });
  assert.match(html, /name="district"/);
  assert.match(html, /name="complex"/);
  assert.match(html, /name="agent_name"/);
  assert.ok(!html.includes('name="area"'));
  assert.ok(!html.includes('name="broker"'));
  assert.ok(!html.includes('name="stock_id"'), 'joker_object_id is the identity here, never a stock_id field');
});

test('jokerStockEditForm: warns that most fields are overwritten by the next Joker sync', () => {
  const html = jokerStockEditForm(makeJokerRow(), { market: 'moscow' });
  assert.match(html, /следующей синхронизации/);
});

test('jokerStockEditForm: submits to the correct per-object edit URL, keyed by joker_object_id', () => {
  const html = jokerStockEditForm(makeJokerRow({ joker_object_id: 999 }), { market: 'saudi' });
  assert.match(html, /<form method="post" action="\/stock\/999\/edit\?market=saudi" class="edit-form">/);
});
