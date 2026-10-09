'use strict';

function makeStock(overrides = {}) {
  return {
    stock_id: 'STK-0001',
    status: 'ACTIVE',
    transaction_type: 'SALE',
    city: 'Dubai',
    area: 'Business Bay',
    project_community: 'Business Bay',
    building: 'Peninsula Four',
    bedrooms: 2,
    bedrooms_label: '2 BR',
    bathrooms: 2,
    property_type: 'Apartment',
    selling_price: 2500000,
    annual_rent: null,
    size_sqft: 1200,
    plot_size_sqft: null,
    furnishing: 'Furnished',
    view: 'Canal',
    broker: 'Nika Estate',
    broker_contact: '+971500000000',
    notes: null,
    source_updated_at: new Date().toISOString(),
    synced_at: new Date().toISOString(),
    ...overrides,
  };
}

// Five distinct ACTIVE/SALE stock items that all satisfy the same request
// (Business Bay, 2BR, Apartment, budget 2.5M, Furnished) so the critical
// "every successful match is delivered" regression test has real fan-out.
const fiveMatchingStock = [
  makeStock({ stock_id: 'STK-1001', selling_price: 2400000 }),
  makeStock({ stock_id: 'STK-1002', selling_price: 2450000 }),
  makeStock({ stock_id: 'STK-1003', selling_price: 2500000 }),
  makeStock({ stock_id: 'STK-1004', selling_price: 2380000 }),
  makeStock({ stock_id: 'STK-1005', selling_price: 2420000 }),
];

module.exports = { makeStock, fiveMatchingStock };
