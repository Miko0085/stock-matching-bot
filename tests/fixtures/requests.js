'use strict';

function makeParsedRequest(overrides = {}) {
  return {
    buying_intent: true,
    seeking_info: false,
    promotion: false,
    spam: false,
    transaction_type: 'SALE',
    area: 'Business Bay',
    building: 'Peninsula Four',
    bedrooms: 2,
    property_type: 'Apartment',
    budget_min: null,
    budget_max: 2500000,
    furnishing: 'Furnished',
    cash_buyer: true,
    confidence: 0.94,
    ...overrides,
  };
}

module.exports = { makeParsedRequest };
