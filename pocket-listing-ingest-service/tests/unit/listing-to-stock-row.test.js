'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapListingToStockFields } = require('../../src/normalize/listing-to-stock-row');

function aiValue(overrides = {}) {
  return {
    is_listing: true,
    city: 'Dubai',
    area: 'Business Bay',
    building: 'Ohana - Jacob & Co',
    property_type: 'Apartment',
    bedrooms: 3,
    bathrooms: 3,
    selling_price: null,
    annual_rent: null,
    size_sqft: 2153,
    plot_size_sqft: null,
    furnishing: null,
    view: null,
    distress: false,
    confidence: 0.9,
    ...overrides,
  };
}

test('mapListingToStockFields: status is always NEEDS_REVIEW -- no human has looked at this row yet', () => {
  const row = mapListingToStockFields(aiValue({ selling_price: 7750000 }));
  assert.equal(row.status, 'NEEDS_REVIEW');
});

test('mapListingToStockFields: stock_source identifies this as the live WhatsApp pipeline, distinct from the one-time .xlsx import tag', () => {
  const row = mapListingToStockFields(aiValue());
  assert.equal(row.stock_source, 'POCKET_LISTING_WHATSAPP_LIVE');
});

test('mapListingToStockFields: a selling_price with no annual_rent is transaction_type SALE', () => {
  const row = mapListingToStockFields(aiValue({ selling_price: 7750000, annual_rent: null }));
  assert.equal(row.transaction_type, 'SALE');
  assert.equal(row.selling_price, 7750000);
});

test('mapListingToStockFields: an annual_rent with no selling_price is transaction_type RENT_YEARLY', () => {
  const row = mapListingToStockFields(aiValue({ selling_price: null, annual_rent: 120000 }));
  assert.equal(row.transaction_type, 'RENT_YEARLY');
  assert.equal(row.annual_rent, 120000);
});

test('mapListingToStockFields: neither price stated defaults to SALE (AGENTS.md section 4\'s own pilot default)', () => {
  const row = mapListingToStockFields(aiValue({ selling_price: null, annual_rent: null }));
  assert.equal(row.transaction_type, 'SALE');
});

test('mapListingToStockFields: both prices stated -- SALE is primary, the rent figure is preserved in notes rather than silently discarded', () => {
  const row = mapListingToStockFields(aiValue({ selling_price: 7750000, annual_rent: 350000 }));
  assert.equal(row.transaction_type, 'SALE');
  assert.equal(row.selling_price, 7750000);
  assert.match(row.notes, /350000/);
  assert.match(row.notes, /rent/i);
});

test('mapListingToStockFields: distress=true is tagged at the start of notes', () => {
  const row = mapListingToStockFields(aiValue({ distress: true }));
  assert.match(row.notes, /^DISTRESS\./);
});

test('mapListingToStockFields: distress=false and no rent-alongside-sale note leaves notes null, never an empty string', () => {
  const row = mapListingToStockFields(aiValue({ distress: false, selling_price: 7750000, annual_rent: null }));
  assert.equal(row.notes, null);
});

test('mapListingToStockFields: a currency-formatted numeric string from the AI is coerced the same way the sync pipeline does', () => {
  const row = mapListingToStockFields(aiValue({ selling_price: '7,750,000 AED' }));
  assert.equal(row.selling_price, 7750000);
});

test('mapListingToStockFields: passes through area/building/property_type/bedrooms/size_sqft/furnishing/view unchanged', () => {
  const row = mapListingToStockFields(aiValue({ furnishing: 'Furnished', view: 'Full Sea View' }));
  assert.equal(row.area, 'Business Bay');
  assert.equal(row.building, 'Ohana - Jacob & Co');
  assert.equal(row.property_type, 'Apartment');
  assert.equal(row.bedrooms, 3);
  assert.equal(row.size_sqft, 2153);
  assert.equal(row.furnishing, 'Furnished');
  assert.equal(row.view, 'Full Sea View');
});

// 2026-10-08 audit finding: PKT-WA-261008-02's broker/broker_contact were
// both null -- the AI is never asked for a broker name, so this must come
// from the WhatsApp message's own sender (the poster), same convention
// the one-time .xlsx import's historical rows already use.
test('mapListingToStockFields: broker is the message sender\'s WhatsApp display name', () => {
  const row = mapListingToStockFields(aiValue(), { senderName: 'Александр Виноградов', senderId: '65842268078304@lid', senderIdAlt: null });
  assert.equal(row.broker, 'Александр Виноградов');
});

test('mapListingToStockFields: broker_contact resolves via sender_id_alt when sender_id is a LID', () => {
  const row = mapListingToStockFields(aiValue(), { senderName: 'A', senderId: '65842268078304@lid', senderIdAlt: '971501234567@s.whatsapp.net' });
  assert.equal(row.broker_contact, 'https://wa.me/971501234567');
});

test('mapListingToStockFields: an unresolved LID sender yields broker_contact null, never a placeholder -- broker (name) is still set', () => {
  const row = mapListingToStockFields(aiValue(), { senderName: 'Александр Виноградов', senderId: '65842268078304@lid', senderIdAlt: null });
  assert.equal(row.broker, 'Александр Виноградов');
  assert.equal(row.broker_contact, null);
});

test('mapListingToStockFields: no sender info at all leaves broker/broker_contact both null, never throws', () => {
  const row = mapListingToStockFields(aiValue());
  assert.equal(row.broker, null);
  assert.equal(row.broker_contact, null);
});
