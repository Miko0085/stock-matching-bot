'use strict';

// Single source of truth for how a request's `transaction_type` (SALE |
// RENT | null -- see parser/schema.js's TRANSACTION_TYPES) maps onto the
// real stock vocabulary and which stock price field is authoritative for
// that transaction.
//
// Stock only ever has two real transaction_type values -- confirmed live:
// `SELECT DISTINCT transaction_type FROM matching_abu_dhabi.stock_inventory` ->
// SALE (162 rows), RENT_YEARLY (28 rows), nothing else. Rentals price
// through `annual_rent`; `selling_price` is NULL on every RENT_YEARLY row
// and vice versa. This module does not invent support for any stock
// vocabulary beyond what is actually observed.
//
// hard-filters.js (JS defense-in-depth, source of truth) and
// candidate-query.js (SQL optimization layer) both call this -- they must
// never diverge on what counts as a compatible transaction or which price
// field to compare, or one layer could silently block what the other
// admits (or vice versa).

const STOCK_TRANSACTION_TYPES_BY_REQUEST = {
  SALE: ['SALE'],
  RENT: ['RENT_YEARLY'],
};

const PRICE_FIELD_BY_REQUEST = {
  SALE: 'selling_price',
  RENT: 'annual_rent',
};

const DEFAULT_PRICE_FIELD = 'selling_price';

// Returns the stock `transaction_type` values compatible with a request's
// stated transaction_type, or `null` if the request's value is not one we
// know how to map (should not happen given schema.js's enum, but a helper
// used by two call sites must not silently coerce an unrecognized value
// into a false match).
function compatibleStockTransactionTypes(requestTransactionType) {
  return STOCK_TRANSACTION_TYPES_BY_REQUEST[requestTransactionType] || null;
}

// Which stock column holds the comparable price for this request. Falls
// back to `selling_price` when the request didn't state a transaction_type
// at all -- matches the field this code compared against before RENT
// support existed, so an unspecified-transaction request's budget filter
// behavior is unchanged by this fix (still deliberately conservative: it
// will treat RENT_YEARLY stock, which has no selling_price, as
// unverifiable, exactly as it always has).
function priceFieldForRequest(requestTransactionType) {
  return PRICE_FIELD_BY_REQUEST[requestTransactionType] || DEFAULT_PRICE_FIELD;
}

const PRICE_FIELD_BY_STOCK_TYPE = {
  SALE: 'selling_price',
  RENT_YEARLY: 'annual_rent',
};

// Which stock column holds THIS ROW's own price, based on the row's own
// transaction_type -- independent of what the request asked for. Needed
// because a request with no resolved transaction_type deliberately lets
// both SALE and RENT_YEARLY stock through as candidates (see
// hard-filters.js's comment on why that's intentional, not a bug), so a
// single result set can contain both kinds of row; priceFieldForRequest()
// above only knows the REQUEST's type and would wrongly read
// selling_price (NULL) for a RENT_YEARLY row in that mixed case. Used by
// the notification renderer so a rental match is never shown with a
// blank price just because the request's type was unresolved.
function priceFieldForStock(stockTransactionType) {
  return PRICE_FIELD_BY_STOCK_TYPE[stockTransactionType] || DEFAULT_PRICE_FIELD;
}

module.exports = {
  STOCK_TRANSACTION_TYPES_BY_REQUEST,
  PRICE_FIELD_BY_REQUEST,
  PRICE_FIELD_BY_STOCK_TYPE,
  compatibleStockTransactionTypes,
  priceFieldForRequest,
  priceFieldForStock,
};
