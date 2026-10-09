'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { priceFieldForStock } = require('../../src/matching/transaction-semantics');

test('priceFieldForStock: SALE reads selling_price', () => {
  assert.equal(priceFieldForStock('SALE'), 'selling_price');
});

test('priceFieldForStock: RENT_YEARLY reads annual_rent', () => {
  assert.equal(priceFieldForStock('RENT_YEARLY'), 'annual_rent');
});

test('priceFieldForStock: an unrecognized/missing stock transaction_type falls back to selling_price, never throws', () => {
  assert.equal(priceFieldForStock(null), 'selling_price');
  assert.equal(priceFieldForStock(undefined), 'selling_price');
  assert.equal(priceFieldForStock('SOMETHING_UNKNOWN'), 'selling_price');
});
